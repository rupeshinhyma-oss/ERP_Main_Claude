"""
Phase 2 Bootstrap / Seed Script.

Populates the database with the minimum data needed to log in and start
administering the system through the API itself:

1. The example permission set from the Phase 2 spec (``user.create``,
   ``employee.read``, etc.).
2. A ``super_admin`` system role (protected from deletion/rename) granted
   every permission.
3. A bootstrap admin user (credentials from ``settings.BOOTSTRAP_ADMIN_*``)
   assigned the ``super_admin`` role.

Idempotent: safe to run multiple times. Existing permissions/roles/the
admin user are left untouched (looked up by their unique code/name/username
and skipped if already present) rather than duplicated or overwritten.

Usage:
    python -m scripts.seed
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from app.auth.security import hash_password
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.database.engine import dispose_engine, get_sessionmaker
from app.rbac.models import Permission, Role, RolePermission
from app.rbac.repository import PermissionRepository, RoleRepository
from app.users.models import User, UserStatus
from app.users.repository import UserRepository

logger = get_logger(__name__)

# --- Bootstrap permission set (module.action convention, per the Phase 2 spec) ---
BOOTSTRAP_PERMISSIONS: list[tuple[str, str, str]] = [
    # (code, module, description)
    ("user.create", "user", "Create user accounts."),
    ("user.read", "user", "View user accounts."),
    ("user.update", "user", "Update, activate/deactivate, unlock, and reset passwords for users."),
    ("user.delete", "user", "Delete user accounts."),
    ("employee.create", "employee", "Create employee records."),
    ("employee.read", "employee", "View employee records."),
    ("employee.update", "employee", "Update, transfer, deactivate/reactivate employee records."),
    ("employee.delete", "employee", "Delete employee records."),
    ("department.create", "department", "Create departments."),
    ("department.read", "department", "View departments."),
    ("department.update", "department", "Update departments."),
    ("department.delete", "department", "Delete departments."),
    ("designation.create", "designation", "Create designations."),
    ("designation.read", "designation", "View designations."),
    ("designation.update", "designation", "Update designations."),
    ("designation.delete", "designation", "Delete designations."),
    ("organization.manage", "organization", "View and manage the single company profile."),
    ("inventory.create", "inventory", "Create inventory records."),
    ("inventory.update", "inventory", "Update inventory records."),
    ("crm.view", "crm", "View CRM data."),
    ("reports.export", "reports", "Export reports."),
    ("settings.manage", "settings", "Manage system settings, roles, and permissions."),
    ("audit.read", "audit", "View audit log entries."),
    # --- Master Data Management (Phase 7) ---
    ("country.create", "country", "Create countries."),
    ("country.read", "country", "View countries."),
    ("country.update", "country", "Update, activate/deactivate countries."),
    ("country.delete", "country", "Delete countries."),
    ("state.create", "state", "Create states."),
    ("state.read", "state", "View states."),
    ("state.update", "state", "Update, activate/deactivate states."),
    ("state.delete", "state", "Delete states."),
    ("city.create", "city", "Create cities."),
    ("city.read", "city", "View cities."),
    ("city.update", "city", "Update, activate/deactivate cities."),
    ("city.delete", "city", "Delete cities."),
    ("currency.create", "currency", "Create currencies."),
    ("currency.read", "currency", "View currencies."),
    ("currency.update", "currency", "Update, activate/deactivate currencies."),
    ("currency.delete", "currency", "Delete currencies."),
    ("uom.create", "uom", "Create units of measurement."),
    ("uom.read", "uom", "View units of measurement."),
    ("uom.update", "uom", "Update, activate/deactivate units of measurement."),
    ("uom.delete", "uom", "Delete units of measurement."),
    ("hsn.create", "hsn", "Create HSN codes."),
    ("hsn.read", "hsn", "View HSN codes."),
    ("hsn.update", "hsn", "Update, activate/deactivate HSN codes."),
    ("hsn.delete", "hsn", "Delete HSN codes."),
    ("brand.create", "brand", "Create brands."),
    ("brand.read", "brand", "View brands."),
    ("brand.update", "brand", "Update, activate/deactivate brands."),
    ("brand.delete", "brand", "Delete brands."),
    ("category.create", "category", "Create product categories."),
    ("category.read", "category", "View product categories."),
    ("category.update", "category", "Update, activate/deactivate product categories."),
    ("category.delete", "category", "Delete product categories."),
    ("subcategory.create", "subcategory", "Create product sub-categories."),
    ("subcategory.read", "subcategory", "View product sub-categories."),
    ("subcategory.update", "subcategory", "Update, activate/deactivate product sub-categories."),
    ("subcategory.delete", "subcategory", "Delete product sub-categories."),
    ("product.create", "product", "Create products."),
    ("product.read", "product", "View products."),
    ("product.update", "product", "Update, activate/deactivate products."),
    ("product.delete", "product", "Delete products."),
    # --- Supplier Management (Phase 8) ---
    ("supplier.create", "supplier", "Create suppliers and add supplier contacts."),
    ("supplier.read", "supplier", "View suppliers and their contacts."),
    ("supplier.update", "supplier", "Update, activate/deactivate suppliers; update grade/potential; edit contacts."),
    ("supplier.delete", "supplier", "Delete suppliers and remove supplier contacts."),
]

SUPER_ADMIN_ROLE_NAME = "super_admin"
EMPLOYEE_ROLE_NAME = "employee"

# Default permission set for a regular team member created via the Teams
# "Add Member" flow: enough to use the day-to-day parts of the ERP, with
# NO access to user/role/settings/audit management. In particular,
# "audit.read" is deliberately excluded so that only super_admin (or any
# other role an admin explicitly grants it to) can view the Audit Log --
# satisfying "only admin can see audit logs" through the existing
# permission system rather than a hardcoded role-name check.
EMPLOYEE_ROLE_PERMISSION_CODES: list[str] = [
    "employee.read",
    "department.read",
    "designation.read",
    "country.read",
    "state.read",
    "city.read",
    "currency.read",
    "uom.read",
    "hsn.read",
    "brand.read",
    "category.read",
    "subcategory.read",
    "product.read",
    "supplier.read",
]


async def seed() -> None:
    """Run the idempotent bootstrap seed."""
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        permission_repo = PermissionRepository(session)
        role_repo = RoleRepository(session)
        user_repo = UserRepository(session)

        # --- 1. Permissions --------------------------------------------------------
        created_permissions: list[Permission] = []
        for code, module, description in BOOTSTRAP_PERMISSIONS:
            existing = await permission_repo.get_by_code(code)
            if existing is not None:
                created_permissions.append(existing)
                continue
            permission = await permission_repo.create(code=code, module=module, description=description)
            created_permissions.append(permission)
            logger.info("Seeded permission.", extra={"code": code})

        # --- 2. super_admin role, granted every permission -----------------------------
        role = await role_repo.get_by_name(SUPER_ADMIN_ROLE_NAME)
        if role is None:
            role = await role_repo.create(
                name=SUPER_ADMIN_ROLE_NAME,
                description="Full-access system administrator role. Cannot be deleted or renamed.",
                is_system=True,
            )
            logger.info("Seeded role.", extra={"role_name": SUPER_ADMIN_ROLE_NAME})
            for permission in created_permissions:
                session.add(RolePermission(role_id=role.id, permission_id=permission.id))
            await session.flush()

        # --- 2b. employee role, granted a safe view-mostly permission subset -----------
        employee_role = await role_repo.get_by_name(EMPLOYEE_ROLE_NAME)
        if employee_role is None:
            employee_role = await role_repo.create(
                name=EMPLOYEE_ROLE_NAME,
                description=(
                    "Default role for team members added via the Teams 'Add Member' flow. "
                    "View-mostly access; no user/role/settings/audit-log access."
                ),
                is_system=True,
            )
            logger.info("Seeded role.", extra={"role_name": EMPLOYEE_ROLE_NAME})
            for code in EMPLOYEE_ROLE_PERMISSION_CODES:
                permission = await permission_repo.get_by_code(code)
                if permission is None:
                    logger.warning("Skipping unknown permission code for employee role.", extra={"code": code})
                    continue
                session.add(RolePermission(role_id=employee_role.id, permission_id=permission.id))
            await session.flush()

        # --- 3. Bootstrap admin user ----------------------------------------------------
        admin = await user_repo.get_by_username(settings.BOOTSTRAP_ADMIN_USERNAME)
        if admin is None:
            admin = await user_repo.create(
                username=settings.BOOTSTRAP_ADMIN_USERNAME,
                email=settings.BOOTSTRAP_ADMIN_EMAIL,
                password_hash=hash_password(settings.BOOTSTRAP_ADMIN_PASSWORD),
                status=UserStatus.ACTIVE,
                is_active=True,
                must_change_password=True,
                password_changed_at=datetime.now(timezone.utc),
            )
            from app.rbac.models import UserRole

            session.add(
                UserRole(user_id=admin.id, role_id=role.id, assigned_at=datetime.now(timezone.utc))
            )
            await session.flush()
            logger.info("Seeded bootstrap admin user.", extra={"username": settings.BOOTSTRAP_ADMIN_USERNAME})
        else:
            logger.info("Bootstrap admin user already exists; skipping.")

        await session.commit()

    await dispose_engine()
    print(
        "Seed complete.\n"
        f"  Admin username: {settings.BOOTSTRAP_ADMIN_USERNAME}\n"
        f"  Admin password: {settings.BOOTSTRAP_ADMIN_PASSWORD} (change immediately -- "
        "must_change_password is set)\n"
    )


if __name__ == "__main__":
    asyncio.run(seed())