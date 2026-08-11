"""add column level description

Revision ID: z0a1b2c3d4e6
Revises: z0a1b2c3d4e5
Create Date: 2026-08-11 00:00:00.000000

Adds PlanningColumn.enable_description (boolean, default False) and
PlanningCell.description (Text, nullable True) to support free-text notes
on any cell whose column has enabled descriptions.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'z0a1b2c3d4e6'
down_revision = 'z0a1b2c3d4e5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    col_cols = [c['name'] for c in inspector.get_columns('planning_columns')]
    if 'enable_description' not in col_cols:
        op.add_column(
            'planning_columns',
            sa.Column('enable_description', sa.Boolean(), nullable=False, server_default=sa.text('false')),
        )
        op.alter_column('planning_columns', 'enable_description', server_default=None)

    cell_cols = [c['name'] for c in inspector.get_columns('planning_cells')]
    if 'description' not in cell_cols:
        op.add_column(
            'planning_cells',
            sa.Column('description', sa.Text(), nullable=True),
        )


def downgrade() -> None:
    op.drop_column('planning_cells', 'description')
    op.drop_column('planning_columns', 'enable_description')
