"""add_rbac_permission_hierarchy_fields

Revision ID: g1h2i3j4k5l6
Revises: 63d570539e13
Create Date: 2026-08-04 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'g1h2i3j4k5l6'
down_revision = '63d570539e13'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c['name'] for c in insp.get_columns('permissions')]
    if 'page' not in cols:
        op.add_column('permissions', sa.Column('page', sa.String(length=100), nullable=True))
        op.create_index(op.f('ix_permissions_page'), 'permissions', ['page'], unique=False)
    if 'action' not in cols:
        op.add_column('permissions', sa.Column('action', sa.String(length=50), nullable=True))
        op.create_index(op.f('ix_permissions_action'), 'permissions', ['action'], unique=False)
    if 'scope' not in cols:
        op.add_column('permissions', sa.Column('scope', sa.String(length=50), nullable=True, server_default='ALL'))


def downgrade() -> None:
    """Revert this migration's schema changes."""
    op.drop_index(op.f('ix_permissions_action'), table_name='permissions')
    op.drop_index(op.f('ix_permissions_page'), table_name='permissions')
    op.drop_column('permissions', 'scope')
    op.drop_column('permissions', 'action')
    op.drop_column('permissions', 'page')
