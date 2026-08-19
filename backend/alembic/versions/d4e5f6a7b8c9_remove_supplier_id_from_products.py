"""remove supplier_id from products

Revision ID: d4e5f6a7b8c9
Revises: 16c4e642b046
Create Date: 2026-08-19 14:00:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "d4e5f6a7b8c9"
down_revision = "16c4e642b046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Check and drop index and column if they exist
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [c["name"] for c in inspector.get_columns("products")]
    if "supplier_id" in columns:
        indexes = [idx["name"] for idx in inspector.get_indexes("products")]
        if "ix_products_supplier_id" in indexes:
            op.drop_index("ix_products_supplier_id", table_name="products")
        op.drop_column("products", "supplier_id")


def downgrade() -> None:
    op.add_column(
        "products",
        sa.Column("supplier_id", sa.UUID(), sa.ForeignKey("suppliers.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_products_supplier_id", "products", ["supplier_id"])
