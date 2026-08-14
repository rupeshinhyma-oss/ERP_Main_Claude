"""remove teams departments designations

Revision ID: e7b8c9d0e1f2
Revises: 974db96ce762
Create Date: 2026-08-14 00:00:00.000000

Removes departments, designations, and their associated permission hierarchy tables.
Drops department_id and designation_id from the users table.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e7b8c9d0e1f2'
down_revision = '974db96ce762'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Drop department_id and designation_id columns (with any dependent constraints/indices) from users
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS department_id CASCADE")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS designation_id CASCADE")

    # 2. Drop department/designation permission tables
    op.execute("DROP TABLE IF EXISTS department_permissions CASCADE")
    op.execute("DROP TABLE IF EXISTS designation_permissions CASCADE")

    # 3. Drop departments and designations tables
    op.execute("DROP TABLE IF EXISTS departments CASCADE")
    op.execute("DROP TABLE IF EXISTS designations CASCADE")


def downgrade() -> None:
    op.create_table(
        'departments',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('code', sa.String(50), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='ACTIVE'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table(
        'designations',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('title', sa.String(100), nullable=False),
        sa.Column('code', sa.String(50), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='ACTIVE'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.add_column('users', sa.Column('department_id', sa.UUID(), nullable=True))
    op.add_column('users', sa.Column('designation_id', sa.UUID(), nullable=True))
