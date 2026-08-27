"""add attachment_url and attachment_filename to quotations

Revision ID: s0t1u2v3w4x5
Revises: r9s0t1u2v3w4
Create Date: 2026-08-26 00:00:00.000000

Adds two nullable columns to ``quotations``, needed by the AI-powered
quotation extraction feature (manual "AI Parse" button, automated email
inbox worker, and inbound WhatsApp/WeChat webhook): when a supplier's
quote arrives as an attached PDF or image, the file is saved to
``uploads/quotations/`` and its URL + original filename are recorded
here so it can be reopened/downloaded from the Quotation record later.

NULL for both columns means "no attachment was provided with this
quote" -- true for every existing quotation and for any quote entered
manually without a file, so nothing needs backfilling.

Written to be safe to run even if one or both columns already exist on
``quotations`` (e.g. added directly against the database outside of
this migration, before it was tracked here) -- checks first via
``sa.inspect``, matching the existing pattern in
``fe76691d38c8_add_width_px_to_planning_columns.py``, rather than
assuming a clean slate.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 's0t1u2v3w4x5'
down_revision = 'r9s0t1u2v3w4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = [c["name"] for c in inspector.get_columns("quotations")]

    if "attachment_url" not in existing_cols:
        op.add_column('quotations', sa.Column('attachment_url', sa.String(length=500), nullable=True))
    if "attachment_filename" not in existing_cols:
        op.add_column('quotations', sa.Column('attachment_filename', sa.String(length=255), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = [c["name"] for c in inspector.get_columns("quotations")]

    if "attachment_filename" in existing_cols:
        op.drop_column('quotations', 'attachment_filename')
    if "attachment_url" in existing_cols:
        op.drop_column('quotations', 'attachment_url')