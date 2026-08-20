"""
One-time data migration: merge audit.read into audit.view and remove duplicate audit.read.

Usage:
    python -m scripts.cleanup_duplicate_audit_permissions           # apply
    python -m scripts.cleanup_duplicate_audit_permissions --dry-run # preview only
"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import delete, select

from app.core.logging import configure_logging, get_logger
from app.database.engine import dispose_engine, get_sessionmaker
from app.rbac.models import Permission, RolePermission, UserPermission
from app.rbac.repository import PermissionRepository
from app.users.repository import UserRepository  # noqa: F401

logger = get_logger(__name__)


async def cleanup(*, dry_run: bool = False) -> None:
    """Run the cleanup. Pass dry_run=True to preview without modifying anything."""
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        permission_repo = PermissionRepository(session)

        audit_read = await permission_repo.get_by_code("audit.read")
        audit_view = await permission_repo.get_by_code("audit.view")

        if audit_read is None:
            print("\nNothing to clean up -- 'audit.read' is not present in this database.")
            await dispose_engine()
            return

        if audit_view is None:
            print("  'audit.view' not found, creating it...")
            if not dry_run:
                audit_view = await permission_repo.create(
                    code="audit.view",
                    module="audit",
                    resource="audit",
                    action="view",
                    scope="ALL",
                    description="View audit log entries.",
                )
                await session.flush()

        print(f"  found 'audit.read' (id={audit_read.id})")
        if audit_view:
            print(f"  found 'audit.view' (id={audit_view.id})")

        # 1. Migrate RolePermissions from audit.read -> audit.view
        role_perm_stmt = select(RolePermission).where(RolePermission.permission_id == audit_read.id)
        role_perms = (await session.execute(role_perm_stmt)).scalars().all()
        print(f"  found {len(role_perms)} role grant(s) with 'audit.read'")

        for rp in role_perms:
            if audit_view:
                # Check if role already has audit.view
                existing_stmt = select(RolePermission).where(
                    RolePermission.role_id == rp.role_id,
                    RolePermission.permission_id == audit_view.id,
                )
                existing = (await session.execute(existing_stmt)).scalar_one_or_none()
                if existing is None and not dry_run:
                    session.add(RolePermission(role_id=rp.role_id, permission_id=audit_view.id))
                    print(f"    granted 'audit.view' to role_id={rp.role_id}")

        # 2. Migrate UserPermissions (overrides) from audit.read -> audit.view
        user_perm_stmt = select(UserPermission).where(UserPermission.permission_id == audit_read.id)
        user_perms = (await session.execute(user_perm_stmt)).scalars().all()
        print(f"  found {len(user_perms)} user permission override(s) with 'audit.read'")

        for up in user_perms:
            if audit_view:
                existing_user_stmt = select(UserPermission).where(
                    UserPermission.user_id == up.user_id,
                    UserPermission.permission_id == audit_view.id,
                )
                existing_user = (await session.execute(existing_user_stmt)).scalar_one_or_none()
                if existing_user is None and not dry_run:
                    session.add(
                        UserPermission(
                            user_id=up.user_id,
                            permission_id=audit_view.id,
                            is_granted=up.is_granted,
                            is_denied=up.is_denied,
                        )
                    )
                    print(f"    migrated override to 'audit.view' for user_id={up.user_id}")

        if dry_run:
            print("\n--dry-run: preview complete. Re-run without --dry-run to apply.")
            await dispose_engine()
            return

        # 3. Delete audit.read from permissions (cascades to role_permissions and user_permissions)
        await permission_repo.delete(audit_read)
        await session.commit()
        print("  deleted 'audit.read' permission row")

    await dispose_engine()
    print("\nCleanup complete. Merged 'audit.read' into 'audit.view' successfully.")


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
