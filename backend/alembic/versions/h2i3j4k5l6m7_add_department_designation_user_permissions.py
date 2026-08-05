"""add_department_designation_user_permissions

Revision ID: h2i3j4k5l6m7
Revises: g1h2i3j4k5l6
Create Date: 2026-08-04 14:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'h2i3j4k5l6m7'
down_revision = 'g1h2i3j4k5l6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    bind = op.get_bind()
    insp = sa.inspect(bind)
    # --- user_permissions ---
    if not insp.has_table('user_permissions'):
        op.create_table(
            'user_permissions',
            sa.Column('id', app.database.base.GUID(), nullable=False),
            sa.Column('user_id', app.database.base.GUID(), nullable=False),
            sa.Column('permission_id', app.database.base.GUID(), nullable=False),
            sa.Column('granted_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('granted_by', app.database.base.GUID(), nullable=True),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['permission_id'], ['permissions.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['granted_by'], ['users.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('user_id', 'permission_id', name='uq_user_permission'),
        )
        op.create_index(op.f('ix_user_permissions_user_id'), 'user_permissions', ['user_id'], unique=False)
        op.create_index(op.f('ix_user_permissions_permission_id'), 'user_permissions', ['permission_id'], unique=False)

    # --- department_permissions ---
    if not insp.has_table('department_permissions'):
        op.create_table(
            'department_permissions',
            sa.Column('id', app.database.base.GUID(), nullable=False),
            sa.Column('department_id', app.database.base.GUID(), nullable=False),
            sa.Column('permission_id', app.database.base.GUID(), nullable=False),
            sa.Column('granted_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('granted_by', app.database.base.GUID(), nullable=True),
            sa.ForeignKeyConstraint(['department_id'], ['departments.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['permission_id'], ['permissions.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['granted_by'], ['users.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('department_id', 'permission_id', name='uq_department_permission'),
        )
        op.create_index(op.f('ix_department_permissions_department_id'), 'department_permissions', ['department_id'], unique=False)
        op.create_index(op.f('ix_department_permissions_permission_id'), 'department_permissions', ['permission_id'], unique=False)

    # --- designation_permissions ---
    if not insp.has_table('designation_permissions'):
        op.create_table(
            'designation_permissions',
            sa.Column('id', app.database.base.GUID(), nullable=False),
            sa.Column('designation_id', app.database.base.GUID(), nullable=False),
            sa.Column('permission_id', app.database.base.GUID(), nullable=False),
            sa.Column('granted_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('granted_by', app.database.base.GUID(), nullable=True),
            sa.ForeignKeyConstraint(['designation_id'], ['designations.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['permission_id'], ['permissions.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['granted_by'], ['users.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('designation_id', 'permission_id', name='uq_designation_permission'),
        )
        op.create_index(op.f('ix_designation_permissions_designation_id'), 'designation_permissions', ['designation_id'], unique=False)
        op.create_index(op.f('ix_designation_permissions_permission_id'), 'designation_permissions', ['permission_id'], unique=False)


def downgrade() -> None:
    """Revert this migration's schema changes."""
    op.drop_index(op.f('ix_designation_permissions_permission_id'), table_name='designation_permissions')
    op.drop_index(op.f('ix_designation_permissions_designation_id'), table_name='designation_permissions')
    op.drop_table('designation_permissions')

    op.drop_index(op.f('ix_department_permissions_permission_id'), table_name='department_permissions')
    op.drop_index(op.f('ix_department_permissions_department_id'), table_name='department_permissions')
    op.drop_table('department_permissions')

    op.drop_index(op.f('ix_user_permissions_permission_id'), table_name='user_permissions')
    op.drop_index(op.f('ix_user_permissions_user_id'), table_name='user_permissions')
    op.drop_table('user_permissions')
