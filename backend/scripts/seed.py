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

# --- Bootstrap permission set (Module -> Page -> Action -> Scope hierarchy) ---
BOOTSTRAP_PERMISSIONS: list[tuple[str, str, str, str, str, str]] = [
    # (code, module, page, action, scope, description)
    # Users & Teams
    ("user.create", "user", "teams", "create", "ALL", "Create user accounts."),
    ("user.read", "user", "teams", "view", "ALL", "View user accounts."),
    ("user.view", "user", "teams", "view", "ALL", "View user accounts."),
    ("user.update", "user", "teams", "update", "ALL", "Update, activate/deactivate, unlock, and reset passwords for users."),
    ("user.delete", "user", "teams", "delete", "ALL", "Delete user accounts."),
    ("user.export", "user", "teams", "export", "ALL", "Export user accounts data."),
    ("user.import", "user", "teams", "import", "ALL", "Import user accounts data."),
    # Employees
    ("employee.create", "employee", "teams", "create", "ALL", "Create employee records."),
    ("employee.read", "employee", "teams", "view", "ALL", "View employee records."),
    ("employee.view", "employee", "teams", "view", "ALL", "View employee records."),
    ("employee.update", "employee", "teams", "update", "ALL", "Update, transfer, deactivate/reactivate employee records."),
    ("employee.delete", "employee", "teams", "delete", "ALL", "Delete employee records."),
    ("employee.export", "employee", "teams", "export", "ALL", "Export employee records."),
    ("employee.import", "employee", "teams", "import", "ALL", "Import employee records."),
    ("employee.approve", "employee", "teams", "approve", "ALL", "Approve employee applications or changes."),
    # Departments & Designations
    ("department.create", "department", "teams", "create", "ALL", "Create departments."),
    ("department.read", "department", "teams", "view", "ALL", "View departments."),
    ("department.view", "department", "teams", "view", "ALL", "View departments."),
    ("department.update", "department", "teams", "update", "ALL", "Update departments."),
    ("department.delete", "department", "teams", "delete", "ALL", "Delete departments."),
    ("designation.create", "designation", "teams", "create", "ALL", "Create designations."),
    ("designation.read", "designation", "teams", "view", "ALL", "View designations."),
    ("designation.view", "designation", "teams", "view", "ALL", "View designations."),
    ("designation.update", "designation", "teams", "update", "ALL", "Update designations."),
    ("designation.delete", "designation", "teams", "delete", "ALL", "Delete designations."),
    # Organization Settings (Super Admin system-level)
    ("organization.manage", "organization", "organization", "manage", "ALL", "View and manage system organization profile."),
    # Suppliers
    ("supplier.create", "supplier", "suppliers", "create", "ALL", "Create suppliers and add supplier contacts."),
    ("supplier.read", "supplier", "suppliers", "view", "ALL", "View suppliers and their contacts."),
    ("supplier.view", "supplier", "suppliers", "view", "ALL", "View suppliers and their contacts."),
    ("supplier.update", "supplier", "suppliers", "update", "ALL", "Update, activate/deactivate suppliers; update grade/potential; edit contacts."),
    ("supplier.delete", "supplier", "suppliers", "delete", "ALL", "Delete suppliers and remove supplier contacts."),
    ("supplier.export", "supplier", "suppliers", "export", "ALL", "Export supplier data."),
    ("supplier.import", "supplier", "suppliers", "import", "ALL", "Import supplier data."),
    # Master Data Configurations
    ("country.create", "country", "masters-countries", "create", "ALL", "Create countries."),
    ("country.read", "country", "masters-countries", "view", "ALL", "View countries."),
    ("country.view", "country", "masters-countries", "view", "ALL", "View countries."),
    ("country.update", "country", "masters-countries", "update", "ALL", "Update countries."),
    ("country.delete", "country", "masters-countries", "delete", "ALL", "Delete countries."),
    ("state.create", "state", "masters-states", "create", "ALL", "Create states."),
    ("state.read", "state", "masters-states", "view", "ALL", "View states."),
    ("state.view", "state", "masters-states", "view", "ALL", "View states."),
    ("state.update", "state", "masters-states", "update", "ALL", "Update states."),
    ("state.delete", "state", "masters-states", "delete", "ALL", "Delete states."),
    ("city.create", "city", "masters-cities", "create", "ALL", "Create cities."),
    ("city.read", "city", "masters-cities", "view", "ALL", "View cities."),
    ("city.view", "city", "masters-cities", "view", "ALL", "View cities."),
    ("city.update", "city", "masters-cities", "update", "ALL", "Update cities."),
    ("city.delete", "city", "masters-cities", "delete", "ALL", "Delete cities."),
    ("currency.create", "currency", "masters-currencies", "create", "ALL", "Create currencies."),
    ("currency.read", "currency", "masters-currencies", "view", "ALL", "View currencies."),
    ("currency.view", "currency", "masters-currencies", "view", "ALL", "View currencies."),
    ("currency.update", "currency", "masters-currencies", "update", "ALL", "Update currencies."),
    ("currency.delete", "currency", "masters-currencies", "delete", "ALL", "Delete currencies."),
    ("uom.create", "uom", "masters-uom", "create", "ALL", "Create units of measurement."),
    ("uom.read", "uom", "masters-uom", "view", "ALL", "View units of measurement."),
    ("uom.view", "uom", "masters-uom", "view", "ALL", "View units of measurement."),
    ("uom.update", "uom", "masters-uom", "update", "ALL", "Update units of measurement."),
    ("uom.delete", "uom", "masters-uom", "delete", "ALL", "Delete units of measurement."),
    ("hsn.create", "hsn", "masters-hsn", "create", "ALL", "Create HSN codes."),
    ("hsn.read", "hsn", "masters-hsn", "view", "ALL", "View HSN codes."),
    ("hsn.view", "hsn", "masters-hsn", "view", "ALL", "View HSN codes."),
    ("hsn.update", "hsn", "masters-hsn", "update", "ALL", "Update HSN codes."),
    ("hsn.delete", "hsn", "masters-hsn", "delete", "ALL", "Delete HSN codes."),
    ("brand.create", "brand", "masters-brands", "create", "ALL", "Create brands."),
    ("brand.read", "brand", "masters-brands", "view", "ALL", "View brands."),
    ("brand.view", "brand", "masters-brands", "view", "ALL", "View brands."),
    ("brand.update", "brand", "masters-brands", "update", "ALL", "Update brands."),
    ("brand.delete", "brand", "masters-brands", "delete", "ALL", "Delete brands."),
    ("masters.brand.create", "brand", "masters-brands", "create", "ALL", "Create brands (hierarchical)."),
    ("masters.brand.view", "brand", "masters-brands", "view", "ALL", "View brands (hierarchical)."),
    ("category.create", "category", "masters-categories", "create", "ALL", "Create product categories."),
    ("category.read", "category", "masters-categories", "view", "ALL", "View product categories."),
    ("category.view", "category", "masters-categories", "view", "ALL", "View product categories."),
    ("category.update", "category", "masters-categories", "update", "ALL", "Update product categories."),
    ("category.delete", "category", "masters-categories", "delete", "ALL", "Delete product categories."),
    ("subcategory.create", "subcategory", "masters-subcategories", "create", "ALL", "Create product sub-categories."),
    ("subcategory.read", "subcategory", "masters-subcategories", "view", "ALL", "View product sub-categories."),
    ("subcategory.view", "subcategory", "masters-subcategories", "view", "ALL", "View product sub-categories."),
    ("subcategory.update", "subcategory", "masters-subcategories", "update", "ALL", "Update product sub-categories."),
    ("subcategory.delete", "subcategory", "masters-subcategories", "delete", "ALL", "Delete product sub-categories."),
    # Product & Masters Management
    ("product.create", "product", "masters-products", "create", "ALL", "Create products."),
    ("product.read", "product", "masters-products", "view", "ALL", "View products."),
    ("product.view", "product", "masters-products", "view", "ALL", "View products."),
    ("product.update", "product", "masters-products", "update", "ALL", "Update products."),
    ("product.delete", "product", "masters-products", "delete", "ALL", "Delete products."),
    ("product.export", "product", "masters-products", "export", "ALL", "Export product records."),
    ("product.import", "product", "masters-products", "import", "ALL", "Import product records."),
    ("product.approve", "product", "masters-products", "approve", "ALL", "Approve product listings."),
    ("product.print", "product", "masters-products", "print", "ALL", "Print product details."),
    ("masters.product.view", "product", "masters-products", "view", "ALL", "View products (hierarchical)."),
    ("masters.product.manage", "product", "masters-products", "manage", "ALL", "Manage product catalog."),
    # Inventory & Reports
    ("inventory.create", "inventory", "inventory", "create", "ALL", "Create inventory records."),
    ("inventory.read", "inventory", "inventory", "view", "ALL", "View inventory records."),
    ("inventory.view", "inventory", "inventory", "view", "ALL", "View inventory records."),
    ("inventory.update", "inventory", "inventory", "update", "ALL", "Update inventory records."),
    ("inventory.delete", "inventory", "inventory", "delete", "ALL", "Delete inventory records."),
    ("inventory.approve", "inventory", "inventory", "approve", "ALL", "Approve inventory adjustments and transfers."),
    ("inventory.export", "inventory", "inventory", "export", "ALL", "Export inventory data."),
    ("inventory.import", "inventory", "inventory", "import", "ALL", "Import inventory data."),
    ("inventory.print", "inventory", "inventory", "print", "ALL", "Print inventory tags/reports."),
    ("inventory.manage", "inventory", "inventory", "manage", "ALL", "Manage inventory control."),
    ("crm.view", "crm", "crm", "view", "ALL", "View CRM data."),
    ("reports.read", "reports", "reports", "view", "ALL", "View system reports."),
    ("reports.view", "reports", "reports", "view", "ALL", "View system reports."),
    ("reports.export", "reports", "reports", "export", "ALL", "Export reports."),
    ("reports.print", "reports", "reports", "print", "ALL", "Print system reports."),
    # Tasks & Work Management
    ("task.create", "task", "tasks", "create", "ALL", "Create tasks."),
    ("task.read", "task", "tasks", "view", "ALL", "View tasks."),
    ("task.view", "task", "tasks", "view", "ALL", "View tasks."),
    ("task.update", "task", "tasks", "update", "ALL", "Update and reassign tasks."),
    ("task.delete", "task", "tasks", "delete", "ALL", "Delete tasks."),
    # Settings, Audit & System
    ("settings.manage", "settings", "rbac", "manage", "ALL", "Manage system settings, roles, and permissions."),
    ("audit.read", "audit", "audit", "view", "ALL", "View audit log entries."),
    ("audit.view", "audit", "audit", "view", "ALL", "View audit log entries."),
    ("queue.read", "queue", "queue", "view", "ALL", "View background queue status."),
    ("queue.manage", "queue", "queue", "manage", "ALL", "Manage background job queues."),
    ("cache.read", "cache", "cache", "view", "ALL", "View cache status."),
    ("cache.manage", "cache", "cache", "manage", "ALL", "Manage system cache."),
]

