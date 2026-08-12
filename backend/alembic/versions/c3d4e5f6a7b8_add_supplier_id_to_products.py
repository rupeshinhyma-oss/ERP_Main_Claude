"""add supplier_id to products

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-08-11 18:40:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c3d4e5f6a7b8"
down_revision = "b2c3d4e5f6a7"


branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "products",
        sa.Column("supplier_id", sa.UUID(), sa.ForeignKey("suppliers.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_products_supplier_id", "products", ["supplier_id"])


def downgrade() -> None:
    op.drop_index("ix_products_supplier_id", table_name="products")
    op.drop_column("products", "supplier_id")
