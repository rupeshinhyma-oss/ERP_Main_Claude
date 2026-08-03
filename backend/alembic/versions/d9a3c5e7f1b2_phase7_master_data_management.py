"""phase7_master_data_management

Revision ID: d9a3c5e7f1b2
Revises: c8f4a2b1e6d7
Create Date: 2026-08-03 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'd9a3c5e7f1b2'
down_revision = 'c8f4a2b1e6d7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    # --- countries -------------------------------------------------------------------
    op.create_table(
        'countries',
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('code', sa.String(length=10), nullable=False),
        sa.Column('iso2', sa.String(length=2), nullable=True),
        sa.Column('iso3', sa.String(length=3), nullable=True),
        sa.Column('phone_code', sa.String(length=10), nullable=True),
        sa.Column('nationality', sa.String(length=100), nullable=True),
        sa.Column('currency', sa.String(length=10), nullable=True),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='country_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_countries_name'), 'countries', ['name'], unique=True)
    op.create_index(op.f('ix_countries_code'), 'countries', ['code'], unique=True)
    op.create_index(op.f('ix_countries_iso2'), 'countries', ['iso2'], unique=False)
    op.create_index(op.f('ix_countries_iso3'), 'countries', ['iso3'], unique=False)
    op.create_index(op.f('ix_countries_status'), 'countries', ['status'], unique=False)

    # --- states ------------------------------------------------------------------------
    op.create_table(
        'states',
        sa.Column('country_id', app.database.base.GUID(), nullable=False),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('code', sa.String(length=20), nullable=True),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='state_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['country_id'], ['countries.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('country_id', 'name', name='uq_state_country_name'),
    )
    op.create_index(op.f('ix_states_country_id'), 'states', ['country_id'], unique=False)
    op.create_index(op.f('ix_states_name'), 'states', ['name'], unique=False)
    op.create_index(op.f('ix_states_code'), 'states', ['code'], unique=False)
    op.create_index(op.f('ix_states_status'), 'states', ['status'], unique=False)

    # --- cities ------------------------------------------------------------------------
    op.create_table(
        'cities',
        sa.Column('country_id', app.database.base.GUID(), nullable=False),
        sa.Column('state_id', app.database.base.GUID(), nullable=False),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='city_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['country_id'], ['countries.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['state_id'], ['states.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('state_id', 'name', name='uq_city_state_name'),
    )
    op.create_index(op.f('ix_cities_country_id'), 'cities', ['country_id'], unique=False)
    op.create_index(op.f('ix_cities_state_id'), 'cities', ['state_id'], unique=False)
    op.create_index(op.f('ix_cities_name'), 'cities', ['name'], unique=False)
    op.create_index(op.f('ix_cities_status'), 'cities', ['status'], unique=False)

    # --- currencies --------------------------------------------------------------------
    op.create_table(
        'currencies',
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('code', sa.String(length=10), nullable=False),
        sa.Column('symbol', sa.String(length=10), nullable=True),
        sa.Column('decimal_places', sa.Integer(), nullable=False),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='currency_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_currencies_name'), 'currencies', ['name'], unique=True)
    op.create_index(op.f('ix_currencies_code'), 'currencies', ['code'], unique=True)
    op.create_index(op.f('ix_currencies_status'), 'currencies', ['status'], unique=False)

    # --- units_of_measurement ------------------------------------------------------------
    op.create_table(
        'units_of_measurement',
        sa.Column('code', sa.String(length=20), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('short_name', sa.String(length=20), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='uom_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_units_of_measurement_code'), 'units_of_measurement', ['code'], unique=True)
    op.create_index(op.f('ix_units_of_measurement_name'), 'units_of_measurement', ['name'], unique=True)
    op.create_index(op.f('ix_units_of_measurement_status'), 'units_of_measurement', ['status'], unique=False)

    # --- hsn_codes -----------------------------------------------------------------------
    op.create_table(
        'hsn_codes',
        sa.Column('code', sa.String(length=20), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('gst_percent', sa.Numeric(5, 2), nullable=False),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='hsn_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_hsn_codes_code'), 'hsn_codes', ['code'], unique=True)
    op.create_index(op.f('ix_hsn_codes_status'), 'hsn_codes', ['status'], unique=False)

    # --- brands -------------------------------------------------------------------------
    op.create_table(
        'brands',
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('code', sa.String(length=50), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('logo_url', sa.String(length=500), nullable=True),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='brand_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_brands_name'), 'brands', ['name'], unique=True)
    op.create_index(op.f('ix_brands_code'), 'brands', ['code'], unique=True)
    op.create_index(op.f('ix_brands_status'), 'brands', ['status'], unique=False)

    # --- product_categories --------------------------------------------------------------
    op.create_table(
        'product_categories',
        sa.Column('code', sa.String(length=50), nullable=False),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='product_category_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_product_categories_code'), 'product_categories', ['code'], unique=True)
    op.create_index(op.f('ix_product_categories_name'), 'product_categories', ['name'], unique=True)
    op.create_index(op.f('ix_product_categories_status'), 'product_categories', ['status'], unique=False)

    # --- product_sub_categories -----------------------------------------------------------
    op.create_table(
        'product_sub_categories',
        sa.Column('category_id', app.database.base.GUID(), nullable=False),
        sa.Column('code', sa.String(length=50), nullable=False),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='product_subcategory_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['category_id'], ['product_categories.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('category_id', 'name', name='uq_subcategory_category_name'),
    )
    op.create_index(op.f('ix_product_sub_categories_category_id'), 'product_sub_categories', ['category_id'], unique=False)
    op.create_index(op.f('ix_product_sub_categories_code'), 'product_sub_categories', ['code'], unique=True)
    op.create_index(op.f('ix_product_sub_categories_name'), 'product_sub_categories', ['name'], unique=False)
    op.create_index(op.f('ix_product_sub_categories_status'), 'product_sub_categories', ['status'], unique=False)

    # --- products -----------------------------------------------------------------------
    op.create_table(
        'products',
        sa.Column('product_code', sa.String(length=50), nullable=False),
        sa.Column('product_name', sa.String(length=255), nullable=False),
        sa.Column('barcode', sa.String(length=100), nullable=True),
        sa.Column('category_id', app.database.base.GUID(), nullable=False),
        sa.Column('sub_category_id', app.database.base.GUID(), nullable=True),
        sa.Column('brand_id', app.database.base.GUID(), nullable=True),
        sa.Column('hsn_id', app.database.base.GUID(), nullable=True),
        sa.Column('uom_id', app.database.base.GUID(), nullable=False),
        sa.Column('secondary_uom_id', app.database.base.GUID(), nullable=True),
        sa.Column('specification', sa.Text(), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('images', sa.JSON(), nullable=True),
        sa.Column('weight', sa.Numeric(12, 3), nullable=True),
        sa.Column('length', sa.Numeric(12, 3), nullable=True),
        sa.Column('width', sa.Numeric(12, 3), nullable=True),
        sa.Column('height', sa.Numeric(12, 3), nullable=True),
        sa.Column('color', sa.String(length=50), nullable=True),
        sa.Column('material', sa.String(length=100), nullable=True),
        sa.Column('conversion_factor', sa.Numeric(12, 4), nullable=True),
        sa.Column('minimum_order_quantity', sa.Numeric(12, 3), nullable=True),
        sa.Column('reorder_level', sa.Numeric(12, 3), nullable=True),
        sa.Column('standard_cost', sa.Numeric(14, 2), nullable=True),
        sa.Column('standard_price', sa.Numeric(14, 2), nullable=True),
        sa.Column('is_purchasable', sa.Boolean(), nullable=False),
        sa.Column('is_sellable', sa.Boolean(), nullable=False),
        sa.Column('is_active_for_inventory', sa.Boolean(), nullable=False),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='product_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['category_id'], ['product_categories.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['sub_category_id'], ['product_sub_categories.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['brand_id'], ['brands.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['hsn_id'], ['hsn_codes.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['uom_id'], ['units_of_measurement.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['secondary_uom_id'], ['units_of_measurement.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_products_product_code'), 'products', ['product_code'], unique=True)
    op.create_index(op.f('ix_products_product_name'), 'products', ['product_name'], unique=False)
    op.create_index(op.f('ix_products_barcode'), 'products', ['barcode'], unique=False)
    op.create_index(op.f('ix_products_category_id'), 'products', ['category_id'], unique=False)
    op.create_index(op.f('ix_products_sub_category_id'), 'products', ['sub_category_id'], unique=False)
    op.create_index(op.f('ix_products_brand_id'), 'products', ['brand_id'], unique=False)
    op.create_index(op.f('ix_products_hsn_id'), 'products', ['hsn_id'], unique=False)
    op.create_index(op.f('ix_products_uom_id'), 'products', ['uom_id'], unique=False)
    op.create_index(op.f('ix_products_secondary_uom_id'), 'products', ['secondary_uom_id'], unique=False)
    op.create_index(op.f('ix_products_status'), 'products', ['status'], unique=False)


def downgrade() -> None:
    """Revert this migration's schema changes."""
    op.drop_index(op.f('ix_products_status'), table_name='products')
    op.drop_index(op.f('ix_products_secondary_uom_id'), table_name='products')
    op.drop_index(op.f('ix_products_uom_id'), table_name='products')
    op.drop_index(op.f('ix_products_hsn_id'), table_name='products')
    op.drop_index(op.f('ix_products_brand_id'), table_name='products')
    op.drop_index(op.f('ix_products_sub_category_id'), table_name='products')
    op.drop_index(op.f('ix_products_category_id'), table_name='products')
    op.drop_index(op.f('ix_products_barcode'), table_name='products')
    op.drop_index(op.f('ix_products_product_name'), table_name='products')
    op.drop_index(op.f('ix_products_product_code'), table_name='products')
    op.drop_table('products')

    op.drop_index(op.f('ix_product_sub_categories_status'), table_name='product_sub_categories')
    op.drop_index(op.f('ix_product_sub_categories_name'), table_name='product_sub_categories')
    op.drop_index(op.f('ix_product_sub_categories_code'), table_name='product_sub_categories')
    op.drop_index(op.f('ix_product_sub_categories_category_id'), table_name='product_sub_categories')
    op.drop_table('product_sub_categories')

    op.drop_index(op.f('ix_product_categories_status'), table_name='product_categories')
    op.drop_index(op.f('ix_product_categories_name'), table_name='product_categories')
    op.drop_index(op.f('ix_product_categories_code'), table_name='product_categories')
    op.drop_table('product_categories')

    op.drop_index(op.f('ix_brands_status'), table_name='brands')
    op.drop_index(op.f('ix_brands_code'), table_name='brands')
    op.drop_index(op.f('ix_brands_name'), table_name='brands')
    op.drop_table('brands')

    op.drop_index(op.f('ix_hsn_codes_status'), table_name='hsn_codes')
    op.drop_index(op.f('ix_hsn_codes_code'), table_name='hsn_codes')
    op.drop_table('hsn_codes')

    op.drop_index(op.f('ix_units_of_measurement_status'), table_name='units_of_measurement')
    op.drop_index(op.f('ix_units_of_measurement_name'), table_name='units_of_measurement')
    op.drop_index(op.f('ix_units_of_measurement_code'), table_name='units_of_measurement')
    op.drop_table('units_of_measurement')

    op.drop_index(op.f('ix_currencies_status'), table_name='currencies')
    op.drop_index(op.f('ix_currencies_code'), table_name='currencies')
    op.drop_index(op.f('ix_currencies_name'), table_name='currencies')
    op.drop_table('currencies')

    op.drop_index(op.f('ix_cities_status'), table_name='cities')
    op.drop_index(op.f('ix_cities_name'), table_name='cities')
    op.drop_index(op.f('ix_cities_state_id'), table_name='cities')
    op.drop_index(op.f('ix_cities_country_id'), table_name='cities')
    op.drop_table('cities')

    op.drop_index(op.f('ix_states_status'), table_name='states')
    op.drop_index(op.f('ix_states_code'), table_name='states')
    op.drop_index(op.f('ix_states_name'), table_name='states')
    op.drop_index(op.f('ix_states_country_id'), table_name='states')
    op.drop_table('states')

    op.drop_index(op.f('ix_countries_status'), table_name='countries')
    op.drop_index(op.f('ix_countries_iso3'), table_name='countries')
    op.drop_index(op.f('ix_countries_iso2'), table_name='countries')
    op.drop_index(op.f('ix_countries_code'), table_name='countries')
    op.drop_index(op.f('ix_countries_name'), table_name='countries')
    op.drop_table('countries')
