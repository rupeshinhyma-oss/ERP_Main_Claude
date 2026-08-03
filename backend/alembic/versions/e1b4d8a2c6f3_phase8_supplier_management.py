"""phase8_supplier_management

Revision ID: e1b4d8a2c6f3
Revises: d9a3c5e7f1b2
Create Date: 2026-08-03 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'e1b4d8a2c6f3'
down_revision = 'd9a3c5e7f1b2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    # --- suppliers -----------------------------------------------------------------------
    op.create_table(
        'suppliers',
        sa.Column('company_name', sa.String(length=255), nullable=False),
        sa.Column(
            'supplier_type',
            sa.Enum('MANUFACTURER', 'TRADER', name='supplier_type', native_enum=False, length=20),
            nullable=True,
        ),
        sa.Column('brand_description', sa.Text(), nullable=True),
        sa.Column('country_id', app.database.base.GUID(), nullable=False),
        sa.Column('state_id', app.database.base.GUID(), nullable=False),
        sa.Column('city_id', app.database.base.GUID(), nullable=False),
        sa.Column('contact_salutation', sa.String(length=10), nullable=True),
        sa.Column('contact_full_name', sa.String(length=150), nullable=True),
        sa.Column('contact_designation', sa.String(length=150), nullable=True),
        sa.Column('contact_calling_number', sa.String(length=20), nullable=True),
        sa.Column('contact_whatsapp_number', sa.String(length=20), nullable=True),
        sa.Column('contact_wechat_number', sa.String(length=20), nullable=True),
        sa.Column('tax_id_number', sa.String(length=100), nullable=True),
        sa.Column('address', sa.Text(), nullable=True),
        sa.Column('town', sa.String(length=150), nullable=True),
        sa.Column('primary_website', sa.String(length=500), nullable=True),
        sa.Column('secondary_website', sa.String(length=500), nullable=True),
        sa.Column(
            'supplier_grade',
            sa.Enum('A', 'B', 'C', name='supplier_grade', native_enum=False, length=5),
            nullable=True,
        ),
        sa.Column(
            'current_status',
            sa.Enum('NEW', 'EXISTING', name='supplier_current_status', native_enum=False, length=20),
            nullable=True,
        ),
        sa.Column(
            'potential',
            sa.Enum('YES', 'NO', name='supplier_potential', native_enum=False, length=10),
            nullable=True,
        ),
        sa.Column('potential_reason', sa.Text(), nullable=True),
        sa.Column('secondary_products_description', sa.Text(), nullable=True),
        sa.Column('visited_factory_office', sa.Boolean(), nullable=False),
        sa.Column('visit_remarks', sa.Text(), nullable=True),
        sa.Column('visit_media', sa.JSON(), nullable=True),
        sa.Column('overall_remarks', sa.Text(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['country_id'], ['countries.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['state_id'], ['states.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['city_id'], ['cities.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_suppliers_company_name'), 'suppliers', ['company_name'], unique=False)
    op.create_index(op.f('ix_suppliers_country_id'), 'suppliers', ['country_id'], unique=False)
    op.create_index(op.f('ix_suppliers_state_id'), 'suppliers', ['state_id'], unique=False)
    op.create_index(op.f('ix_suppliers_city_id'), 'suppliers', ['city_id'], unique=False)
    op.create_index(op.f('ix_suppliers_is_active'), 'suppliers', ['is_active'], unique=False)

    # --- supplier_emails -------------------------------------------------------------------
    op.create_table(
        'supplier_emails',
        sa.Column('supplier_id', app.database.base.GUID(), nullable=False),
        sa.Column('email', sa.String(length=255), nullable=False),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('supplier_id', 'email', name='uq_supplier_email'),
    )
    op.create_index(op.f('ix_supplier_emails_supplier_id'), 'supplier_emails', ['supplier_id'], unique=False)
    op.create_index(op.f('ix_supplier_emails_email'), 'supplier_emails', ['email'], unique=False)

    # --- supplier_contacts -----------------------------------------------------------------
    op.create_table(
        'supplier_contacts',
        sa.Column('supplier_id', app.database.base.GUID(), nullable=False),
        sa.Column('salutation', sa.String(length=10), nullable=True),
        sa.Column('person_name', sa.String(length=150), nullable=False),
        sa.Column('designation', sa.String(length=150), nullable=True),
        sa.Column('handling_territory', sa.String(length=150), nullable=True),
        sa.Column('country_id', app.database.base.GUID(), nullable=True),
        sa.Column('calling_number', sa.String(length=20), nullable=True),
        sa.Column('whatsapp_number', sa.String(length=20), nullable=True),
        sa.Column('wechat_number', sa.String(length=20), nullable=True),
        sa.Column('email', sa.String(length=255), nullable=True),
        sa.Column('is_primary', sa.Boolean(), nullable=False),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['country_id'], ['countries.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_supplier_contacts_supplier_id'), 'supplier_contacts', ['supplier_id'], unique=False)
    op.create_index(op.f('ix_supplier_contacts_country_id'), 'supplier_contacts', ['country_id'], unique=False)

    # --- supplier_category_links -------------------------------------------------------------
    op.create_table(
        'supplier_category_links',
        sa.Column('supplier_id', app.database.base.GUID(), nullable=False),
        sa.Column('category_id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['category_id'], ['product_categories.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('supplier_id', 'category_id', name='uq_supplier_category'),
    )
    op.create_index(
        op.f('ix_supplier_category_links_supplier_id'), 'supplier_category_links', ['supplier_id'], unique=False
    )
    op.create_index(
        op.f('ix_supplier_category_links_category_id'), 'supplier_category_links', ['category_id'], unique=False
    )

    # --- supplier_sub_category_links ---------------------------------------------------------
    op.create_table(
        'supplier_sub_category_links',
        sa.Column('supplier_id', app.database.base.GUID(), nullable=False),
        sa.Column('sub_category_id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['sub_category_id'], ['product_sub_categories.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('supplier_id', 'sub_category_id', name='uq_supplier_subcategory'),
    )
    op.create_index(
        op.f('ix_supplier_sub_category_links_supplier_id'),
        'supplier_sub_category_links',
        ['supplier_id'],
        unique=False,
    )
    op.create_index(
        op.f('ix_supplier_sub_category_links_sub_category_id'),
        'supplier_sub_category_links',
        ['sub_category_id'],
        unique=False,
    )


def downgrade() -> None:
    """Revert this migration's schema changes."""
    op.drop_index(op.f('ix_supplier_sub_category_links_sub_category_id'), table_name='supplier_sub_category_links')
    op.drop_index(op.f('ix_supplier_sub_category_links_supplier_id'), table_name='supplier_sub_category_links')
    op.drop_table('supplier_sub_category_links')

    op.drop_index(op.f('ix_supplier_category_links_category_id'), table_name='supplier_category_links')
    op.drop_index(op.f('ix_supplier_category_links_supplier_id'), table_name='supplier_category_links')
    op.drop_table('supplier_category_links')

    op.drop_index(op.f('ix_supplier_contacts_country_id'), table_name='supplier_contacts')
    op.drop_index(op.f('ix_supplier_contacts_supplier_id'), table_name='supplier_contacts')
    op.drop_table('supplier_contacts')

    op.drop_index(op.f('ix_supplier_emails_email'), table_name='supplier_emails')
    op.drop_index(op.f('ix_supplier_emails_supplier_id'), table_name='supplier_emails')
    op.drop_table('supplier_emails')

    op.drop_index(op.f('ix_suppliers_is_active'), table_name='suppliers')
    op.drop_index(op.f('ix_suppliers_city_id'), table_name='suppliers')
    op.drop_index(op.f('ix_suppliers_state_id'), table_name='suppliers')
    op.drop_index(op.f('ix_suppliers_country_id'), table_name='suppliers')
    op.drop_index(op.f('ix_suppliers_company_name'), table_name='suppliers')
    op.drop_table('suppliers')
