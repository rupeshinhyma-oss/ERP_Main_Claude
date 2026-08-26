"""resort existing planning rows by product sub-category

Revision ID: r9s0t1u2v3w4
Revises: f6a7b8c9d0e1
Create Date: 2026-08-25 00:00:00.000000

One-time data migration: for every existing Shipment Planning sheet,
re-numbers ``planning_rows.position`` so that rows whose ITEM is linked
to a real Product Master record (``linked_record_id`` pointing at
``products.id``) are grouped together by that product's Sub Category
(alphabetically by sub-category name, products with no sub-category
last), matching the ordering ``PlanningRepository._all_product_ids_for_organization``
already applies going forward for NEWLY created rows (see
``app/planning/repository.py``). Before this migration, that fix only
affected the order new rows get created in -- it never touched rows
that already existed on a sheet, since a live grid's row order/numbering
is otherwise never silently changed by the application itself.

Rows with no ``linked_record_id`` (a manually-typed ITEM, not linked to
a Product Master record) are left completely untouched, at their
original position -- there's no sub-category to sort them by, and
this migration only reorders rows it has clear, unambiguous grouping
information for. Any row whose ``linked_record_id`` doesn't resolve to
a live product (e.g. the product was later deleted) is treated the same
way: left untouched, not moved.

Ordering within this migration exactly mirrors
``PlanningRepository._all_product_ids_for_organization``'s query:
sub-category name ASC (NULLS LAST), then the product's created_at, then
the product's id, as tiebreakers -- so a sheet's rows end up in the same
relative order they'd have been created in had every row been added
after that fix landed.

This migration touches DATA, not schema -- there is no corresponding
``downgrade()`` restoration of original positions (the original order
is not recorded anywhere to restore from). ``downgrade()`` is a no-op;
reversing this would require a database backup taken before this
migration ran.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'r9s0t1u2v3w4'
down_revision = 'f6a7b8c9d0e1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # Every row on every sheet (linked or not), with its CURRENT position
    # and, if linked to a product, that product's sub-category name /
    # created_at / id for sorting. We need every row -- not just linked
    # ones -- because renumbering must stay contiguous and collision-free
    # across the WHOLE sheet: touching only the linked rows' positions
    # while leaving manual rows at their old position values would
    # create duplicate/skipped position numbers on any sheet that mixes
    # the two.
    rows = conn.execute(
        sa.text(
            """
            SELECT
                pr.sheet_id AS sheet_id,
                pr.id AS row_id,
                pr.position AS old_position,
                pr.linked_record_id AS linked_record_id,
                sc.name AS sub_category_name,
                p.created_at AS product_created_at,
                p.id AS product_id
            FROM planning_rows pr
            LEFT JOIN products p ON p.id = pr.linked_record_id AND p.deleted_at IS NULL
            LEFT JOIN product_sub_categories sc ON sc.id = p.sub_category_id
            WHERE pr.deleted_at IS NULL
            """
        )
    ).fetchall()

    # Group by sheet -- a sub-category ordering only makes sense WITHIN
    # one sheet's own rows, not across different sheets.
    rows_by_sheet: dict = {}
    for row in rows:
        rows_by_sheet.setdefault(row.sheet_id, []).append(row)

    update_stmt = sa.text("UPDATE planning_rows SET position = :position WHERE id = :row_id")

    for sheet_id, sheet_rows in rows_by_sheet.items():
        # Rows actually linked to a still-existing product get sorted by
        # sub-category (name ASC, NULLS LAST), then the product's own
        # created_at/id as tiebreakers -- exactly mirroring
        # PlanningRepository._all_product_ids_for_organization's ordering.
        linked_rows = [r for r in sheet_rows if r.linked_record_id is not None and r.product_id is not None]
        linked_rows.sort(
            key=lambda r: (
                r.sub_category_name is None,
                r.sub_category_name or "",
                r.product_created_at,
                str(r.product_id),
            )
        )

        # Any row NOT linked to a still-existing product (manually-typed
        # ITEM, or a linked product that's since been deleted) is left
        # completely alone -- keep it at its OWN original relative
        # position among unlinked rows, i.e. don't reorder unlinked rows
        # against each other either, only decide where the (now sorted)
        # linked block of rows slots in around them.
        unlinked_rows = sorted(
            (r for r in sheet_rows if r.linked_record_id is None or r.product_id is None),
            key=lambda r: r.old_position,
        )

        # Rebuild this sheet's full row order: walk every ORIGINAL
        # position slot in order; wherever that slot held a linked row,
        # take the next row off the (already sub-category-sorted) linked
        # queue instead of the row that used to be there -- so linked
        # rows get reshuffled into sub-category order, while every
        # unlinked row stays exactly where it was relative to its
        # neighbors. This keeps the result contiguous (0..N-1, one entry
        # per existing row) with no duplicate or skipped position values.
        unlinked_by_old_position = {r.old_position: r for r in unlinked_rows}
        linked_queue = list(linked_rows)
        final_order = []
        for r in sorted(sheet_rows, key=lambda r: r.old_position):
            if r.old_position in unlinked_by_old_position and unlinked_by_old_position[r.old_position] is r:
                final_order.append(r)
            else:
                final_order.append(linked_queue.pop(0))
        # Any linked rows not yet placed (shouldn't happen, since
        # linked_rows and unlinked_rows together account for every row
        # in sheet_rows -- this is just a defensive fallback) go last.
        final_order.extend(linked_queue)

        for new_position, row in enumerate(final_order):
            if row.old_position != new_position:
                conn.execute(update_stmt, {"position": new_position, "row_id": row.row_id})


def downgrade() -> None:
    """
    No-op: the original row order isn't recorded anywhere to restore.

    Reversing this migration would require a database backup taken
    before it ran.
    """
    pass
