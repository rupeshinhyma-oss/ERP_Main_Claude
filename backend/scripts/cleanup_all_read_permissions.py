"""
One-time data migration: merge all .read and masters.* permissions into canonical .view / standard permissions.

- Standardizes all entity.read -> entity.view
- Standardizes masters.product.* -> product.*
- Migrates all role and user permission grants to the canonical permission
- Deletes old .read and masters.* permission rows from the database

Usage:
    python -m scripts.cleanup_all_read_permissions           # apply
    python -m scripts.cleanup_all_read_permissions --dry-run # preview only
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

# Explicit special mappings if any; otherwise entity.read -> entity.view
EXPLICIT_MAP = {
    "masters.product.view": "product.view",
    "masters.product.manage": "product.bulk_action",
    "masters.brand.view": "brand.view",
    "masters.brand.create": "brand.create",
}


async def cleanup(*, dry_run: bool = False) -> None:
    """Run the cleanup. Pass dry_run=True to preview without modifying anything."""
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        permission_repo = PermissionRepository(session)

        # Get all permissions in the database
        stmt = select(Permission).order_by(Permission.code)
        all_perms = (await session.execute(stmt)).scalars().all()

        for old_perm in all_perms:
            old_code = old_perm.code

            # Determine target code
            if old_code in EXPLICIT_MAP:
                target_code = EXPLICIT_MAP[old_code]
            elif old_code.endswith(".read"):
                target_code = old_code[:-5] + ".view"
            else:
                continue

            if target_code == old_code:
                continue

            print(f"\nProcessing '{old_code}' -> '{target_code}':")

            # Ensure target permission exists
            target_perm = await permission_repo.get_by_code(target_code)
            if target_perm is None:
                if not dry_run:
                    # Create target permission if missing
                    target_perm = Permission(
                        code=target_code,
                        module=old_perm.module,
                        page=old_perm.page,
                        action="view",
                        scope=old_perm.scope,
                        description=f"View {old_perm.module}.",
                    )
                    session.add(target_perm)
                    await session.flush()
                    print(f"  created target permission '{target_code}'")
                else:
                    print(f"  [dry-run] would create target permission '{target_code}'")

            # 1. Migrate RolePermissions
            role_perm_stmt = select(RolePermission).where(RolePermission.permission_id == old_perm.id)
            role_perms = (await session.execute(role_perm_stmt)).scalars().all()
            print(f"  found {len(role_perms)} role grant(s) for '{old_code}'")

            if target_perm is not None and not dry_run:
                for rp in role_perms:
                    existing_stmt = select(RolePermission).where(
                        RolePermission.role_id == rp.role_id,
                        RolePermission.permission_id == target_perm.id,
                    )
                    existing = (await session.execute(existing_stmt)).scalar_one_or_none()
                    if existing is None:
                        session.add(RolePermission(role_id=rp.role_id, permission_id=target_perm.id))
                        print(f"    granted '{target_code}' to role_id={rp.role_id}")

            # 2. Migrate UserPermissions
            user_perm_stmt = select(UserPermission).where(UserPermission.permission_id == old_perm.id)
            user_perms = (await session.execute(user_perm_stmt)).scalars().all()
            print(f"  found {len(user_perms)} user override(s) for '{old_code}'")

            if target_perm is not None and not dry_run:
                for up in user_perms:
                    existing_user_stmt = select(UserPermission).where(
                        UserPermission.user_id == up.user_id,
                        UserPermission.permission_id == target_perm.id,
                    )
                    existing_user = (await session.execute(existing_user_stmt)).scalar_one_or_none()
                    if existing_user is None:
                        session.add(
                            UserPermission(
                                user_id=up.user_id,
                                permission_id=target_perm.id,
                                is_granted=up.is_granted,
                                granted_by=up.granted_by,
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
    print("\nCleanup complete. All .read and masters.* permissions have been migrated and removed.")


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
