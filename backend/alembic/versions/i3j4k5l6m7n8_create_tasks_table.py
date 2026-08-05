"""create_tasks_table

Revision ID: i3j4k5l6m7n8
Revises: e6cc954c78bd
Create Date: 2026-08-05 14:55:00.000000

"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'i3j4k5l6m7n8'
down_revision = 'e6cc954c78bd'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table('tasks'):
        op.create_table(
            'tasks',
            sa.Column('id', app.database.base.GUID(), nullable=False),
            sa.Column('title', sa.String(length=200), nullable=False),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column(
                'status',
                sa.Enum('PENDING', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'CANCELLED', name='taskstatus', native_enum=False, length=20),
                nullable=False,
                server_default='PENDING',
            ),
            sa.Column(
                'priority',
                sa.Enum('LOW', 'MEDIUM', 'HIGH', 'URGENT', name='taskpriority', native_enum=False, length=20),
                nullable=False,
                server_default='MEDIUM',
            ),
            sa.Column('due_date', sa.DateTime(timezone=True), nullable=True),
            sa.Column('assigned_to_id', app.database.base.GUID(), nullable=True),
            sa.Column('created_by_id', app.database.base.GUID(), nullable=True),
            sa.Column('related_entity_type', sa.String(length=50), nullable=True),
            sa.Column('related_entity_id', sa.String(length=100), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(['assigned_to_id'], ['users.id'], ondelete='SET NULL'),
            sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index(op.f('ix_tasks_title'), 'tasks', ['title'], unique=False)
        op.create_index(op.f('ix_tasks_status'), 'tasks', ['status'], unique=False)
        op.create_index(op.f('ix_tasks_priority'), 'tasks', ['priority'], unique=False)
        op.create_index(op.f('ix_tasks_due_date'), 'tasks', ['due_date'], unique=False)
        op.create_index(op.f('ix_tasks_assigned_to_id'), 'tasks', ['assigned_to_id'], unique=False)
        op.create_index(op.f('ix_tasks_created_by_id'), 'tasks', ['created_by_id'], unique=False)
        op.create_index(op.f('ix_tasks_related_entity_type'), 'tasks', ['related_entity_type'], unique=False)
        op.create_index(op.f('ix_tasks_related_entity_id'), 'tasks', ['related_entity_id'], unique=False)


def downgrade() -> None:
    """Revert this migration's schema changes."""
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if insp.has_table('tasks'):
        op.drop_index(op.f('ix_tasks_related_entity_id'), table_name='tasks')
        op.drop_index(op.f('ix_tasks_related_entity_type'), table_name='tasks')
        op.drop_index(op.f('ix_tasks_created_by_id'), table_name='tasks')
        op.drop_index(op.f('ix_tasks_assigned_to_id'), table_name='tasks')
        op.drop_index(op.f('ix_tasks_due_date'), table_name='tasks')
        op.drop_index(op.f('ix_tasks_priority'), table_name='tasks')
        op.drop_index(op.f('ix_tasks_status'), table_name='tasks')
        op.drop_index(op.f('ix_tasks_title'), table_name='tasks')
        op.drop_table('tasks')
