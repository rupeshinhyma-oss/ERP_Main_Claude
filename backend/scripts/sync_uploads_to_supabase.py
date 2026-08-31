"""
Script to sync all existing local uploads to Supabase Storage and update DB URLs.

Scans:
- uploads/products / backend/uploads/products -> Supabase bucket 'product-images'
- uploads/suppliers / backend/uploads/suppliers -> Supabase bucket 'supplier-media'
- uploads/quotations / backend/uploads/quotations -> Supabase bucket 'quotations'

Updates database tables:
- `products`: `image_url` and JSON `images` array
- `suppliers`: JSON `visit_media` and `media_urls`
- `quotations`: `attachment_url`

Run via:
    cd backend
    python scripts/sync_uploads_to_supabase.py
"""

import asyncio
import os
import sys
from pathlib import Path

# Add backend directory to sys.path
backend_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import select, update
from app.core.config import settings
from app.core.logging import get_logger
from app.database.engine import get_sessionmaker

logger = get_logger(__name__)
from app.common.storage import upload_to_supabase, guess_content_type
from app.masters.products.models import Product
from app.suppliers.models import Supplier
from app.inquiries.models import Quotation


async def sync_all_uploads():
    print("=" * 60)
    print("[*] Starting Supabase Storage Sync for Local Uploads")
    print(f"Supabase Base URL: {settings.supabase_base_url}")
    print(f"Auth Key Configured: {'Yes' if settings.supabase_auth_key else 'No'}")
    print("=" * 60)

    if not settings.supabase_auth_key:
        print("[!] Error: SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY is not set in .env")
        return

    # Map of local subfolders -> Supabase bucket
    targets = [
        ("products", "product-images"),
        ("suppliers", "supplier-media"),
        ("quotations", "quotations"),
    ]

    url_mappings: dict[str, str] = {}  # local_url_pattern -> public_supabase_url

    # 1. Scan and upload files
    for subfolder, bucket in targets:
        folder_candidates = [
            Path("uploads") / subfolder,
            backend_dir / "uploads" / subfolder,
        ]
        scanned_files: set[Path] = set()
        for fld in folder_candidates:
            if fld.exists():
                for item in fld.iterdir():
                    if item.is_file():
                        scanned_files.add(item)

        print(f"\n[+] Checking folder '{subfolder}' (Target bucket: '{bucket}')... Found {len(scanned_files)} files.")

        for file_path in scanned_files:
            filename = file_path.name
            try:
                content = file_path.read_bytes()
                mime = guess_content_type(filename)
                pub_url = await upload_to_supabase(
                    bucket=bucket,
                    filename=filename,
                    content=content,
                    content_type=mime,
                )
                if pub_url:
                    print(f"  [OK] Uploaded: {filename} -> {pub_url}")
                    # Map all possible local URL formats
                    url_mappings[f"/uploads/{subfolder}/{filename}"] = pub_url
                    url_mappings[f"/static/uploads/{subfolder}/{filename}"] = pub_url
                    url_mappings[filename] = pub_url
                else:
                    print(f"  [WARN] Failed to upload: {filename}")
            except Exception as e:
                print(f"  [ERR] Error uploading {filename}: {e}")

    # 2. Update database records with newly uploaded URLs
    if not url_mappings:
        print("\n[i] No local files found or uploaded.")
        return

    print("\n[*] Updating Database References with Supabase URLs...")
    sessionmaker = get_sessionmaker()

    async with sessionmaker() as session:
        # Update Quotations
        q_res = await session.execute(
            select(Quotation).where(Quotation.attachment_url.is_not(None))
        )
        quotations = q_res.scalars().all()
        q_updated = 0
        for q in quotations:
            att = q.attachment_url
            if att and att in url_mappings:
                q.attachment_url = url_mappings[att]
                q_updated += 1
            elif att and ("/uploads/quotations/" in att or "/static/uploads/quotations/" in att):
                fname = att.split("/")[-1]
                if fname in url_mappings:
                    q.attachment_url = url_mappings[fname]
                    q_updated += 1

        # Update Products
        p_res = await session.execute(select(Product))
        products = p_res.scalars().all()
        p_updated = 0
        for p in products:
            changed = False
            if p.image_url:
                if p.image_url in url_mappings:
                    p.image_url = url_mappings[p.image_url]
                    changed = True
                elif "/uploads/products/" in p.image_url:
                    fname = p.image_url.split("/")[-1]
                    if fname in url_mappings:
                        p.image_url = url_mappings[fname]
                        changed = True

            if p.images and isinstance(p.images, list):
                new_imgs = []
                for img in p.images:
                    if img in url_mappings:
                        new_imgs.append(url_mappings[img])
                        changed = True
                    elif "/uploads/products/" in str(img):
                        fname = str(img).split("/")[-1]
                        if fname in url_mappings:
                            new_imgs.append(url_mappings[fname])
                            changed = True
                        else:
                            new_imgs.append(img)
                    else:
                        new_imgs.append(img)
                if changed:
                    p.images = new_imgs

            if changed:
                p_updated += 1

        # Update Suppliers
        s_res = await session.execute(select(Supplier))
        suppliers = s_res.scalars().all()
        s_updated = 0
        for s in suppliers:
            changed = False
            if s.visit_media and isinstance(s.visit_media, list):
                new_media = []
                for item in s.visit_media:
                    if item in url_mappings:
                        new_media.append(url_mappings[item])
                        changed = True
                    elif "/uploads/suppliers/" in str(item):
                        fname = str(item).split("/")[-1]
                        if fname in url_mappings:
                            new_media.append(url_mappings[fname])
                            changed = True
                        else:
                            new_media.append(item)
                    else:
                        new_media.append(item)
                if changed:
                    s.visit_media = new_media

            if changed:
                s_updated += 1

        await session.commit()
        print(f"[OK] Updated {q_updated} Quotations, {p_updated} Products, and {s_updated} Suppliers in Database.")

    print("\n[+] Supabase Storage Sync Finished Successfully!")


if __name__ == "__main__":
    asyncio.run(sync_all_uploads())
