"""create inquiries module tables

Revision ID: s3t4u5v6w7x8
Revises: r2s3t4u5v6w7
Create Date: 2026-08-08 00:00:00.000000

Creates the Inquiry (Requirement) module: ``consignment_codes`` (the
admin-managed master for FB1/FB2/ING1/... codes, each tied to one buyer),
``inquiries`` (Layer 1: one row per consignment, with denormalized rollup
fields), and ``inquiry_items`` (Layer 2: one row per product line, with
UOM copied from the Product master, approval tracking, and Tally-Entry-
Posted tracking).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 's3t4u5v6w7x8'
down_revision = 'r2s3t4u5v6w7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'consignment_codes',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('code', sa.String(20), nullable=False),
        sa.Column('label', sa.String(150), nullable=True),
        sa.Column('buyer_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('buyers.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('status', sa.String(20), nullable=False, server_default='active'),
        sa.UniqueConstraint('code', name='uq_consignment_codes_code'),
    )
    op.create_index('ix_consignment_codes_code', 'consignment_codes', ['code'])
    op.create_index('ix_consignment_codes_buyer_id', 'consignment_codes', ['buyer_id'])
    op.create_index('ix_consignment_codes_status', 'consignment_codes', ['status'])

    op.create_table(
        'inquiries',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('buyer_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('buyers.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('consignment_code_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('consignment_codes.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('consignment_status', sa.String(20), nullable=False, server_default='proposed'),
        sa.Column('total_cbm', sa.Float(), nullable=False, server_default='0'),
        sa.Column('total_weight', sa.Float(), nullable=False, server_default='0'),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.UniqueConstraint('buyer_id', 'consignment_code_id', name='uq_inquiry_buyer_consignment'),
    )
    op.create_index('ix_inquiries_buyer_id', 'inquiries', ['buyer_id'])
    op.create_index('ix_inquiries_consignment_code_id', 'inquiries', ['consignment_code_id'])
    op.create_index('ix_inquiries_consignment_status', 'inquiries', ['consignment_status'])

    op.create_table(
        'inquiry_items',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('inquiry_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('inquiries.id', ondelete='CASCADE'), nullable=False),
        sa.Column('product_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('products.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('uom_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('units_of_measurement.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('quantity', sa.Float(), nullable=False),
        sa.Column('brand_preference', sa.Text(), nullable=True),
        sa.Column('product_specs_remarks', sa.Text(), nullable=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='proposed'),
        sa.Column('proposed_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('proposed_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('approved_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('tally_entry_posted', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('tally_posted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('tally_posted_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('procurement_remarks', sa.Text(), nullable=True),
        sa.Column('requires_license', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index('ix_inquiry_items_inquiry_id', 'inquiry_items', ['inquiry_id'])
    op.create_index('ix_inquiry_items_product_id', 'inquiry_items', ['product_id'])
    op.create_index('ix_inquiry_items_status', 'inquiry_items', ['status'])
    op.create_index('ix_inquiry_items_tally_entry_posted', 'inquiry_items', ['tally_entry_posted'])


def downgrade() -> None:
    op.drop_table('inquiry_items')
    op.drop_table('inquiries')
    op.drop_table('consignment_codes')
