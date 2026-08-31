"""
Storage utility module for Supabase Storage with graceful local disk fallback.

Handles:
1. Direct file upload to Supabase Storage buckets (e.g. product-images, supplier-media, quotations).
2. Auto-creation of public buckets when using SUPABASE_SERVICE_KEY.
3. Automatic MIME-type inference and filename sanitization.
4. Transparent fallback to local filesystem (uploads/<subfolder>/) when Supabase credentials
   are absent or unreachable.
"""

from __future__ import annotations

import mimetypes
import os
import re
import uuid
from pathlib import Path
from typing import Tuple

import httpx

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Cache to avoid repeatedly hitting bucket check API
_VERIFIED_BUCKETS: set[str] = set()


def sanitize_filename(filename: str) -> str:
    """Sanitize filename to prevent directory traversal and remove unsupported characters."""
    base_name = os.path.basename(filename).strip()
    if not base_name:
        base_name = "file.bin"
    # Replace non-alphanumeric (except dot, dash, underscore) with underscore
    clean = re.sub(r"[^\w\-.]", "_", base_name)
    # Collapse multiple consecutive underscores
    clean = re.sub(r"_+", "_", clean)
    return clean[:120]


def guess_content_type(filename: str, default: str = "application/octet-stream") -> str:
    """Guess MIME type based on file extension."""
    mime, _ = mimetypes.guess_type(filename)
    if mime:
        return mime
    ext = filename.split(".")[-1].lower() if "." in filename else ""
    extension_map = {
        "pdf": "application/pdf",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "svg": "image/svg+xml",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mov": "video/quicktime",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls": "application/vnd.ms-excel",
        "csv": "text/csv",
    }
    return extension_map.get(ext, default)


async def ensure_bucket_exists(bucket: str) -> bool:
    """Ensure the specified public bucket exists in Supabase Storage."""
    if bucket in _VERIFIED_BUCKETS:
        return True

    auth_key = settings.supabase_auth_key
    if not auth_key:
        return False

    headers = {
        "apikey": auth_key,
        "Authorization": f"Bearer {auth_key}",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Check if bucket exists
            get_resp = await client.get(
                f"{bucket_url}/{bucket}",
                headers=headers,
            )
            if get_resp.status_code == 200:
                _VERIFIED_BUCKETS.add(bucket)
                return True

            # If not found or service key has permission, create the public bucket
            post_resp = await client.post(
                bucket_url,
                headers={
                    **headers,
                    "Content-Type": "application/json",
                },
                json={
                    "id": bucket,
                    "name": bucket,
                    "public": True,
                    "file_size_limit": 52428800,  # 50MB
                },
            )
            if post_resp.status_code in (200, 201, 409):
                _VERIFIED_BUCKETS.add(bucket)
                return True
            logger.warning(
                "Supabase bucket creation failed for %s: %s (HTTP %d)",
                bucket,
                post_resp.text[:300],
                post_resp.status_code,
            )
    except Exception as exc:
        logger.debug("Failed to verify/create Supabase bucket '%s': %s", bucket, exc)

    return False


async def upload_to_supabase(
    bucket: str,
    filename: str,
    content: bytes,
    content_type: str | None = None,
) -> str | None:
    """
    Upload a file directly to Supabase Storage.

    Returns the public URL on success, or None if upload failed or Supabase is not configured.
    """
    auth_key = settings.supabase_auth_key
    if not auth_key:
        return None

    if not content_type:
        content_type = guess_content_type(filename)

    headers = {
        "apikey": auth_key,
        "Authorization": f"Bearer {auth_key}",
        "Content-Type": content_type,
        "x-upsert": "true",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                upload_url,
                content=content,
                headers=headers,
            )

            # If bucket didn't exist, try creating it and retrying once
            if resp.status_code in (400, 404) and "not found" in resp.text.lower():
                created = await ensure_bucket_exists(bucket)
                if created:
                    resp = await client.post(
                        upload_url,
                        content=content,
                        headers=headers,
                    )

            if resp.status_code in (200, 201):
                public_url = f"{base_url}/storage/v1/object/public/{bucket}/{filename}"
                return public_url

            logger.warning(
                "Supabase storage rejected upload to %s/%s: HTTP %d: %s",
                bucket,
                filename,
                resp.status_code,
                resp.text[:300],
            )
    except Exception as exc:
        logger.warning(
            "Supabase Storage upload error for %s/%s: %s",
            bucket,
            filename,
            exc,
        )

    return None


async def save_uploaded_file(
    content: bytes,
    original_filename: str,
    bucket: str = "product-images",
    local_subfolder: str = "products",
    content_type: str | None = None,
) -> Tuple[str, str]:
    """
    Save an uploaded file, attempting Supabase Storage first, falling back to local disk.

    Returns:
        tuple[public_url, stored_filename]
    """
    clean_name = sanitize_filename(original_filename)
    unique_filename = f"{uuid.uuid4().hex}_{clean_name}"
    mime = content_type or guess_content_type(clean_name)

    # 1. Try Supabase Storage
    supabase_url = await upload_to_supabase(
        bucket=bucket,
        filename=unique_filename,
        content=content,
        content_type=mime,
    )
    if supabase_url:
        return supabase_url, unique_filename

    # 2. Fallback to local disk
    local_dir = Path("uploads") / local_subfolder
    local_dir.mkdir(parents=True, exist_ok=True)
    file_path = local_dir / unique_filename

    try:
        with open(file_path, "wb") as f:
            f.write(content)
        logger.info("Saved file locally to %s", str(file_path))
    except Exception as exc:
        logger.error("Failed to write file to local disk %s: %s", str(file_path), exc)
        raise

    # Return relative URL
    return f"/uploads/{local_subfolder}/{unique_filename}", unique_filename
