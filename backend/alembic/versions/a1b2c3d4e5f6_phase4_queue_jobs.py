"""phase4_queue_jobs

Revision ID: a1b2c3d4e5f6
Revises: 4c3819d53ab8
Create Date: 2026-08-02 17:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'a1b2c3d4e5f6'
down_revision = '4c3819d53ab8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the queue_jobs table for Phase 4 background job processing."""
    op.create_table(
        'queue_jobs',
        sa.Column('job_name', sa.String(length=150), nullable=False),
        sa.Column('module', sa.String(length=100), nullable=False),
        sa.Column('payload', sa.Text(), nullable=False),
        sa.Column(
            'priority',
            sa.Integer(),
            nullable=False,
            server_default='5',  # JobPriority.NORMAL
        ),
        sa.Column(
            'run_at',
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text('NOW()'),
        ),
        sa.Column(
            'status',
            sa.Enum(
                'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED',
                name='job_status',
                native_enum=False,
                length=20,
            ),
            nullable=False,
            server_default='PENDING',
        ),
        sa.Column('retry_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('max_retries', sa.Integer(), nullable=False, server_default='3'),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_by', app.database.base.GUID(), nullable=True),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )

    # Indexes for the worker's claim query (status + run_at + priority).
    op.create_index(op.f('ix_queue_jobs_status'), 'queue_jobs', ['status'], unique=False)
    op.create_index(op.f('ix_queue_jobs_run_at'), 'queue_jobs', ['run_at'], unique=False)
    op.create_index(op.f('ix_queue_jobs_priority'), 'queue_jobs', ['priority'], unique=False)

    # Indexes for API filtering.
    op.create_index(op.f('ix_queue_jobs_job_name'), 'queue_jobs', ['job_name'], unique=False)
    op.create_index(op.f('ix_queue_jobs_module'), 'queue_jobs', ['module'], unique=False)


def downgrade() -> None:
    """Drop the queue_jobs table and its indexes."""
    op.drop_index(op.f('ix_queue_jobs_module'), table_name='queue_jobs')
    op.drop_index(op.f('ix_queue_jobs_job_name'), table_name='queue_jobs')
    op.drop_index(op.f('ix_queue_jobs_priority'), table_name='queue_jobs')
    op.drop_index(op.f('ix_queue_jobs_run_at'), table_name='queue_jobs')
    op.drop_index(op.f('ix_queue_jobs_status'), table_name='queue_jobs')
    op.drop_table('queue_jobs')
