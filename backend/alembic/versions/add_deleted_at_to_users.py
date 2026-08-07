"""add deleted_at to users

Revision ID: f9a8c7b6e5d4
Revises: e1b4d8a2c6f3
Create Date: 2026-08-07 18:15:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'f9a8c7b6e5d4'
down_revision = 'j4k5l6m7n8o9'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE NULL;")


def downgrade() -> None:
    op.drop_column('users', 'deleted_at')
