"""add mum_group_label to planning_sheets

Revision ID: b2c3d4e5f6a7
Revises: z0a1b2c3d4e5
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
app.planning.service._get_mum_group_label() instead of a hardcoded
literal, so the "Duplicate sheet" feature can create a new sheet with a
different group label (e.g. "Chen" for a Chennai branch) while every
Mum-group-aware backend behavior keeps working unchanged.

NOTE ON REVISION ID: an earlier attempt at this migration mistakenly
reused revision id ``a1b2c3d4e5f6``, which collided with the pre-existing
``a1b2c3d4e5f6_phase4_queue_jobs`` migration (revises ``4c3819d53ab8``,
much earlier in the chain) -- two different migrations sharing one
revision id, plus a duplicate follow-up attempt at
``a1b2c3d4e5f7_add_mum_group_label...`` that created a second, unmerged
head off ``z0a1b2c3d4e5``. Both of those files must be deleted (there
should be exactly ONE ``add_mum_group_label`` migration, this one) before
running ``alembic upgrade head`` -- see the chat message this shipped
with for the cleanup steps. This migration uses a fresh, non-colliding
revision id (``b2c3d4e5f6a7``) and is the only migration that should add
this column.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'b2c3d4e5f6a7'
down_revision = 'z0a1b2c3d4e5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'planning_sheets',
        sa.Column('mum_group_label', sa.String(length=50), nullable=False, server_default='Mum'),
    )
    # Drop the server_default after backfilling existing rows -- new rows
    # get their default from the ORM model (Mapped[str] = ... default="Mum"),
    # matching this migration's own default value.
    op.alter_column('planning_sheets', 'mum_group_label', server_default=None)


def downgrade() -> None:
    op.drop_column('planning_sheets', 'mum_group_label')
