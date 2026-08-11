"""add column-level (header) description to planning tables

Revision ID: z0a1b2c3d4e5
Revises: y9z0a1b2c3d4
Create Date: 2026-08-11 00:00:00.000000

The description feature originally only supported per-cell and per-row
notes (see x8y9z0a1b2c3). Per product decision, the pencil/description
button now lives on the column header only (one note for the whole
column, e.g. "what this Mum group covers"), not on every individual cell
-- this adds the storage for that single column-level note.

- ``planning_columns.description``: the header-level free-text note for
  an ordinary admin-defined column.
- ``planning_sheets.item_description``: the same, for the sheet's
  built-in ITEM column (which isn't a row in ``planning_columns``).

The existing per-cell/per-row ``description`` columns and
``enable_description`` toggles are left in place (harmless, unused by the
new header-only UI) rather than dropped, so any note a user already wrote
into a cell/row isn't silently deleted by this migration.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'z0a1b2c3d4e5'
down_revision = 'y9z0a1b2c3d4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('planning_columns', sa.Column('description', sa.Text(), nullable=True))
    op.add_column('planning_sheets', sa.Column('item_description', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('planning_sheets', 'item_description')
    op.drop_column('planning_columns', 'description')