SUPER_ADMIN_ROLE_NAME = "super_admin"
EMPLOYEE_ROLE_NAME = "employee"

DEFAULT_BUSINESS_ROLES = [
    ("sales", "Sales Department Role for Managing Clients, Inquiries, and Suppliers.", [
        "supplier.view", "supplier.create", "product.view", "brand.view", "category.view", "subcategory.view"
    ]),
    ("purchase", "Purchase Department Role for Supplier Management and Procurement.", [
        "supplier.view", "supplier.create", "supplier.update", "supplier.export", "supplier.import", "product.view", "uom.view", "hsn.view"
    ]),
    ("hr", "Human Resources Department Role for Employee and Team Management.", [
        "employee.view", "employee.create", "employee.update", "employee.export", "employee.import", "employee.approve", "department.view", "department.create", "department.update", "designation.view", "designation.create", "designation.update", "user.view"
    ]),
    ("accounts", "Accounts & Finance Role for Tax, Currencies, and Financial Reports.", [
        "currency.view", "currency.create", "currency.update", "hsn.view", "hsn.create", "hsn.update", "supplier.view", "reports.view", "reports.export"
    ]),
    ("inventory", "Inventory & Warehouse Management Role.", [
        "inventory.view", "inventory.create", "inventory.update", "inventory.approve", "inventory.export", "inventory.import", "product.view", "product.create", "product.update", "uom.view", "category.view", "subcategory.view"
    ]),
]

