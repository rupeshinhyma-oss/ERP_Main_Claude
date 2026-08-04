"""phase9_member_password_vault

Revision ID: f2c5e9b3d7a1
Revises: e1b4d8a2c6f3
Create Date: 2026-08-04 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'f2c5e9b3d7a1'
down_revision = 'e1b4d8a2c6f3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    op.create_table(
        'member_password_vault',
        sa.Column('user_id', app.database.base.GUID(), nullable=False),
        sa.Column('encrypted_password', sa.Text(), nullable=False),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', name='uq_member_password_vault_user_id'),
    )
    op.create_index(
        op.f('ix_member_password_vault_user_id'), 'member_password_vault', ['user_id'], unique=True
    )


def downgrade() -> None:
    """Revert this migration's schema changes."""
    op.drop_index(op.f('ix_member_password_vault_user_id'), table_name='member_password_vault')
    op.drop_table('member_password_vault')