"""
One-time data migration: purge all retired permissions from the database:
- department.*
- designation.*
- employee.*
- inquiry.*
- inventory.*
- reports.*
- settings.*
- task.*
- crm.*

Usage:
    python -m scripts.purge_retired_permissions           # apply
    python -m scripts.purge_retired_permissions --dry-run # preview only
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

MODULES_TO_PURGE = [
    "department",
    "designation",
    "employee",
    "inquiry",
    "inventory",
    "reports",
    "settings",
    "task",
    "crm",
    "cache",
    "queue",
]


async def purge(*, dry_run: bool = False) -> None:
    """Run the purge. Pass dry_run=True to preview without modifying anything."""
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        permission_repo = PermissionRepository(session)

        stmt = select(Permission).where(Permission.module.in_(MODULES_TO_PURGE)).order_by(Permission.code)
        perms = (await session.execute(stmt)).scalars().all()

        print(f"Found {len(perms)} permission(s) to purge from modules: {MODULES_TO_PURGE}\n")

        for perm in perms:
            # Check RolePermissions
            role_perm_stmt = select(RolePermission).where(RolePermission.permission_id == perm.id)
            role_perms = (await session.execute(role_perm_stmt)).scalars().all()

            # Check UserPermissions
            user_perm_stmt = select(UserPermission).where(UserPermission.permission_id == perm.id)
            user_perms = (await session.execute(user_perm_stmt)).scalars().all()

            print(f"  Purging '{perm.code}': {len(role_perms)} role grant(s), {len(user_perms)} user override(s)")

            if not dry_run:
                await permission_repo.delete(perm)

        if dry_run:
            print("\n--dry-run: preview complete. Re-run without --dry-run to apply.")
            await dispose_engine()
            return

        await session.commit()

    await dispose_engine()
    print("\nPurge complete. All retired permissions removed from database.")


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
    asyncio.run(purge(dry_run=args.dry_run))
