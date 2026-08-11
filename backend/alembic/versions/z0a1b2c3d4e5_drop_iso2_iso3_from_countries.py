"""drop iso2 and iso3 columns from countries table

Revision ID: z0a1b2c3d4e5
Revises: y9z0a1b2c3d4
Create Date: 2026-08-11 00:00:00.000000

ISO2 and ISO3 codes are no longer used in the UI or API.
Dropping both columns (and their indexes) from the countries table.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'z0a1b2c3d4e5'
down_revision = 'y9z0a1b2c3d4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop indexes first, then columns
    with op.batch_alter_table('countries') as batch_op:
        batch_op.drop_index('ix_countries_iso2')
        batch_op.drop_index('ix_countries_iso3')
        batch_op.drop_column('iso2')
        batch_op.drop_column('iso3')


def downgrade() -> None:
    # Restore columns and indexes if rolled back
    with op.batch_alter_table('countries') as batch_op:
        batch_op.add_column(sa.Column('iso3', sa.String(length=3), nullable=True))
        batch_op.add_column(sa.Column('iso2', sa.String(length=2), nullable=True))
        batch_op.create_index('ix_countries_iso3', ['iso3'])
        batch_op.create_index('ix_countries_iso2', ['iso2'])
