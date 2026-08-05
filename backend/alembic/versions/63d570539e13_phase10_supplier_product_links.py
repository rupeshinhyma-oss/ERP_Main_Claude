"""phase10_supplier_product_links

Revision ID: 63d570539e13
Revises: f2c5e9b3d7a1
Create Date: 2026-08-04 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = '63d570539e13'
down_revision = 'f2c5e9b3d7a1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table('supplier_product_links'):
        op.create_table(
            'supplier_product_links',
            sa.Column('supplier_id', app.database.base.GUID(), nullable=False),
            sa.Column('product_id', app.database.base.GUID(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('id', app.database.base.GUID(), nullable=False),
            sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['product_id'], ['products.id'], ondelete='RESTRICT'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('supplier_id', 'product_id', name='uq_supplier_product'),
        )
        op.create_index(
            op.f('ix_supplier_product_links_supplier_id'), 'supplier_product_links', ['supplier_id'], unique=False
        )
        op.create_index(
            op.f('ix_supplier_product_links_product_id'), 'supplier_product_links', ['product_id'], unique=False
        )


def downgrade() -> None:
    """Revert this migration's schema changes."""
    op.drop_index(op.f('ix_supplier_product_links_product_id'), table_name='supplier_product_links')
    op.drop_index(op.f('ix_supplier_product_links_supplier_id'), table_name='supplier_product_links')
    op.drop_table('supplier_product_links')
