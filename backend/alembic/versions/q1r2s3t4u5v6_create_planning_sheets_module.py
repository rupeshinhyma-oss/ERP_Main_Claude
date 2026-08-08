"""create shipment planning module tables

Revision ID: q1r2s3t4u5v6
Revises: k5l6m7n8o9p0
Create Date: 2026-08-08 00:00:00.000000

Creates the Shipment Planning grid module: ``planning_sheets`` (branch
tabs), ``planning_rows`` (item lines, unlimited), ``planning_columns``
(admin-defined, unlimited, insertable at any position), ``planning_cells``
(value + CRM-style status color), ``planning_status_tags`` (admin-defined
custom colors beyond the 3 built-ins), and ``planning_change_log`` (a
dedicated, append-only who/when history for every structural and value
change on the grid).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'q1r2s3t4u5v6'
down_revision = 'k5l6m7n8o9p0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'planning_sheets',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('name', sa.String(150), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.UniqueConstraint('name', 'deleted_at', name='uq_planning_sheets_name_live'),
    )

    op.create_table(
        'planning_rows',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('sheet_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('planning_sheets.id', ondelete='CASCADE'), nullable=False),
        sa.Column('label', sa.String(500), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('updated_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
    )
    op.create_index('ix_planning_rows_sheet_id', 'planning_rows', ['sheet_id'])
    op.create_index('ix_planning_rows_sheet_position', 'planning_rows', ['sheet_id', 'position'])

    op.create_table(
        'planning_columns',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('sheet_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('planning_sheets.id', ondelete='CASCADE'), nullable=False),
        sa.Column('name', sa.String(150), nullable=False),
        sa.Column('data_type', sa.String(20), nullable=False, server_default='text'),
        sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_locked', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('updated_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
    )
    op.create_index('ix_planning_columns_sheet_id', 'planning_columns', ['sheet_id'])
    op.create_index('ix_planning_columns_sheet_position', 'planning_columns', ['sheet_id', 'position'])

    op.create_table(
        'planning_status_tags',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('label', sa.String(100), nullable=False),
        sa.Column('hex_color', sa.String(7), nullable=False),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.UniqueConstraint('label', 'deleted_at', name='uq_planning_status_tags_label_live'),
    )

    op.create_table(
        'planning_cells',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('row_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('planning_rows.id', ondelete='CASCADE'), nullable=False),
        sa.Column('column_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('planning_columns.id', ondelete='CASCADE'), nullable=False),
        sa.Column('value', sa.Text(), nullable=True),
        sa.Column('status_color', sa.String(20), nullable=True),
        sa.Column('custom_status_tag_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('planning_status_tags.id'), nullable=True),
        sa.Column('updated_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.UniqueConstraint('row_id', 'column_id', name='uq_planning_cells_row_column'),
    )
    op.create_index('ix_planning_cells_row_id', 'planning_cells', ['row_id'])
    op.create_index('ix_planning_cells_column_id', 'planning_cells', ['column_id'])
    op.create_index('ix_planning_cells_row_column', 'planning_cells', ['row_id', 'column_id'])

    op.create_table(
        'planning_change_log',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('sheet_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('planning_sheets.id'), nullable=False),
        sa.Column('row_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('column_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('cell_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('action', sa.String(30), nullable=False),
        sa.Column('changed_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('changed_by_username_snapshot', sa.String(100), nullable=False),
        sa.Column('old_value', sa.Text(), nullable=True),
        sa.Column('new_value', sa.Text(), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
    )
    op.create_index('ix_planning_change_log_created_at', 'planning_change_log', ['created_at'])
    op.create_index('ix_planning_change_log_sheet_id', 'planning_change_log', ['sheet_id'])
    op.create_index('ix_planning_change_log_row_id', 'planning_change_log', ['row_id'])
    op.create_index('ix_planning_change_log_column_id', 'planning_change_log', ['column_id'])
    op.create_index('ix_planning_change_log_cell_id', 'planning_change_log', ['cell_id'])
    op.create_index('ix_planning_change_log_sheet_created', 'planning_change_log', ['sheet_id', 'created_at'])


def downgrade() -> None:
    op.drop_table('planning_change_log')
    op.drop_table('planning_cells')
    op.drop_table('planning_status_tags')
    op.drop_table('planning_columns')
    op.drop_table('planning_rows')
    op.drop_table('planning_sheets')
