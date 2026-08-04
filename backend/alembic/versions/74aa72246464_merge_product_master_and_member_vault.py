"""merge_product_master_and_member_vault

Revision ID: 74aa72246464
Revises: 119ca9cccff9, f2c5e9b3d7a1
Create Date: 2026-08-04 15:16:54.816448

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '74aa72246464'
down_revision = ('119ca9cccff9', 'f2c5e9b3d7a1')
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    pass


def downgrade() -> None:
    """Revert this migration's schema changes."""
    pass
