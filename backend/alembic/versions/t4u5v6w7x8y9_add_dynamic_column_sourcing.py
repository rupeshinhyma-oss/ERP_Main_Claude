"""add dynamic column sourcing (linked lookup, aggregate, formula) and column role locks

Revision ID: t4u5v6w7x8y9
Revises: s3t4u5v6w7x8
Create Date: 2026-08-08 00:00:00.000000

Adds the "extract data from other parts / add any calculation" feature to
Shipment Planning:

- ``planning_columns`` gains ``source_type``, ``source_module``,
  ``source_field``, ``source_aggregate_fn``, ``source_aggregate_filters``,
  and ``formula_expression`` -- an admin can turn any column into a
  linked-lookup, aggregate, or formula column instead of a plain manual
  one, with nothing hardcoded per column.
- ``planning_cells`` gains ``linked_record_id`` -- which source-module
  record a given row is linked to, for LINKED_LOOKUP columns.
- New table ``planning_column_role_locks`` -- optional, additive
  per-column role restriction on top of the existing sheet-level
  ``planning.column.manage`` permission.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 't4u5v6w7x8y9'
down_revision = 's3t4u5v6w7x8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'planning_columns',
        sa.Column('source_type', sa.String(20), nullable=False, server_default='manual'),
    )
    op.add_column('planning_columns', sa.Column('source_module', sa.String(100), nullable=True))
    op.add_column('planning_columns', sa.Column('source_field', sa.String(100), nullable=True))
    op.add_column('planning_columns', sa.Column('source_aggregate_fn', sa.String(20), nullable=True))
    op.add_column('planning_columns', sa.Column('source_aggregate_filters', sa.JSON(), nullable=True))
    op.add_column('planning_columns', sa.Column('formula_expression', sa.Text(), nullable=True))

    op.add_column(
        'planning_cells',
        sa.Column('linked_record_id', postgresql.UUID(as_uuid=True), nullable=True),
    )

    op.create_table(
        'planning_column_role_locks',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('column_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('planning_columns.id', ondelete='CASCADE'), nullable=False),
        sa.Column('role_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('roles.id', ondelete='CASCADE'), nullable=False),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('column_id', 'role_id', name='uq_planning_column_role_lock'),
    )
    op.create_index('ix_planning_column_role_locks_column_id', 'planning_column_role_locks', ['column_id'])
    op.create_index('ix_planning_column_role_locks_role_id', 'planning_column_role_locks', ['role_id'])


def downgrade() -> None:
    op.drop_table('planning_column_role_locks')
    op.drop_column('planning_cells', 'linked_record_id')
    op.drop_column('planning_columns', 'formula_expression')
    op.drop_column('planning_columns', 'source_aggregate_filters')
    op.drop_column('planning_columns', 'source_aggregate_fn')
    op.drop_column('planning_columns', 'source_field')
    op.drop_column('planning_columns', 'source_module')
    op.drop_column('planning_columns', 'source_type')