EMPLOYEE_ROLE_PERMISSION_CODES: list[str] = [
    "employee.read",
    "employee.view",
    "department.read",
    "department.view",
    "designation.read",
    "designation.view",
    "country.read",
    "country.view",
    "state.read",
    "state.view",
    "city.read",
    "city.view",
    "currency.read",
    "currency.view",
    "uom.read",
    "uom.view",
    "hsn.read",
    "hsn.view",
    "brand.read",
    "brand.view",
    "category.read",
    "category.view",
    "subcategory.read",
    "subcategory.view",
    "product.read",
    "product.view",
    "supplier.read",
    "supplier.view",
    "task.read",
    "task.view",
    "task.create",
    "task.update",
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
        for code, module, page, action, scope, description in BOOTSTRAP_PERMISSIONS:
            existing = await permission_repo.get_by_code(code)
            if existing is not None:
                if existing.page != page or existing.action != action or existing.scope != scope:
                    existing.page = page
                    existing.action = action
                    existing.scope = scope
                    await session.flush()
                created_permissions.append(existing)
                continue
            permission = await permission_repo.create(
                code=code,
                module=module,
                page=page,
                action=action,
                scope=scope,
                description=description,
            )
            created_permissions.append(permission)
            logger.info("Seeded permission.", extra={"code": code})

        # --- 2. System roles -----------------------------------------------------------
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

        admin_role = await role_repo.get_by_name("admin")
        if admin_role is None:
            admin_role = await role_repo.create(
                name="admin",
                description="Administrator system role with full management privileges.",
                is_system=True,
            )
            logger.info("Seeded role.", extra={"role_name": "admin"})
            for permission in created_permissions:
                session.add(RolePermission(role_id=admin_role.id, permission_id=permission.id))
            await session.flush()
        else:
            for permission in created_permissions:
                await role_repo.add_permission(admin_role, permission)

        for r_name, r_desc, r_perms in DEFAULT_BUSINESS_ROLES:
            b_role = await role_repo.get_by_name(r_name)
            if b_role is None:
                b_role = await role_repo.create(
                    name=r_name,
                    description=r_desc,
                    is_system=False,
                )
                logger.info("Seeded business role.", extra={"role_name": r_name})
                for code in r_perms:
                    permission = await permission_repo.get_by_code(code)
                    if permission:
                        session.add(RolePermission(role_id=b_role.id, permission_id=permission.id))
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