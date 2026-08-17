"""add width_px to planning_columns

Revision ID: fe76691d38c8
Revises: e7b8c9d0e1f2
Create Date: 2026-08-17 00:00:00.000000

Adds a server-persisted column width (in pixels) to planning_columns, so
resizing a column is shared across every user viewing that sheet -- unlike
Hide/Freeze, which are deliberately per-user local browser preferences
(see hiddenColumnsStorageKey/frozenColumnsStorageKey in Planning.tsx).

NULL means "not manually resized yet" -- the frontend auto-computes a
width from the column's header label length in that case (see
computeHeaderWidth in Planning.tsx) rather than falling back to some
fixed default here, so nothing needs backfilling for existing columns.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'fe76691d38c8'
down_revision = 'e7b8c9d0e1f2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = [c["name"] for c in inspector.get_columns("planning_columns")]
    if "width_px" not in existing_cols:
        op.add_column("planning_columns", sa.Column("width_px", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("planning_columns", "width_px")
