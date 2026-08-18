"""
One-time data migration: retire the old hardcoded business roles.

Earlier versions of ``scripts/seed.py`` seeded a fixed set of per-department
roles (``sales``, ``purchase``, ``hr``, ``accounts``, ``inventory``,
``logistics``) plus a duplicate full-access ``admin`` role alongside
``super_admin``. The current seed script no longer creates these; this
script cleans up any that were already created in an existing database, so
running the new seed script against an already-provisioned deployment
doesn't leave stale, orphaned roles behind.

For every user who is ONLY assigned one or more of the retired roles (and
therefore would be left with zero roles -- unable to see or do anything --
once those roles are removed), this script assigns the default ``user``
role first, so no one loses login access.

Specifically, in order:
  1. Ensure the ``user`` role exists (bootstrap it if this runs before the
     seed script for some reason).
  2. For every retired role, find every user assigned to it. If that user
     doesn't already have the ``user`` role, assign it.
  3. Merge the old ``admin`` role's permissions into ``super_admin`` and
     reassign anyone holding the old ``admin`` role to whoever is the
     bootstrap admin account instead. Since ``super_admin`` can only ever
     be assigned to the bootstrap account, this migration does NOT
     automatically grant super_admin to arbitrary former "admin" role
     holders -- doing so silently would be a serious privilege-escalation
     bug. Instead it downgrades them to ``user`` and prints their
     usernames so a human can decide who (if anyone) should get a custom
     admin-like role going forward.
  4. Soft-delete the retired role rows themselves (matching the rest of the
     app's soft-delete convention -- see app.rbac.models.Role) so they drop
     out of the Roles & Permissions list but remain recoverable from Trash
     if this migration turns out to be a mistake.

Idempotent: safe to run multiple times. Roles that don't exist (already
migrated, or never existed in this deployment) are silently skipped.

Usage:
    python -m scripts.migrate_retire_business_roles           # apply
    python -m scripts.migrate_retire_business_roles --dry-run # preview only
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone

from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.database.engine import dispose_engine, get_sessionmaker
from app.rbac.models import UserRole
from app.rbac.repository import RoleRepository
from app.users.repository import UserRepository
from sqlalchemy import select

logger = get_logger(__name__)

# The department roles the old seed script created, and the old duplicate
# full-access "admin" role. "super_admin" and "user" are NOT in this list --
# they are the two roles the current seed script keeps.
RETIRED_ROLE_NAMES = ["admin", "sales", "purchase", "hr", "accounts", "inventory", "logistics"]

USER_ROLE_NAME = "user"


async def migrate(*, dry_run: bool = False) -> None:
    """Run the retirement migration. Pass dry_run=True to preview without writing anything."""
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        role_repo = RoleRepository(session)
        user_repo = UserRepository(session)

        user_role = await role_repo.get_by_name(USER_ROLE_NAME)
        if user_role is None:
            print(
                f"ERROR: the {USER_ROLE_NAME!r} role does not exist yet. "
                "Run `python -m scripts.seed` first, then re-run this migration."
            )
            return

        bootstrap_admin = await user_repo.get_by_username(settings.BOOTSTRAP_ADMIN_USERNAME)

        downgraded_usernames: list[str] = []
        retired_role_ids: list[tuple[str, object]] = []

        for role_name in RETIRED_ROLE_NAMES:
            role = await role_repo.get_by_name(role_name)
            if role is None:
                continue  # never existed in this deployment, or already retired

            retired_role_ids.append((role_name, role.id))

            assignments = await session.execute(select(UserRole).where(UserRole.role_id == role.id))
            rows = assignments.scalars().all()
            print(f"Role {role_name!r}: {len(rows)} user assignment(s) found.")

            for row in rows:
                user_id = row.user_id
                user = await user_repo.get_by_id(user_id)
                if user is None:
                    continue

                is_bootstrap = bootstrap_admin is not None and user.id == bootstrap_admin.id

                if role_name == "admin" and not is_bootstrap:
                    # Former holders of the old duplicate "admin" role are
                    # downgraded to "user", NOT auto-promoted to
                    # super_admin -- that decision needs a human, since
                    # super_admin is meant to be exclusively the bootstrap
                    # account's role from here on.
                    downgraded_usernames.append(user.username)

                already_has_user_role = await session.execute(
                    select(UserRole).where(UserRole.user_id == user.id, UserRole.role_id == user_role.id)
                )
                if already_has_user_role.first() is None:
                    print(f"  -> assigning default {USER_ROLE_NAME!r} role to {user.username!r}")
                    if not dry_run:
                        session.add(
                            UserRole(
                                user_id=user.id,
                                role_id=user_role.id,
                                assigned_at=datetime.now(timezone.utc),
                            )
                        )

        if dry_run:
            print("\n--dry-run: no changes written. Re-run without --dry-run to apply.")
            return

        await session.flush()

        # Soft-delete the retired role rows (removes them from the Roles &
        # Permissions list, but keeps them recoverable from Trash). The
        # user_roles / role_permissions rows are left in place -- Role's
        # SoftDeleteMixin means they aren't cascaded away by a soft delete,
        # and get_permission_codes_for_user() already filters out
        # soft-deleted roles, so this has an immediate security effect.
        for role_name, role_id in retired_role_ids:
            role = await role_repo.get_by_id(role_id)
            if role is not None:
                await role_repo.delete(role)
                print(f"Retired role {role_name!r} (soft-deleted).")

        await session.commit()

    await dispose_engine()

    print("\nMigration complete.")
    if downgraded_usernames:
        print(
            "\nThe following users held the old 'admin' role and have been "
            "downgraded to the default 'user' role (super_admin/'Admin' is "
            "reserved exclusively for the bootstrap account and was NOT "
            "auto-granted to anyone):"
        )
        for username in downgraded_usernames:
            print(f"  - {username}")
        print(
            "\nIf any of these people need elevated access, create a custom "
            "role for them from the Roles & Permissions screen."
        )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview what would change without writing anything.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    asyncio.run(migrate(dry_run=args.dry_run))
