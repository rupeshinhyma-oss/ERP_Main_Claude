"""merge trash/soft-delete branch and supplier-buyer-types branch

Revision ID: b1c2d3e4f5a8
Revises: be1d2de6b659, a1b2c3d4e5f7
Create Date: 2026-08-14 00:00:00.000000

IMPORTANT -- why this revision ID is not a fresh one:

The live Supabase database was already stamped with
``alembic_version = 'b1c2d3e4f5a8'`` before this file existed -- some
other tool/session ran a migration with this exact revision ID directly
against the database, merging the two branches below, but the migration
file itself was never saved into this codebase/git history (confirmed:
no trace of this ID anywhere in git history, including deleted files).

Rather than inventing a new revision ID and leaving 'b1c2d3e4f5a8'
permanently unresolvable (which is what caused
"Can't locate revision identified by 'b1c2d3e4f5a8'" on every subsequent
`alembic upgrade`), this file uses THAT SAME ID so Alembic's history
lines up with what the database already believes happened. This is safe
specifically because a column-level audit of the live database confirmed
BOTH branches' schema changes are already present (buyer_types/
supplier_types tables, products.supplier_id, etc. from the
"supplier/buyer types" branch; consignment_codes, inquiries,
planning_sheets, planning_status_tags, queue_jobs, etc. from the main
branch) -- i.e. whatever the real (lost) migration did, its net effect
matches "these two branches are now merged, no further schema change,"
which is exactly what this file also does. It was NOT safe to guess this
without that column audit, since a wrong guess here (either the wrong
parent revision or assuming schema changes that didn't actually happen)
could have caused a later migration to silently skip a real column the
database is still missing, or crash trying to re-add a column that
already exists.

  Branch 1 (main line -- planning, buyers, inquiries, RBAC, tasks, then
  the search-performance work):
      z0a1b2c3d4e6 -> ... -> be1d2de6b659 (trigram search indexes)

  Branch 2 (supplier_types/buyer_types master tables, products.supplier_id,
  a planning column, buyer/supplier indexes):
      z0a1b2c3d4e6 -> b2c3d4e5f6a7 -> ... -> a1b2c3d4e5f7

Both branches' migrations already applied their real schema changes when
they ran (confirmed above); this merge point itself makes no changes.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b1c2d3e4f5a8'
down_revision = ('be1d2de6b659', 'a1b2c3d4e5f7')
branch_labels = None
depends_on = None


def upgrade() -> None:
    """No schema changes -- this revision exists only to merge two branch heads into one."""
    pass


def downgrade() -> None:
    """No schema changes to revert."""
    pass
