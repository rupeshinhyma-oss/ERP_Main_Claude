"""add auto-populate persistence and status-color opt-in to planning tables

Revision ID: y9z0a1b2c3d4
Revises: x8y9z0a1b2c3
Create Date: 2026-08-10 00:00:00.000000

Fixes the same "checkbox doesn't survive reopening the modal" bug that
Description had, this time for "Load all records automatically" and its
"How many records to load" selector -- neither was ever persisted, so the
checkbox always reverted to unchecked even though the column really was
auto-populated.

Also adds ``enable_status_color`` on ``planning_columns``: an explicit
opt-in gate (default False, including for every existing column) that a
column must have set before its cells can carry a CRM-style status color
at all -- previously any cell in any column could.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'y9z0a1b2c3d4'
down_revision = 'x8y9z0a1b2c3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'planning_columns',
        sa.Column('auto_populate_enabled', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column('planning_columns', sa.Column('auto_populate_limit', sa.Integer(), nullable=True))
    op.add_column(
        'planning_columns',
        sa.Column('enable_status_color', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        'planning_sheets',
        sa.Column('item_auto_populate_enabled', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column('planning_sheets', sa.Column('item_auto_populate_limit', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('planning_sheets', 'item_auto_populate_limit')
    op.drop_column('planning_sheets', 'item_auto_populate_enabled')
    op.drop_column('planning_columns', 'enable_status_color')
    op.drop_column('planning_columns', 'auto_populate_limit')
    op.drop_column('planning_columns', 'auto_populate_enabled')
