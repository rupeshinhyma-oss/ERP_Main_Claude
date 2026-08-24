"""add buyer currentstatus, potential, and clientgrade permissions

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-08-24 00:00:00.000000

Adds the 3 field-level permissions for Agents & Buyers:
- ``buyer.currentstatus``: Edit Current Status dropdown
- ``buyer.potential``: Edit Potential dropdown
- ``buyer.clientgrade``: Edit Client Grade dropdown
"""
from datetime import datetime, timezone
import uuid
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision = 'f6a7b8c9d0e1'
down_revision = 'e5f6a7b8c9d0'
branch_labels = None
depends_on = None

NEW_PERMISSIONS = [
    (
        "buyer.currentstatus",
        "buyer",
        "buyers",
        "update",
        "ALL",
        "Edit the Current Status dropdown in the buyer list and edit form (read-only without this).",
    ),
    (
        "buyer.potential",
        "buyer",
        "buyers",
        "update",
        "ALL",
        "Edit the Potential dropdown in the buyer list and edit form (read-only without this).",
    ),
    (
        "buyer.clientgrade",
        "buyer",
        "buyers",
        "update",
        "ALL",
        "Edit the Client Grade dropdown in the buyer list and edit form (read-only without this).",
    ),
]


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)

    if not insp.has_table('permissions'):
        return

    now = datetime.now(timezone.utc)

    # 1. Fetch super_admin role id
    super_admin_role_id = None
    if insp.has_table('roles'):
        role_row = bind.execute(
            sa.text("SELECT id FROM roles WHERE name = 'super_admin' AND deleted_at IS NULL LIMIT 1")
        ).fetchone()
        if role_row:
            super_admin_role_id = role_row[0]

    # 2. Insert missing permissions and link to super_admin
    for code, module, page, action, scope, desc in NEW_PERMISSIONS:
        perm_row = bind.execute(
            sa.text("SELECT id FROM permissions WHERE code = :code"),
            {"code": code},
        ).fetchone()

        if perm_row:
            perm_id = perm_row[0]
        else:
            perm_id = uuid.uuid4()
            bind.execute(
                sa.text(
                    "INSERT INTO permissions (id, code, module, page, action, scope, description, created_at, updated_at) "
                    "VALUES (:id, :code, :module, :page, :action, :scope, :description, :created_at, :updated_at)"
                ),
                {
                    "id": perm_id,
                    "code": code,
                    "module": module,
                    "page": page,
                    "action": action,
                    "scope": scope,
                    "description": desc,
                    "created_at": now,
                    "updated_at": now,
                },
            )

        if super_admin_role_id and insp.has_table('role_permissions'):
            link_exists = bind.execute(
                sa.text(
                    "SELECT 1 FROM role_permissions WHERE role_id = :role_id AND permission_id = :perm_id"
                ),
                {"role_id": super_admin_role_id, "perm_id": perm_id},
            ).fetchone()
            if not link_exists:
                bind.execute(
                    sa.text(
                        "INSERT INTO role_permissions (id, role_id, permission_id, granted_at) "
                        "VALUES (:id, :role_id, :perm_id, :granted_at)"
                    ),
                    {
                        "id": uuid.uuid4(),
                        "role_id": super_admin_role_id,
                        "perm_id": perm_id,
                        "granted_at": now,
                    },
                )


def downgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)

    if insp.has_table('role_permissions') and insp.has_table('permissions'):
        bind.execute(
            sa.text(
                "DELETE FROM role_permissions WHERE permission_id IN ("
                "  SELECT id FROM permissions WHERE code IN ('buyer.currentstatus', 'buyer.potential', 'buyer.clientgrade')"
                ")"
            )
        )
    if insp.has_table('permissions'):
        bind.execute(
            sa.text(
                "DELETE FROM permissions WHERE code IN ('buyer.currentstatus', 'buyer.potential', 'buyer.clientgrade')"
            )
        )
