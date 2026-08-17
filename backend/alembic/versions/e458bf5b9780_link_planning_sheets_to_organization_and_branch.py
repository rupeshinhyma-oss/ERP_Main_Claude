"""link planning_sheets to a real organization and branch

Revision ID: e458bf5b9780
Revises: 8f2ccc3a2d88
Create Date: 2026-08-17 00:00:00.000000

Adds organization_id (FK -> master_companies.id) and branch_id (a plain
string -- see note below) to planning_sheets.

Until now, a sheet's "branch" was purely a name someone typed into the
sheet-name field (e.g. "Mumbai Branch") -- nothing connected it to Product
Master's real, structured branch list (MasterCompany.branches, a JSON
array of {"id", "name", "code_prefix"} entries per organization). This
migration makes that link real: every new sheet must now be created with
an explicit organization + branch (enforced in
PlanningService.create_sheet), and the sheet's row/auto-populate
filtering uses that link instead of (or alongside) the old
request-time-only organization_id filter.

WHY branch_id IS A STRING, NOT A FOREIGN KEY:
Branches are not a real table -- they're entries inside
MasterCompany.branches, a JSON column (see
app.masters.company_list.models.MasterCompany). There is nothing in the
database for a foreign key to point AT. branch_id therefore just stores
that JSON entry's own "id" string verbatim, resolved/validated at the
application layer (PlanningService.create_sheet looks it up inside the
chosen organization's branches list and rejects anything not found)
rather than via a database-level constraint.

Existing sheets get organization_id/branch_id = NULL (unlinked) --
nothing retroactively guesses which branch an existing sheet represents.
"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'e458bf5b9780'
down_revision = '8f2ccc3a2d88'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("planning_sheets")}
    existing_fks = {fk["name"] for fk in inspector.get_foreign_keys("planning_sheets") if fk.get("name")}
    existing_indexes = {ix["name"] for ix in inspector.get_indexes("planning_sheets")}

    if "organization_id" not in existing_cols:
        op.add_column("planning_sheets", sa.Column("organization_id", app.database.base.GUID(), nullable=True))
    if "ix_planning_sheets_organization_id" not in existing_indexes:
        op.create_index("ix_planning_sheets_organization_id", "planning_sheets", ["organization_id"])
    if "fk_planning_sheets_organization_id_master_companies" not in existing_fks:
        op.create_foreign_key(
            "fk_planning_sheets_organization_id_master_companies",
            "planning_sheets",
            "master_companies",
            ["organization_id"],
            ["id"],
            ondelete="SET NULL",
        )

    if "branch_id" not in existing_cols:
        op.add_column("planning_sheets", sa.Column("branch_id", sa.String(length=100), nullable=True))


def downgrade() -> None:
    op.drop_column("planning_sheets", "branch_id")
    op.drop_constraint("fk_planning_sheets_organization_id_master_companies", "planning_sheets", type_="foreignkey")
    op.drop_index("ix_planning_sheets_organization_id", table_name="planning_sheets")
    op.drop_column("planning_sheets", "organization_id")
