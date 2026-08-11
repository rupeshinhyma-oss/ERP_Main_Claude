"""
One-time backfill: default every EXISTING Shipment Planning sheet's ITEM
column to auto-pull Product Master's Product Name, and populate up to 50
rows for any such sheet that currently has none.

Context: manual per-row ITEM linking (the paperclip/🔗 icon) has been
removed from the UI entirely. New sheets now default their ITEM column to
Product Master -> Product Name automatically (see
PlanningService.create_sheet). This script applies that same default to
sheets that already existed before that change, so they don't end up
stuck with an empty, unconfigured ITEM column with no way to fix it from
the UI anymore.

SAFETY: only touches a sheet if BOTH of these hold:
  1. item_source_type is still MANUAL (the original, unconfigured default)
     -- a sheet an admin already explicitly configured differently
     (a different module, a formula, etc.) is left completely alone.
  2. It's a Planning Sheet with no rows OR its rows are auto-populated
     safely (existing rows are never deleted or overwritten -- the
     auto-populate step only ever ADDS new rows for products not already
     linked to a row on the sheet, exactly like the "+ Auto-populate"
     button does from the UI).

Run once, from the backend/ directory:
    python scripts/backfill_item_source_to_product_master.py
    python scripts/backfill_item_source_to_product_master.py --dry-run   # preview only, no writes
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

backend_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.audit.repository import AuditRepository  # noqa: E402
from app.audit.service import AuditService  # noqa: E402
from app.database.engine import dispose_engine, get_sessionmaker  # noqa: E402
from app.planning.models import PlanningColumnSourceType, PlanningSheet  # noqa: E402
from app.planning.repository import (  # noqa: E402
    PlanningCellRepository,
    PlanningChangeLogRepository,
    PlanningColumnRepository,
    PlanningColumnRoleLockRepository,
    PlanningRowRepository,
    PlanningSheetRepository,
    PlanningStatusTagRepository,
)
from app.planning.service import PlanningService  # noqa: E402
from app.rbac.repository import UserRoleRepository  # noqa: E402
from app.users.models import User  # noqa: E402

DEFAULT_LIMIT = 50


async def _get_system_user(db: AsyncSession) -> tuple[str, str] | None:
    """
    Pick a user to attribute this automated backfill's audit-log entries
    to. Uses the earliest-created active user (typically the original
    admin account) -- there's no dedicated "system" user in this schema,
    and every write PlanningService makes requires a real user_id/username
    for its change log.
    """
    result = await db.execute(
        select(User.id, User.username).where(User.deleted_at.is_(None)).order_by(User.created_at.asc()).limit(1)
    )
    row = result.first()
    return (str(row[0]), row[1]) if row else None


async def main(dry_run: bool) -> None:
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as db:
        system_user = await _get_system_user(db)
        if system_user is None:
            print("No users found in the database -- cannot attribute changes. Aborting.")
            return
        user_id, username = system_user
        print(f"Attributing changes to user: {username} ({user_id})")

        service = PlanningService(
            PlanningSheetRepository(db),
            PlanningRowRepository(db),
            PlanningColumnRepository(db),
            PlanningCellRepository(db),
            PlanningStatusTagRepository(db),
            PlanningChangeLogRepository(db),
            AuditService(AuditRepository(db)),
            PlanningColumnRoleLockRepository(db),
            user_role_repository=UserRoleRepository(db),
        )

        result = await db.execute(select(PlanningSheet).where(PlanningSheet.deleted_at.is_(None)))
        sheets = result.scalars().all()
        print(f"Found {len(sheets)} sheet(s) total.")

        touched = 0
        for sheet in sheets:
            if sheet.item_source_type != PlanningColumnSourceType.MANUAL:
                print(f"  SKIP '{sheet.name}' -- ITEM already configured as {sheet.item_source_type.value}.")
                continue

            existing_rows = await service.row_repository.list_for_sheet(sheet.id)
            print(
                f"  CONFIGURE '{sheet.name}' -- ITEM is Manual/unconfigured. "
                f"{len(existing_rows)} existing row(s)."
            )
            touched += 1
            if dry_run:
                continue

            await service.sheet_repository.update(
                sheet,
                item_source_type=PlanningColumnSourceType.LINKED_LOOKUP,
                item_source_module="product",
                item_source_field="product_name",
                item_auto_populate_enabled=True,
                item_auto_populate_limit=DEFAULT_LIMIT,
            )

            if len(existing_rows) == 0:
                created = await service.auto_populate_rows_from_item_source(
                    sheet.id, limit=DEFAULT_LIMIT, user_id=user_id, username=username
                )
                print(f"    -> populated {len(created)} row(s) from Product Master.")
            else:
                print(
                    "    -> left existing rows untouched (only newly-created sheets are "
                    "auto-populated; run '+ Auto-populate' from the UI if you also want "
                    "product rows added here)."
                )

        await db.commit()
        print(f"\n{'[DRY RUN] Would have' if dry_run else 'Done --'} reconfigured {touched} sheet(s).")

    await dispose_engine()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing anything.")
    args = parser.parse_args()
    asyncio.run(main(dry_run=args.dry_run))
