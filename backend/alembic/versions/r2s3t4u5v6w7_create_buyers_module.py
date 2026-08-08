"""create buyers module tables

Revision ID: r2s3t4u5v6w7
Revises: q1r2s3t4u5v6
Create Date: 2026-08-08 00:00:00.000000

Creates the Buyer (Client) module: ``buyers`` (the main profile),
``buyer_emails`` (multiple emails per buyer), ``buyer_contacts``
(multiple contact people per buyer, with the main form's contact
auto-mirrored as primary), and the ``buyer_category_links`` /
``buyer_sub_category_links`` many-to-many tables tying a buyer to
existing Product Category / Product Sub-Category master rows.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'r2s3t4u5v6w7'
down_revision = 'q1r2s3t4u5v6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'buyers',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('company_name', sa.String(255), nullable=False),
        sa.Column('buyer_type', sa.String(20), nullable=True),
        sa.Column('country_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('countries.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('city', sa.String(150), nullable=True),
        sa.Column('address', sa.Text(), nullable=True),
        sa.Column('contact_salutation', sa.String(10), nullable=True),
        sa.Column('contact_full_name', sa.String(150), nullable=True),
        sa.Column('contact_designation', sa.String(150), nullable=True),
        sa.Column('contact_calling_number', sa.String(20), nullable=True),
        sa.Column('contact_whatsapp_number', sa.String(20), nullable=True),
        sa.Column('tax_id_number', sa.String(100), nullable=True),
        sa.Column('website', sa.String(500), nullable=True),
        sa.Column('current_status', sa.String(20), nullable=True),
        sa.Column('product_range', sa.Text(), nullable=True),
        sa.Column('potential', sa.String(10), nullable=True),
        sa.Column('potential_reason', sa.Text(), nullable=True),
        sa.Column('buyer_grade', sa.String(5), nullable=True),
        sa.Column('currently_buying_from', sa.Text(), nullable=True),
        sa.Column('overall_remarks', sa.Text(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_index('ix_buyers_company_name', 'buyers', ['company_name'])
    op.create_index('ix_buyers_country_id', 'buyers', ['country_id'])
    op.create_index('ix_buyers_is_active', 'buyers', ['is_active'])

    op.create_table(
        'buyer_emails',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('buyer_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('buyers.id', ondelete='CASCADE'), nullable=False),
        sa.Column('email', sa.String(255), nullable=False),
        sa.UniqueConstraint('buyer_id', 'email', name='uq_buyer_email'),
    )
    op.create_index('ix_buyer_emails_buyer_id', 'buyer_emails', ['buyer_id'])
    op.create_index('ix_buyer_emails_email', 'buyer_emails', ['email'])

    op.create_table(
        'buyer_contacts',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('buyer_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('buyers.id', ondelete='CASCADE'), nullable=False),
        sa.Column('salutation', sa.String(10), nullable=True),
        sa.Column('person_name', sa.String(150), nullable=False),
        sa.Column('designation', sa.String(150), nullable=True),
        sa.Column('country_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('countries.id', ondelete='SET NULL'), nullable=True),
        sa.Column('calling_number', sa.String(20), nullable=True),
        sa.Column('whatsapp_number', sa.String(20), nullable=True),
        sa.Column('email', sa.String(255), nullable=True),
        sa.Column('is_primary', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index('ix_buyer_contacts_buyer_id', 'buyer_contacts', ['buyer_id'])
    op.create_index('ix_buyer_contacts_country_id', 'buyer_contacts', ['country_id'])

    op.create_table(
        'buyer_category_links',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('buyer_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('buyers.id', ondelete='CASCADE'), nullable=False),
        sa.Column('category_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('product_categories.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('buyer_id', 'category_id', name='uq_buyer_category'),
    )
    op.create_index('ix_buyer_category_links_buyer_id', 'buyer_category_links', ['buyer_id'])
    op.create_index('ix_buyer_category_links_category_id', 'buyer_category_links', ['category_id'])

    op.create_table(
        'buyer_sub_category_links',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('buyer_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('buyers.id', ondelete='CASCADE'), nullable=False),
        sa.Column('sub_category_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('product_sub_categories.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('buyer_id', 'sub_category_id', name='uq_buyer_subcategory'),
    )
    op.create_index('ix_buyer_sub_category_links_buyer_id', 'buyer_sub_category_links', ['buyer_id'])
    op.create_index('ix_buyer_sub_category_links_sub_category_id', 'buyer_sub_category_links', ['sub_category_id'])


def downgrade() -> None:
    op.drop_table('buyer_sub_category_links')
    op.drop_table('buyer_category_links')
    op.drop_table('buyer_contacts')
    op.drop_table('buyer_emails')
    op.drop_table('buyers')
