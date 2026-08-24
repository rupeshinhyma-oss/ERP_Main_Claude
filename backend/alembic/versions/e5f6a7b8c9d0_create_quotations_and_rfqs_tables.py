"""create quotations and rfqs tables

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-08-22 00:00:00.000000

Creates the Quotations and RFQ management tables:
- ``quotations``: Supplier quotation responses per inquiry item
- ``rfqs``: Request for quotation logs per inquiry item
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'e5f6a7b8c9d0'
down_revision = 'd4e5f6a7b8c9'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Create quotations table
    op.create_table(
        'quotations',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('quote_number', sa.String(50), nullable=False),
        sa.Column('inquiry_item_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('inquiry_items.id', ondelete='CASCADE'), nullable=False),
        sa.Column('supplier_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('suppliers.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('quantity', sa.Float(), nullable=False),
        sa.Column('unit_price', sa.Float(), nullable=False),
        sa.Column('total_cost', sa.Float(), nullable=False),
        sa.Column('currency', sa.String(10), nullable=False, server_default='CNY'),
        sa.Column('expected_receiving_date', sa.Date(), nullable=True),
        sa.Column('terms_and_conditions', sa.Text(), nullable=True),
        sa.Column('remarks', sa.Text(), nullable=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='pending'),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
    )
    op.create_index('ix_quotations_quote_number', 'quotations', ['quote_number'])
    op.create_index('ix_quotations_inquiry_item_id', 'quotations', ['inquiry_item_id'])
    op.create_index('ix_quotations_supplier_id', 'quotations', ['supplier_id'])
    op.create_index('ix_quotations_status', 'quotations', ['status'])

    # 2. Create rfqs table
    op.create_table(
        'rfqs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('inquiry_item_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('inquiry_items.id', ondelete='CASCADE'), nullable=False),
        sa.Column('expected_receiving_date', sa.Date(), nullable=True),
        sa.Column('supplier_type', sa.String(30), nullable=False, server_default='selected'),
        sa.Column('supplier_ids', sa.JSON(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('status', sa.String(30), nullable=False, server_default='sent'),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
    )
    op.create_index('ix_rfqs_inquiry_item_id', 'rfqs', ['inquiry_item_id'])


def downgrade() -> None:
    op.drop_table('rfqs')
    op.drop_table('quotations')
