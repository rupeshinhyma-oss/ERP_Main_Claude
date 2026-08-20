"""
One-time data migration: remove orphaned, duplicate Shipment Planning permissions.

The current ``scripts/seed.py`` seeds exactly nine ``planning.*`` permission
codes (``planning.read``, ``planning.sheet.manage``, ``planning.column.manage``,
``planning.row.manage``, ``planning.cell.edit``, ``planning.textyn.edit``,
``planning.approvaldate.edit``, ``planning.colorstatusred.edit``,
``planning.colorstatusgreen.edit``) -- and every one of those nine is checked
somewhere in real backend/frontend code (see ``app.planning.routes``,
``app.planning.service``, and ``frontend/src/pages/Planning.tsx``).

An existing database was found to also contain a second, overlapping set of
nine ``planning.*`` permission rows that do NOT appear anywhere in this
codebase -- not in ``seed.py``, not in any route guard, not in any frontend
``hasPermission`` check:

    planning.approval_date.edit
    planning.approval_date.view
    planning.status.blue
    planning.status.clear
    planning.status.custom
    planning.status.green
    planning.status.red
    planning.test_yn.edit
    planning.test_yn.view

These were not created by any script in this repository (grepping the whole
codebase for them returns zero matches), so they most likely came from a
manual database edit or an old/experimental seed variant that predates this
version of ``seed.py``. Because nothing in the running application ever
checks for these codes, granting or revoking them on a role has **zero
effect** on what a user can actually do -- they are pure clutter that makes
the Roles & Permissions screen confusing (see the SHIPMENT PLANNING group
showing 18 checkboxes instead of the real 9) without protecting anything.

This script deletes exactly those nine orphaned ``Permission`` rows and
nothing else. ``Permission`` has no soft-delete mixin (unlike ``Role``), and
these rows are inert dead weight rather than something anyone would want to
restore later, so this is a real, permanent delete -- but a narrowly scoped
one: only these nine exact codes, matched by exact string, are touched.
Every other permission in the system (including the real nine ``planning.*``
codes) is left completely untouched.

``role_permissions`` and ``user_permissions`` rows pointing at these nine
codes are cleaned up automatically: both tables declare
``ondelete="CASCADE"`` on their ``permission_id`` foreign key (see
``app.rbac.models.RolePermission`` / ``UserPermission``), so deleting the
``Permission`` row itself cascades at the database level -- no role or user
is left holding a dangling reference, and no separate cleanup step is
needed for those link tables.

Idempotent: safe to run multiple times. Any of the nine codes that don't
exist (already cleaned up, or never present in this deployment) are
silently skipped.

Usage:
    python -m scripts.cleanup_duplicate_planning_permissions           # apply
    python -m scripts.cleanup_duplicate_planning_permissions --dry-run # preview only
"""

from __future__ import annotations

import argparse
import asyncio

from app.core.logging import configure_logging, get_logger
from app.database.engine import dispose_engine, get_sessionmaker
from app.rbac.repository import PermissionRepository

# This import is never used directly in this script, but it MUST run before
# any query touches app.rbac.models: RolePermission/UserPermission/UserRole
# declare their relationships to "User" as a lazy, string-based forward
# reference, and SQLAlchemy only resolves that name against whatever classes
# have actually been imported into the process so far. Deleting a Permission
# row triggers SQLAlchemy to configure ALL its mappers (including the
# relationships on the tables that cascade off of it), so without this
# import present, the delete blows up with
# `sqlalchemy.exc.InvalidRequestError: ... failed to locate a name ('User')`
# the first time this script runs standalone (i.e. whenever nothing else in
# the same process happened to import app.users.models first). Every other
# one-off script in this folder that touches app.rbac models has the same
# import for the same reason -- see scripts/migrate_retire_business_roles.py.
from app.users.repository import UserRepository  # noqa: F401

logger = get_logger(__name__)

# The nine orphaned codes to remove. Deliberately an exact-match list (not a
# pattern like "planning.status.*") so this script can never accidentally
# catch a real, currently-used permission code, now or if the real
# permission set is renamed again in the future.
ORPHANED_PLANNING_PERMISSION_CODES = [
    "planning.approval_date.edit",
    "planning.approval_date.view",
    "planning.status.blue",
    "planning.status.clear",
    "planning.status.custom",
    "planning.status.green",
    "planning.status.red",
    "planning.test_yn.edit",
    "planning.test_yn.view",
]


async def cleanup(*, dry_run: bool = False) -> None:
    """Run the cleanup. Pass dry_run=True to preview without deleting anything."""
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        permission_repo = PermissionRepository(session)

        found: list[tuple[str, object]] = []
        for code in ORPHANED_PLANNING_PERMISSION_CODES:
            permission = await permission_repo.get_by_code(code)
            if permission is None:
                print(f"  (not present, skipping) {code}")
                continue
            found.append((code, permission))
            print(f"  found -> {code}  (id={permission.id})")

        if not found:
            print("\nNothing to clean up -- none of the orphaned codes are present in this database.")
            await dispose_engine()
            return

        if dry_run:
            print(
                f"\n--dry-run: would delete {len(found)} orphaned permission row(s) "
                "(and any role/user grants of them, via cascade). "
                "Re-run without --dry-run to apply."
            )
            await dispose_engine()
            return

        for code, permission in found:
            await permission_repo.delete(permission)
            print(f"  deleted -> {code}")

        await session.commit()

    await dispose_engine()
    print(f"\nCleanup complete. Removed {len(found)} orphaned planning permission row(s).")
    print(
        "The real, currently-used planning.* permissions (planning.read, "
        "planning.sheet.manage, planning.column.manage, planning.row.manage, "
        "planning.cell.edit, planning.textyn.edit, planning.approvaldate.edit, "
        "planning.colorstatusred.edit, planning.colorstatusgreen.edit) were "
        "not touched."
    )


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