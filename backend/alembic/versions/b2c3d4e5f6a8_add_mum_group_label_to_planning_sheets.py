"""add mum_group_label to planning_sheets

Revision ID: b2c3d4e5f6a8
Revises: b2c3d4e5f6a7
Create Date: 2026-08-11 00:00:00.000000

Every sheet's Mum-series columns ("Mum 1", "Mum1 Remarks", "NO. OF PKG
MUM1", "TOTAL WEIGHT MUM1", "TOTAL CBM MUM1") were matched by the backend
against the literal word "Mum", hardcoded in several regexes across
app.planning.service. That made the word itself unrenameable: a sheet
whose admin wanted to call its groups "Chen 1" / "Chen2 Remarks" instead
of "Mum 1" / "Mum2 Remarks" would silently lose the fixed-formula /
approval-date / status-history behavior those regexes provide, since none
of them would match "Chen" anymore.

This adds ``planning_sheets.mum_group_label`` (default ``'Mum'``, so every
existing sheet keeps behaving exactly as before) -- the single word each
sheet uses for its own groups, read by
app.planning.service.mum_label_pattern() instead of a hardcoded literal,
so the "Duplicate sheet as template" feature can create a new sheet with a
different group label (e.g. "Chen" for a Chennai branch) while every
Mum-group-aware backend behavior keeps working unchanged.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'b2c3d4e5f6a8'
down_revision = 'c3d4e5f6a7b8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [c['name'] for c in inspector.get_columns('planning_sheets')]
    if 'mum_group_label' not in columns:
        op.add_column(
            'planning_sheets',
            sa.Column('mum_group_label', sa.String(length=50), nullable=False, server_default='Mum'),
        )
        op.alter_column('planning_sheets', 'mum_group_label', server_default=None)


def downgrade() -> None:
    op.drop_column('planning_sheets', 'mum_group_label')
