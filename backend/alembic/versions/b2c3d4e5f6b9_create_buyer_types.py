"""create buyer_types table and seed defaults

Revision ID: b2c3d4e5f6b9
Revises: c3d4e5f6a7b8
Create Date: 2026-08-12 00:00:00.000000

Creates the buyer_types table and seeds default types:
- Manufacturer
- Dealer / Trader
- Agent
- Importer
- Distributor
"""
import uuid
from datetime import datetime, timezone
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b2c3d4e5f6b9'
down_revision = 'b2c3d4e5f6a8'

branch_labels = None
depends_on = None


def upgrade() -> None:
    buyer_types_table = op.create_table(
        'buyer_types',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('code', sa.String(length=50), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('status', sa.Enum('active', 'inactive', name='buyer_type_status', native_enum=False, length=20), nullable=False, server_default='active'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('code'),
        sa.UniqueConstraint('name')
    )
    op.create_index('ix_buyer_types_code', 'buyer_types', ['code'], unique=True)
    op.create_index('ix_buyer_types_name', 'buyer_types', ['name'], unique=True)
    op.create_index('ix_buyer_types_status', 'buyer_types', ['status'], unique=False)

    # Seed initial default buyer types
    now = datetime.now(timezone.utc)
    op.bulk_insert(
        buyer_types_table,
        [
            {
                'id': uuid.uuid4(),
                'name': 'Manufacturer',
                'code': 'BT-MANUFACTURER',
                'description': 'Direct producer or factory manufacturer',
                'status': 'ACTIVE',
                'created_at': now,
                'updated_at': now,
                'deleted_at': None,
            },
            {
                'id': uuid.uuid4(),
                'name': 'Dealer / Trader',
                'code': 'BT-DEALER_TRADER',
                'description': 'Distributor, trader, or authorized dealer',
                'status': 'ACTIVE',
                'created_at': now,
                'updated_at': now,
                'deleted_at': None,
            },
            {
                'id': uuid.uuid4(),
                'name': 'Agent',
                'code': 'BT-AGENT',
                'description': 'Commission agent or representative',
                'status': 'ACTIVE',
                'created_at': now,
                'updated_at': now,
                'deleted_at': None,
            },
            {
                'id': uuid.uuid4(),
                'name': 'Importer',
                'code': 'BT-IMPORTER',
                'description': 'Direct bulk importer',
                'status': 'ACTIVE',
                'created_at': now,
                'updated_at': now,
                'deleted_at': None,
            },
        ]
    )


def downgrade() -> None:
    op.drop_index('ix_buyer_types_status', table_name='buyer_types')
    op.drop_index('ix_buyer_types_name', table_name='buyer_types')
    op.drop_index('ix_buyer_types_code', table_name='buyer_types')
    op.drop_table('buyer_types')
