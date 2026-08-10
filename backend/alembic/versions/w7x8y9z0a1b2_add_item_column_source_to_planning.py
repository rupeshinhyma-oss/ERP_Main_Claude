"""add ITEM column data source config to planning sheets/rows

Revision ID: w7x8y9z0a1b2
Revises: v6w7x8y9z0a1
Create Date: 2026-08-10 00:00:00.000000

The dynamic-source feature (linked lookup / aggregate / formula) added in
``t4u5v6w7x8y9`` only reached ordinary admin-defined columns in
``planning_columns``. The sheet's built-in first column ("ITEM") is not a
row in that table -- it doubles as the row's own label -- so configuring
it via the "Configure Column" dialog silently did nothing: nothing was
ever persisted, and nothing ever used the selection to populate a row's
ITEM value from the chosen module/field.

This adds the same config, scoped to the sheet (one config for the whole
ITEM column, exactly like ``planning_columns.source_*``), plus a
per-row ``linked_record_id`` (mirrors ``planning_cells.linked_record_id``)
so each row can be linked to a specific record once the sheet's ITEM
column is set to linked-lookup.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'w7x8y9z0a1b2'
down_revision = 'v6w7x8y9z0a1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'planning_sheets',
        sa.Column('item_source_type', sa.String(20), nullable=False, server_default='manual'),
    )
    op.add_column('planning_sheets', sa.Column('item_source_module', sa.String(100), nullable=True))
    op.add_column('planning_sheets', sa.Column('item_source_field', sa.String(100), nullable=True))
    op.add_column('planning_sheets', sa.Column('item_formula_expression', sa.Text(), nullable=True))

    op.add_column(
        'planning_rows',
        sa.Column('linked_record_id', postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('planning_rows', 'linked_record_id')
    op.drop_column('planning_sheets', 'item_formula_expression')
    op.drop_column('planning_sheets', 'item_source_field')
    op.drop_column('planning_sheets', 'item_source_module')
    op.drop_column('planning_sheets', 'item_source_type')
