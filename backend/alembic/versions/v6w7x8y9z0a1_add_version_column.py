"""add_version_column_for_occ

Revision ID: v6w7x8y9z0a1
Revises: u5v6w7x8y9z0
Create Date: 2026-08-10 13:30:00.000000

Adds the version column to all master and feature tables for Optimistic Concurrency Control (OCC).
"""
from alembic import op
import sqlalchemy as sa


revision = 'v6w7x8y9z0a1'
down_revision = 'u5v6w7x8y9z0'
branch_labels = None
depends_on = None

TABLES = [
    "users",
    "suppliers",
    "buyers",
    "inquiries",
    "planning_sheets",
    "organizations",
    "departments",
    "designations",
    "countries",
    "states",
    "cities",
    "currencies",
    "uom",
    "hsn",
    "brands",
    "product_categories",
    "product_sub_categories",
    "products",
]


def upgrade() -> None:
    """Add version column to tables if missing."""
    bind = op.get_bind()
    insp = sa.inspect(bind)

    for table_name in TABLES:
        if insp.has_table(table_name):
            cols = {c['name'] for c in insp.get_columns(table_name)}
            if 'version' not in cols:
                op.add_column(
                    table_name,
                    sa.Column('version', sa.Integer(), nullable=False, server_default='1')
                )


def downgrade() -> None:
    """Remove version column from tables."""
    bind = op.get_bind()
    insp = sa.inspect(bind)

    for table_name in TABLES:
        if insp.has_table(table_name):
            cols = {c['name'] for c in insp.get_columns(table_name)}
            if 'version' in cols:
                op.drop_column(table_name, 'version')
