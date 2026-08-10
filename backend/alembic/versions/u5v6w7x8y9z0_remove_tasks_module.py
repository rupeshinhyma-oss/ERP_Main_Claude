"""remove_tasks_module

Revision ID: u5v6w7x8y9z0
Revises: t4u5v6w7x8y9
Create Date: 2026-08-10 13:00:00.000000

Removes the tasks table and cleans up task permissions from the database.
"""
from alembic import op
import sqlalchemy as sa


revision = 'u5v6w7x8y9z0'
down_revision = 't4u5v6w7x8y9'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Drop tasks table and delete task-related permissions."""
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if insp.has_table('tasks'):
        # Drop indices if present
        for idx in ['ix_tasks_related_entity_id', 'ix_tasks_related_entity_type',
                    'ix_tasks_created_by_id', 'ix_tasks_assigned_to_id',
                    'ix_tasks_due_date', 'ix_tasks_priority',
                    'ix_tasks_status', 'ix_tasks_title']:
            try:
                op.drop_index(op.f(idx), table_name='tasks')
            except Exception:
                pass
        op.drop_table('tasks')

    # Remove task permissions from role_permissions and permissions tables if present
    if insp.has_table('permissions'):
        op.execute(
            "DELETE FROM role_permissions WHERE permission_id IN ("
            "  SELECT id FROM permissions WHERE module = 'task' OR code LIKE 'task.%'"
            ")"
        )
        op.execute("DELETE FROM permissions WHERE module = 'task' OR code LIKE 'task.%'")


def downgrade() -> None:
    """Revert dropping tasks table (no-op or recreate baseline)."""
    pass
