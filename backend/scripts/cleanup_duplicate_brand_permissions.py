"""
One-time data migration: merge brand.read and masters.brand.* duplicates into canonical brand.* permissions.

- Merges 'brand.read' and 'masters.brand.view' into 'brand.view'
- Merges 'masters.brand.create' into 'brand.create'
- Cleans up duplicate permission rows from the database

Usage:
    python -m scripts.cleanup_duplicate_brand_permissions           # apply
    python -m scripts.cleanup_duplicate_brand_permissions --dry-run # preview only
"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import select

from app.core.logging import configure_logging, get_logger
from app.database.engine import dispose_engine, get_sessionmaker
from app.rbac.models import Permission, RolePermission, UserPermission
from app.rbac.repository import PermissionRepository
from app.users.repository import UserRepository  # noqa: F401

logger = get_logger(__name__)

# Map old/duplicate code -> target canonical code
MERGE_MAP = {
    "brand.read": "brand.view",
    "masters.brand.view": "brand.view",
    "masters.brand.create": "brand.create",
}


async def cleanup(*, dry_run: bool = False) -> None:
    """Run the cleanup. Pass dry_run=True to preview without modifying anything."""
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        permission_repo = PermissionRepository(session)

        for old_code, target_code in MERGE_MAP.items():
            old_perm = await permission_repo.get_by_code(old_code)
            if old_perm is None:
                print(f"  '{old_code}' not present, skipping.")
                continue

            target_perm = await permission_repo.get_by_code(target_code)
            if target_perm is None:
                print(f"  ERROR: target permission '{target_code}' not found in database.")
                continue

            print(f"\nProcessing '{old_code}' -> '{target_code}':")

            # 1. Migrate RolePermissions
            role_perm_stmt = select(RolePermission).where(RolePermission.permission_id == old_perm.id)
            role_perms = (await session.execute(role_perm_stmt)).scalars().all()
            print(f"  found {len(role_perms)} role grant(s) for '{old_code}'")

            for rp in role_perms:
                existing_stmt = select(RolePermission).where(
                    RolePermission.role_id == rp.role_id,
                    RolePermission.permission_id == target_perm.id,
                )
                existing = (await session.execute(existing_stmt)).scalar_one_or_none()
                if existing is None and not dry_run:
                    session.add(RolePermission(role_id=rp.role_id, permission_id=target_perm.id))
                    print(f"    granted '{target_code}' to role_id={rp.role_id}")

            # 2. Migrate UserPermissions
            user_perm_stmt = select(UserPermission).where(UserPermission.permission_id == old_perm.id)
            user_perms = (await session.execute(user_perm_stmt)).scalars().all()
            print(f"  found {len(user_perms)} user override(s) for '{old_code}'")

            for up in user_perms:
                existing_user_stmt = select(UserPermission).where(
                    UserPermission.user_id == up.user_id,
                    UserPermission.permission_id == target_perm.id,
                )
                existing_user = (await session.execute(existing_user_stmt)).scalar_one_or_none()
                if existing_user is None and not dry_run:
                    session.add(
                        UserPermission(
                            user_id=up.user_id,
                            permission_id=target_perm.id,
                            is_granted=up.is_granted,
                            is_denied=up.is_denied,
                        )
                    )
                    print(f"    migrated override to '{target_code}' for user_id={up.user_id}")

            if not dry_run:
                # 3. Delete old permission (cascades to link tables)
                await permission_repo.delete(old_perm)
                print(f"  deleted '{old_code}' permission row")

        if dry_run:
            print("\n--dry-run: preview complete. Re-run without --dry-run to apply.")
            await dispose_engine()
            return

        await session.commit()

    await dispose_engine()
    print("\nCleanup complete. Cleaned up duplicate brand permissions successfully.")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview what would be deleted without writing anything.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    asyncio.run(cleanup(dry_run=args.dry_run))
