"""purge_legacy_business_roles

Removes the five hardcoded, non-system "business department" roles
(sales, purchase, hr, accounts, inventory) that used to be auto-seeded on
every fresh install. The role catalog is now fully admin-managed: only
super_admin, admin, and user are seeded by the application, and every other
role is created, edited, and deleted entirely through the Roles &
Permissions UI (/rbac/roles CRUD).

Any user currently assigned one of these legacy roles keeps their other
role assignments (most users also carry the base "user" role); they simply
lose the removed role's grants until an admin assigns them a replacement
role or direct permission override from the UI.

Revision ID: k5l6m7n8o9p0
Revises: j4k5l6m7n8o9
Create Date: 2026-08-06 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'k5l6m7n8o9p0'
down_revision = 'j4k5l6m7n8o9'
branch_labels = None
depends_on = None

LEGACY_BUSINESS_ROLE_NAMES = ("sales", "purchase", "hr", "accounts", "inventory")


def upgrade() -> None:
    """Delete the legacy hardcoded business roles (and their links) if present."""
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table("roles"):
        return

    roles_table = sa.table("roles", sa.column("id"), sa.column("name"), sa.column("is_system"))
    result = bind.execute(
        sa.select(roles_table.c.id).where(
            roles_table.c.name.in_(LEGACY_BUSINESS_ROLE_NAMES),
            roles_table.c.is_system.is_(False),
        )
    )
    role_ids = [row[0] for row in result.fetchall()]
    if not role_ids:
        return

    if insp.has_table("user_roles"):
        user_roles_table = sa.table("user_roles", sa.column("role_id"))
        op.execute(user_roles_table.delete().where(user_roles_table.c.role_id.in_(role_ids)))

    if insp.has_table("role_permissions"):
        role_permissions_table = sa.table("role_permissions", sa.column("role_id"))
        op.execute(role_permissions_table.delete().where(role_permissions_table.c.role_id.in_(role_ids)))

    op.execute(roles_table.delete().where(roles_table.c.id.in_(role_ids)))


def downgrade() -> None:
    """No-op: legacy hardcoded business roles are intentionally not restored."""
    pass
