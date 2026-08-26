"""resort existing planning rows alphabetically by product sub-category and product name

Revision ID: t1u2v3w4x5y6
Revises: s0t1u2v3w4x5
Create Date: 2026-08-26 00:00:00.000000

Data migration: for every existing Shipment Planning sheet, re-numbers
``planning_rows.position`` so that rows whose ITEM is linked to a real
Product Master record (``linked_record_id`` pointing at ``products.id``)
are grouped together by that product's Sub Category (alphabetically by
sub-category name, products with no sub-category last) AND within each
sub-category group, sorted alphabetically by Product Name (Tally / standard)
and Product Code.

This mirrors the Product Master group-wise alphabetical ordering.

Rows with no ``linked_record_id`` (manually-typed ITEM rows) are kept at
their original relative positions without disruption.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 't1u2v3w4x5y6'
down_revision = 's0t1u2v3w4x5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # Every row on every sheet (linked or not), with its CURRENT position
    # and, if linked to a product, that product's sub-category name, product name,
    # product code, and id for sorting.
    rows = conn.execute(
        sa.text(
            """
            SELECT
                pr.sheet_id AS sheet_id,
                pr.id AS row_id,
                pr.position AS old_position,
                pr.linked_record_id AS linked_record_id,
                sc.name AS sub_category_name,
                COALESCE(p.product_name_tally, p.product_name, '') AS product_name,
                COALESCE(p.product_code, '') AS product_code,
                p.id AS product_id
            FROM planning_rows pr
            LEFT JOIN products p ON p.id = pr.linked_record_id AND p.deleted_at IS NULL
            LEFT JOIN product_sub_categories sc ON sc.id = p.sub_category_id
            WHERE pr.deleted_at IS NULL
            """
        )
    ).fetchall()

    rows_by_sheet: dict = {}
    for row in rows:
        rows_by_sheet.setdefault(row.sheet_id, []).append(row)

    update_stmt = sa.text("UPDATE planning_rows SET position = :position WHERE id = :row_id")

    for sheet_id, sheet_rows in rows_by_sheet.items():
        # Linked rows sorted by sub_category (alphabetical, NULLS LAST),
        # then product_name (alphabetical), then product_code, then product_id.
        linked_rows = [r for r in sheet_rows if r.linked_record_id is not None and r.product_id is not None]
        linked_rows.sort(
            key=lambda r: (
                r.sub_category_name is None,
                (r.sub_category_name or "").strip().lower(),
                (r.product_name or "").strip().lower(),
                (r.product_code or "").strip().lower(),
                str(r.product_id),
            )
        )

        unlinked_rows = sorted(
            (r for r in sheet_rows if r.linked_record_id is None or r.product_id is None),
            key=lambda r: r.old_position,
        )

        unlinked_by_old_position = {r.old_position: r for r in unlinked_rows}
        linked_queue = list(linked_rows)
        final_order = []
        for r in sorted(sheet_rows, key=lambda r: r.old_position):
            if r.old_position in unlinked_by_old_position and unlinked_by_old_position[r.old_position] is r:
                final_order.append(r)
            else:
                final_order.append(linked_queue.pop(0))
        final_order.extend(linked_queue)

        for new_position, row in enumerate(final_order):
            if row.old_position != new_position:
                conn.execute(update_stmt, {"position": new_position, "row_id": row.row_id})


def downgrade() -> None:
    """No-op."""
    pass
