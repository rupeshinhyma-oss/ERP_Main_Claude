"""merge width_px branch and organization/branch-linking branch

Revision ID: 16c4e642b046
Revises: fe76691d38c8, e458bf5b9780
Create Date: 2026-08-17 00:00:00.000000

Two migrations independently branched off the same parent
(e7b8c9d0e1f2) in separate sessions and were never reconciled:

  Branch 1 (column width persistence):
      e7b8c9d0e1f2 -> fe76691d38c8 (add width_px to planning_columns)

  Branch 2 (organization/branch linking):
      e7b8c9d0e1f2 -> 8f2ccc3a2d88 (track products.organization_id/
                                     organization_ids/branch_ids properly)
                    -> e458bf5b9780 (link planning_sheets to organization+branch)

Both branches touch entirely different tables/columns (planning_columns
vs. products/planning_sheets) with zero overlap, so this is a pure
structural merge -- an empty no-op migration whose only purpose is to
give Alembic a single revision with both branch tips as its
down_revision, the same pattern used by this repository's own earlier
merge migrations (e6cc954c78bd_merge_all_heads.py,
b1c2d3e4f5a8_merge_heads.py). Nothing to actually apply here; both
branches' real migrations already applied their own changes when they ran.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '16c4e642b046'
down_revision = ('fe76691d38c8', 'e458bf5b9780')
branch_labels = None
depends_on = None


def upgrade() -> None:
    """No schema changes -- this revision exists only to merge two branch heads into one."""
    pass


def downgrade() -> None:
    """No schema changes to revert."""
    pass
