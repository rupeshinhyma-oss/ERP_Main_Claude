"""add description feature columns to planning tables

Revision ID: x8y9z0a1b2c3
Revises: w7x8y9z0a1b2
Create Date: 2026-08-08 00:00:00.000000

Adds the columns the Description feature needs, which were referenced by
the frontend (Planning.tsx) but never actually existed in the database --
every save of "enable_description" or a cell/row description was silently
dropped by Pydantic (extra fields ignored) and never persisted, which is
why the checkbox always reverted to unchecked and typed descriptions
never showed up again after a refresh.

- ``planning_columns.enable_description`` / ``planning_sheets.enable_description``:
  per-column (and per-sheet, for the built-in ITEM column) opt-in toggle.
- ``planning_cells.description`` / ``planning_rows.description``: the
  actual free-text note storage, independent of the cell/row's value.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'x8y9z0a1b2c3'
down_revision = 'w7x8y9z0a1b2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'planning_columns',
        sa.Column('enable_description', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        'planning_sheets',
        sa.Column('item_enable_description', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column('planning_cells', sa.Column('description', sa.Text(), nullable=True))
    op.add_column('planning_rows', sa.Column('description', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('planning_rows', 'description')
    op.drop_column('planning_cells', 'description')
    op.drop_column('planning_sheets', 'item_enable_description')
    op.drop_column('planning_columns', 'enable_description')
