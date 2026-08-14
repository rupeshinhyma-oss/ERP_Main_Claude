"""add created_at and (is_active, created_at) indexes to buyers/suppliers

Revision ID: a1b2c3d4e5f7
Revises: b2c3d4e5f6b9
Create Date: 2026-08-13 00:00:00.000000

Phase 3 performance audit: ``buyers``/``suppliers`` are two of the
highest-traffic modules in the ERP (large lists, heavy filter sets -- see
PHASE3_PERFORMANCE.md), but unlike Product Master (which already indexes
every one of its filterable/sortable columns), neither table had an
index on ``created_at`` at all, despite it being:

  - the default/most common sort column (``sortable_fields`` on both
    repositories includes ``created_at``),
  - the column the "date range" list filter range-scans
    (``created_from``/``created_to`` -> ``created_at >= / <=``).

Also adds a composite ``(is_active, created_at)`` index on both tables,
covering what's very likely the single most common real query shape for
an ERP list default view: "active records, newest first" -- a query
that filters on ``is_active`` AND sorts by ``created_at`` benefits more
from one composite index matching that exact access pattern than from
two separate single-column indexes (see the Phase 3 audit's index
section for why single-column indexes were NOT added on every
low-cardinality filter column like ``buyer_type``/``current_status``/
``potential``/``buyer_grade``: with only a handful of distinct values
each, an index rarely beats a sequential scan for them in isolation, and
they are always combined with other filters in this UI anyway).

Written defensively (checks column/index existence before creating,
mirroring migration v6w7x8y9z0a1's own defensive style) since this
project's migration history has already hit at least one
"already exists" error in practice (see the DuplicateTable error on
b2c3d4e5f6b9's ``buyer_types`` table) -- this migration should never be
able to reproduce that failure mode even if run against a database
where one of these indexes was somehow already created by hand.
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a1b2c3d4e5f7'
down_revision = 'b2c3d4e5f6b9'
branch_labels = None
depends_on = None


# (table_name, index_name, column_names)
INDEXES = [
    ("buyers", "ix_buyers_created_at", ["created_at"]),
    ("buyers", "ix_buyers_is_active_created_at", ["is_active", "created_at"]),
    ("suppliers", "ix_suppliers_created_at", ["created_at"]),
    ("suppliers", "ix_suppliers_is_active_created_at", ["is_active", "created_at"]),
]


def upgrade() -> None:
    """Create each index only if its table exists and the index isn't already present."""
    bind = op.get_bind()
    insp = sa.inspect(bind)

    for table_name, index_name, columns in INDEXES:
        if not insp.has_table(table_name):
            continue
        existing_index_names = {ix["name"] for ix in insp.get_indexes(table_name)}
        if index_name in existing_index_names:
            continue
        op.create_index(index_name, table_name, columns)


def downgrade() -> None:
    """Drop each index only if it actually exists."""
    bind = op.get_bind()
    insp = sa.inspect(bind)

    for table_name, index_name, _columns in INDEXES:
        if not insp.has_table(table_name):
            continue
        existing_index_names = {ix["name"] for ix in insp.get_indexes(table_name)}
        if index_name not in existing_index_names:
            continue
        op.drop_index(index_name, table_name=table_name)
