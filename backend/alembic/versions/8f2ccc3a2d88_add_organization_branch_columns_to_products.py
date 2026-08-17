"""add organization/branch columns to products (properly tracked)

Revision ID: 8f2ccc3a2d88
Revises: e7b8c9d0e1f2
Create Date: 2026-08-17 00:00:00.000000

Adds organization_id, organization_ids, and branch_ids to products as a
REAL, tracked migration. These three columns already exist as declared
SQLAlchemy model fields (see app.masters.products.models.Product) and,
per direct inspection of the live database, already exist there too --
but only organization_ids ever went through Alembic in the first place,
and even that isn't true: NONE of the three had a migration. The only
column of the three actually added anywhere in code was organization_ids,
and it was added via a raw, untracked `ALTER TABLE products ADD COLUMN
organization_ids JSON;` executed on every single app startup (in
app.main's lifespan, wrapped in try/except so it silently no-ops after
the first run) -- never through Alembic. organization_id and branch_ids
appear to have been added directly against the database (e.g. via the
Supabase SQL editor) without ANY corresponding code path at all.

This migration closes that gap by making all three columns a real,
reviewable part of the migration history from this point forward. Since
they already exist on the live database, every ADD COLUMN below is
guarded with an existence check so this is safe to run whether or not a
given column is already present (fresh databases created from scratch
get all three; the existing production database gets none re-added).

This is a prerequisite for the sheet-to-branch linking feature added in
the next migration (e458bf5b9780): PlanningSheet.branch_id references a
branch entry inside a specific product's branch_ids, so branch_ids
itself needs to be a real, tracked column first.
"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = '8f2ccc3a2d88'
down_revision = 'e7b8c9d0e1f2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("products")}
    existing_fks = {fk["name"] for fk in inspector.get_foreign_keys("products") if fk.get("name")}
    existing_indexes = {ix["name"] for ix in inspector.get_indexes("products")}

    if "organization_id" not in existing_cols:
        op.add_column("products", sa.Column("organization_id", app.database.base.GUID(), nullable=True))
    if "ix_products_organization_id" not in existing_indexes:
        op.create_index("ix_products_organization_id", "products", ["organization_id"])
    if "fk_products_organization_id_master_companies" not in existing_fks:
        op.create_foreign_key(
            "fk_products_organization_id_master_companies",
            "products",
            "master_companies",
            ["organization_id"],
            ["id"],
            ondelete="SET NULL",
        )

    if "organization_ids" not in existing_cols:
        op.add_column("products", sa.Column("organization_ids", sa.JSON(), nullable=True))

    if "branch_ids" not in existing_cols:
        op.add_column("products", sa.Column("branch_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("products", "branch_ids")
    op.drop_column("products", "organization_ids")
    op.drop_constraint("fk_products_organization_id_master_companies", "products", type_="foreignkey")
    op.drop_index("ix_products_organization_id", table_name="products")
    op.drop_column("products", "organization_id")
