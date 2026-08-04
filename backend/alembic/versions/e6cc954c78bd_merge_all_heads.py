"""merge_all_heads

Revision ID: e6cc954c78bd
Revises: 74aa72246464, h2i3j4k5l6m7
Create Date: 2026-08-05 11:08:18.243257

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e6cc954c78bd'
down_revision = ('74aa72246464', 'h2i3j4k5l6m7')
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    pass


def downgrade() -> None:
    """Revert this migration's schema changes."""
    pass
