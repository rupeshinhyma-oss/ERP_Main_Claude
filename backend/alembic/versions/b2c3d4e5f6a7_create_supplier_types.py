"""create supplier_types table and seed defaults

Revision ID: b2c3d4e5f6a7
Revises: z0a1b2c3d4e5
Create Date: 2026-08-11 00:00:00.000000

Creates the supplier_types table and seeds default types:
- Manufacturer
- Dealer / Trader
"""
import uuid
from datetime import datetime, timezone
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b2c3d4e5f6a7'
down_revision = 'z0a1b2c3d4e6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    supplier_types_table = op.create_table(
        'supplier_types',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('code', sa.String(length=50), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('status', sa.Enum('active', 'inactive', name='supplier_type_status', native_enum=False, length=20), nullable=False, server_default='active'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('code'),
        sa.UniqueConstraint('name')
    )
    op.create_index('ix_supplier_types_code', 'supplier_types', ['code'], unique=True)
    op.create_index('ix_supplier_types_name', 'supplier_types', ['name'], unique=True)
    op.create_index('ix_supplier_types_status', 'supplier_types', ['status'], unique=False)

    # Seed initial default supplier types
    now = datetime.now(timezone.utc)
    op.bulk_insert(
        supplier_types_table,
        [
            {
                'id': uuid.uuid4(),
                'name': 'Manufacturer',
                'code': 'ST-MANUFACTURER',
                'description': 'Direct producer or factory manufacturer',
                'status': 'ACTIVE',
                'created_at': now,
                'updated_at': now,
                'deleted_at': None,
            },
            {
                'id': uuid.uuid4(),
                'name': 'Dealer / Trader',
                'code': 'ST-DEALER_TRADER',
                'description': 'Distributor, trader, or authorized dealer',
                'status': 'ACTIVE',

                'created_at': now,
                'updated_at': now,
                'deleted_at': None,
            },
        ]
    )


def downgrade() -> None:
    op.drop_index('ix_supplier_types_status', table_name='supplier_types')
    op.drop_index('ix_supplier_types_name', table_name='supplier_types')
    op.drop_index('ix_supplier_types_code', table_name='supplier_types')
    op.drop_table('supplier_types')
