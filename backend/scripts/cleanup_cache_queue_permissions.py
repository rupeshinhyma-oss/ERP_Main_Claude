"""
One-time data migration: remove cache.* and queue.* permissions from the database.

Cache and background queues work automatically for all users by default in the
backend -- no permission code gates any cache/queue route (see
app.cache.routes / app.queue.routes), by deliberate design, so these are
inert, orphaned permission rows with nothing checking for them anywhere in
the codebase.

Usage:
    python -m scripts.cleanup_cache_queue_permissions           # apply
    python -m scripts.cleanup_cache_queue_permissions --dry-run # preview only
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

CODES_TO_REMOVE = [
    "cache.view",
    "cache.manage",
    "queue.view",
    "queue.manage",
]


async def cleanup(*, dry_run: bool = False) -> None:
    """Run the cleanup. Pass dry_run=True to preview without modifying anything."""
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        permission_repo = PermissionRepository(session)

        for code in CODES_TO_REMOVE:
            perm = await permission_repo.get_by_code(code)
            if perm is None:
                print(f"  '{code}' not in database, skipping.")
                continue

            print(f"\nProcessing removal of '{code}':")

            # Check RolePermissions
            role_perm_stmt = select(RolePermission).where(RolePermission.permission_id == perm.id)
            role_perms = (await session.execute(role_perm_stmt)).scalars().all()
            print(f"  found {len(role_perms)} role grant(s)")

            # Check UserPermissions
            user_perm_stmt = select(UserPermission).where(UserPermission.permission_id == perm.id)
            user_perms = (await session.execute(user_perm_stmt)).scalars().all()
            print(f"  found {len(user_perms)} user override(s)")

            if not dry_run:
                await permission_repo.delete(perm)
                print(f"  deleted '{code}' permission and associated links")

        if dry_run:
            print("\n--dry-run: preview complete. Re-run without --dry-run to apply.")
            await dispose_engine()
            return

        await session.commit()

    await dispose_engine()
    print("\nCleanup complete. Cache and Queue permissions removed successfully.")


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