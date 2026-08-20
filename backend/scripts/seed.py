"""
Bootstrap / Seed Script.

Populates the database with the minimum data needed to log in and start
administering the system through the API itself:

1. The full permission set (``user.create``, ``inventory.read``, etc.).
2. Exactly two system roles:
     - ``super_admin`` (displayed to users as "Admin") -- full access to
       every permission in the system. This role is reserved for the single
       hardcoded bootstrap admin account (``settings.BOOTSTRAP_ADMIN_USERNAME``)
       and is protected from deletion/rename. No one else should ever be
       assigned this role through the normal "assign role" API (see
       ``app.rbac.service.RBACService`` / ``app.users.service.UserService``
       for the enforcement of this rule).
     - ``user`` -- the default, low-privilege role automatically assigned to
       every other newly-created account, granting basic read access.
3. A bootstrap admin user (credentials from ``settings.BOOTSTRAP_ADMIN_*``)
   assigned the ``super_admin`` role.

The previous version of this script also seeded a duplicate, fully-
privileged ``admin`` role plus a set of hardcoded per-department business
roles (sales/purchase/hr/accounts/inventory/logistics). Those have been
removed: they duplicated ``super_admin``'s access (in the case of
``admin``) or encoded assumptions about the organization's department
structure that don't belong in a generic seed script. Use the Roles &
Permissions screen to create whatever custom roles your organization
actually needs.

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
    # Users
    ("user.create", "user", "users", "create", "ALL", "Create user accounts."),
    ("user.view", "user", "users", "view", "ALL", "View user accounts."),
    ("user.update", "user", "users", "update", "ALL", "Update, activate/deactivate, unlock, and reset passwords for users."),
    ("user.delete", "user", "users", "delete", "ALL", "Delete user accounts."),
    ("user.export", "user", "users", "export", "ALL", "Export user accounts data."),
    ("user.import", "user", "users", "import", "ALL", "Import user accounts data."),
    # Organization Settings (Super Admin system-level)
    ("organization.manage", "organization", "organization", "manage", "ALL", "View and manage system organization profile."),
    # Suppliers
    ("supplier.view", "supplier", "suppliers", "view", "ALL", "View the supplier list and contacts; use search, filters, and the Active/Inactive tabs."),
    ("supplier.create", "supplier", "suppliers", "create", "ALL", "Create suppliers via Quick Add or Add New, and add supplier contacts."),
    ("supplier.update", "supplier", "suppliers", "update", "ALL", "Edit suppliers (Action > Edit), activate/deactivate, and edit contacts."),
    ("supplier.delete", "supplier", "suppliers", "delete", "ALL", "Delete suppliers (Action > Delete) and remove supplier contacts."),
    ("supplier.export", "supplier", "suppliers", "export", "ALL", "Export supplier data."),
    ("supplier.import", "supplier", "suppliers", "import", "ALL", "Import supplier data."),
    ("supplier.bulk_action", "supplier", "suppliers", "manage", "ALL", "Use Bulk Actions (bulk activate, deactivate, or delete) in the supplier list."),
    ("supplier.grade_edit", "supplier", "suppliers", "update", "ALL", "Edit the Grade dropdown in the supplier list (read-only without this)."),
    ("supplier.potential_edit", "supplier", "suppliers", "update", "ALL", "Edit the Potential dropdown in the supplier list (read-only without this)."),
    # Supplier Types (Configurations master; independent of the Suppliers module above)
    ("suppliertype.view", "suppliertype", "supplier-types", "view", "ALL", "View supplier types; use search, filters, and the Active/Inactive tabs."),
    ("suppliertype.create", "suppliertype", "supplier-types", "create", "ALL", "Create supplier types."),
    ("suppliertype.update", "suppliertype", "supplier-types", "update", "ALL", "Edit and activate/deactivate supplier types."),
    ("suppliertype.delete", "suppliertype", "supplier-types", "delete", "ALL", "Delete supplier types."),
    ("suppliertype.export", "suppliertype", "supplier-types", "export", "ALL", "Export supplier type data."),
    ("suppliertype.import", "suppliertype", "supplier-types", "import", "ALL", "Import supplier type data."),
    ("suppliertype.bulk_action", "suppliertype", "supplier-types", "manage", "ALL", "Use Bulk Actions in the supplier type list."),
    # Buyers (Clients)
    ("buyer.view", "buyer", "buyers", "view", "ALL", "View the buyer list and contacts; use search, filters, and the Active/Inactive tabs."),
    ("buyer.create", "buyer", "buyers", "create", "ALL", "Create buyers via Add New Buyer, and add buyer contacts."),
    ("buyer.update", "buyer", "buyers", "update", "ALL", "Edit buyers (Action > Edit), including grade/potential; activate/deactivate; edit contacts."),
    ("buyer.delete", "buyer", "buyers", "delete", "ALL", "Delete buyers (Action > Delete) and remove buyer contacts."),
    ("buyer.export", "buyer", "buyers", "export", "ALL", "Export buyer data."),
    ("buyer.import", "buyer", "buyers", "import", "ALL", "Import buyer data."),
    ("buyer.bulk_action", "buyer", "buyers", "manage", "ALL", "Use Bulk Actions (bulk activate, deactivate, or delete) in the buyer list."),
    # Buyer Types (Configurations master; independent of the Buyers module above)
    ("buyertype.view", "buyertype", "buyer-types", "view", "ALL", "View buyer types; use search, filters, and the Active/Inactive tabs."),
    ("buyertype.create", "buyertype", "buyer-types", "create", "ALL", "Create buyer types."),
    ("buyertype.update", "buyertype", "buyer-types", "update", "ALL", "Edit and activate/deactivate buyer types."),
    ("buyertype.delete", "buyertype", "buyer-types", "delete", "ALL", "Delete buyer types."),
    ("buyertype.export", "buyertype", "buyer-types", "export", "ALL", "Export buyer type data."),
    ("buyertype.import", "buyertype", "buyer-types", "import", "ALL", "Import buyer type data."),
    ("buyertype.bulk_action", "buyertype", "buyer-types", "manage", "ALL", "Use Bulk Actions in the buyer type list."),
    # Master Data Configurations
    ("country.view", "country", "masters-countries", "view", "ALL", "View countries."),
    ("country.create", "country", "masters-countries", "create", "ALL", "Create countries."),
    ("country.update", "country", "masters-countries", "update", "ALL", "Update countries."),
    ("country.delete", "country", "masters-countries", "delete", "ALL", "Delete countries."),
    ("country.export", "country", "masters-countries", "export", "ALL", "Export country data."),
    ("country.import", "country", "masters-countries", "import", "ALL", "Import country data."),
    ("country.bulk_action", "country", "masters-countries", "manage", "ALL", "Use Bulk Actions in the country list."),
    ("state.view", "state", "masters-states", "view", "ALL", "View states."),
    ("state.create", "state", "masters-states", "create", "ALL", "Create states."),
    ("state.update", "state", "masters-states", "update", "ALL", "Update states."),
    ("state.delete", "state", "masters-states", "delete", "ALL", "Delete states."),
    ("state.export", "state", "masters-states", "export", "ALL", "Export state data."),
    ("state.import", "state", "masters-states", "import", "ALL", "Import state data."),
    ("state.bulk_action", "state", "masters-states", "manage", "ALL", "Use Bulk Actions in the state list."),
    ("city.view", "city", "masters-cities", "view", "ALL", "View cities."),
    ("city.create", "city", "masters-cities", "create", "ALL", "Create cities."),
    ("city.update", "city", "masters-cities", "update", "ALL", "Update cities."),
    ("city.delete", "city", "masters-cities", "delete", "ALL", "Delete cities."),
    ("city.export", "city", "masters-cities", "export", "ALL", "Export city data."),
    ("city.import", "city", "masters-cities", "import", "ALL", "Import city data."),
    ("city.bulk_action", "city", "masters-cities", "manage", "ALL", "Use Bulk Actions in the city list."),
    ("currency.view", "currency", "masters-currencies", "view", "ALL", "View currencies."),
    ("currency.create", "currency", "masters-currencies", "create", "ALL", "Create currencies."),
    ("currency.update", "currency", "masters-currencies", "update", "ALL", "Update currencies."),
    ("currency.delete", "currency", "masters-currencies", "delete", "ALL", "Delete currencies."),
    ("currency.export", "currency", "masters-currencies", "export", "ALL", "Export currency data."),
    ("currency.import", "currency", "masters-currencies", "import", "ALL", "Import currency data."),
    ("currency.bulk_action", "currency", "masters-currencies", "manage", "ALL", "Use Bulk Actions in the currency list."),
    ("uom.view", "uom", "masters-uom", "view", "ALL", "View units of measurement."),
    ("uom.create", "uom", "masters-uom", "create", "ALL", "Create units of measurement."),
    ("uom.update", "uom", "masters-uom", "update", "ALL", "Update units of measurement."),
    ("uom.delete", "uom", "masters-uom", "delete", "ALL", "Delete units of measurement."),
    ("uom.export", "uom", "masters-uom", "export", "ALL", "Export unit of measurement data."),
    ("uom.import", "uom", "masters-uom", "import", "ALL", "Import unit of measurement data."),
    ("uom.bulk_action", "uom", "masters-uom", "manage", "ALL", "Use Bulk Actions in the unit of measurement list."),
    ("hsn.view", "hsn", "masters-hsn", "view", "ALL", "View HSN codes."),
    ("hsn.create", "hsn", "masters-hsn", "create", "ALL", "Create HSN codes."),
    ("hsn.update", "hsn", "masters-hsn", "update", "ALL", "Update HSN codes."),
    ("hsn.delete", "hsn", "masters-hsn", "delete", "ALL", "Delete HSN codes."),
    ("hsn.export", "hsn", "masters-hsn", "export", "ALL", "Export HSN code data."),
    ("hsn.import", "hsn", "masters-hsn", "import", "ALL", "Import HSN code data."),
    ("hsn.bulk_action", "hsn", "masters-hsn", "manage", "ALL", "Use Bulk Actions in the HSN code list."),
    ("brand.view", "brand", "masters-brands", "view", "ALL", "View brands; use search, filters, and the Active/Inactive tabs."),
    ("brand.create", "brand", "masters-brands", "create", "ALL", "Create brands."),
    ("brand.update", "brand", "masters-brands", "update", "ALL", "Edit and activate/deactivate brands."),
    ("brand.delete", "brand", "masters-brands", "delete", "ALL", "Delete brands."),
    ("brand.export", "brand", "masters-brands", "export", "ALL", "Export brand data."),
    ("brand.import", "brand", "masters-brands", "import", "ALL", "Import brand data."),
    ("brand.bulk_action", "brand", "masters-brands", "manage", "ALL", "Use Bulk Actions in the brand list."),
    ("category.view", "category", "masters-categories", "view", "ALL", "View product categories; use search, filters, and the Active/Inactive tabs."),
    ("category.create", "category", "masters-categories", "create", "ALL", "Create product categories."),
    ("category.update", "category", "masters-categories", "update", "ALL", "Edit and activate/deactivate product categories."),
    ("category.delete", "category", "masters-categories", "delete", "ALL", "Delete product categories."),
    ("category.export", "category", "masters-categories", "export", "ALL", "Export product category data."),
    ("category.import", "category", "masters-categories", "import", "ALL", "Import product category data."),
    ("category.bulk_action", "category", "masters-categories", "manage", "ALL", "Use Bulk Actions in the product category list."),
    ("subcategory.view", "subcategory", "masters-subcategories", "view", "ALL", "View product sub-categories; use search, filters, and the Active/Inactive tabs."),
    ("subcategory.create", "subcategory", "masters-subcategories", "create", "ALL", "Create product sub-categories."),
    ("subcategory.update", "subcategory", "masters-subcategories", "update", "ALL", "Edit and activate/deactivate product sub-categories."),
    ("subcategory.delete", "subcategory", "masters-subcategories", "delete", "ALL", "Delete product sub-categories."),
    ("subcategory.export", "subcategory", "masters-subcategories", "export", "ALL", "Export product sub-category data."),
    ("subcategory.import", "subcategory", "masters-subcategories", "import", "ALL", "Import product sub-category data."),
    ("subcategory.bulk_action", "subcategory", "masters-subcategories", "manage", "ALL", "Use Bulk Actions in the product sub-category list."),
    # Product & Masters Management
    ("product.view", "product", "masters-products", "view", "ALL", "View products (Product Master and Product Gallery); use search, filters, and the Active/Inactive tabs."),
    ("product.create", "product", "masters-products", "create", "ALL", "Create products."),
    ("product.update", "product", "masters-products", "update", "ALL", "Edit and activate/deactivate products."),
    ("product.delete", "product", "masters-products", "delete", "ALL", "Delete products."),
    ("product.export", "product", "masters-products", "export", "ALL", "Export product records."),
    ("product.import", "product", "masters-products", "import", "ALL", "Import product records."),
    ("product.bulk_action", "product", "masters-products", "manage", "ALL", "Use Bulk Actions in the Product Master list."),
    ("product.approve", "product", "masters-products", "approve", "ALL", "Approve product listings."),
    ("product.print", "product", "masters-products", "print", "ALL", "Print product details."),
    # Audit Log
    ("audit.view", "audit", "audit", "view", "ALL", "View audit log entries."),
    # Shipment Planning (dynamic branch-sheet grid: Mum Branch, MP Branch, ...)
    ("planning.view", "planning", "planning", "view", "ALL", "View planning sheets, grids, and change history."),
    ("planning.sheet.manage", "planning", "planning", "manage", "ALL", "Create, rename, and delete planning sheets (branch tabs); create custom status tags."),
    ("planning.column.manage", "planning", "planning", "manage", "ALL", "Add, rename, move, and delete planning columns (unlimited, admin-named)."),
    ("planning.row.manage", "planning", "planning", "manage", "ALL", "Add, rename, move, and delete planning rows (unlimited)."),
    ("planning.cell.edit", "planning", "planning", "update", "ALL", "Edit the Mum group value cells and their Remarks cells, and set Blue/Custom status tags or clear a tag. Does not cover TEST(Y/N), APPROVAL DATE, or Red/Green status, which each have their own independent permission."),
    ("planning.textyn.edit", "planning", "planning", "update", "ALL", "Edit the TEST(Y/N) column specifically, independent of planning.cell.edit."),
    ("planning.approvaldate.edit", "planning", "planning", "update", "ALL", "Edit the APPROVAL DATE column specifically, independent of planning.cell.edit."),
    ("planning.colorstatusred.edit", "planning", "planning", "update", "ALL", "Set a cell's status color to Red (Requirement), independent of planning.cell.edit."),
    ("planning.colorstatusgreen.edit", "planning", "planning", "update", "ALL", "Set a cell's status color to Green (Purchased), independent of planning.cell.edit."),
]

SUPER_ADMIN_ROLE_NAME = "super_admin"
SUPER_ADMIN_DISPLAY_NAME = "Admin"
USER_ROLE_NAME = "user"

# The default role automatically assigned to every newly-created account
# (see app.users.service.UserService.create_user). Grants read-only/basic
# access to the modules any logged-in employee needs day to day; anything
# more privileged is granted explicitly by an administrator via the Roles &
# Permissions screen.
USER_ROLE_PERMISSION_CODES: list[str] = [
    "user.view",
    "country.view",
    "state.view",
    "city.view",
    "currency.view",
    "uom.view",
    "hsn.view",
    "brand.view",
    "category.view",
    "subcategory.view",
    "product.view",
    "supplier.view",
    "buyer.view",
    "planning.view",
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
        # Exactly two system roles are seeded: "super_admin" (shown to users as
        # "Admin" -- reserved for the single bootstrap admin account) and
        # "user" (the default role every other new account gets). Both are
        # marked is_system=True so they can't be deleted or renamed from the
        # Roles & Permissions screen.
        role = await role_repo.get_by_name(SUPER_ADMIN_ROLE_NAME, include_deleted=True)
        if role is None:
            role = await role_repo.create(
                name=SUPER_ADMIN_ROLE_NAME,
                description=(
                    "Full-access system administrator role, reserved for the single "
                    "hardcoded bootstrap admin account. Cannot be deleted, renamed, "
                    "or assigned to any other user."
                ),
                is_system=True,
            )
            logger.info("Seeded role.", extra={"role_name": SUPER_ADMIN_ROLE_NAME})
            for permission in created_permissions:
                session.add(RolePermission(role_id=role.id, permission_id=permission.id))
            await session.flush()
        else:
            if role.deleted_at is not None:
                role.deleted_at = None
                await session.flush()
            # Idempotent top-up: make sure any newly-added bootstrap permission
            # (e.g. organization.manage) is granted even if this role already existed.
            existing_codes = {link.permission.code for link in role.permission_links}
            for permission in created_permissions:
                if permission.code not in existing_codes:
                    await role_repo.add_permission(role, permission)

        user_role = await role_repo.get_by_name(USER_ROLE_NAME, include_deleted=True)
        if user_role is None:
            user_role = await role_repo.create(
                name=USER_ROLE_NAME,
                description=(
                    "Default role automatically assigned to every new user account. "
                    "Grants basic read access; additional permissions are granted "
                    "explicitly by an administrator."
                ),
                is_system=True,
            )
            logger.info("Seeded role.", extra={"role_name": USER_ROLE_NAME})
            for code in USER_ROLE_PERMISSION_CODES:
                permission = await permission_repo.get_by_code(code)
                if permission:
                    session.add(RolePermission(role_id=user_role.id, permission_id=permission.id))
            await session.flush()
        elif user_role.deleted_at is not None:
            user_role.deleted_at = None
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

        # Seed China provinces and major cities
        from scripts.seed_china_geo import seed_china
        await seed_china(session)

        await session.commit()

    await dispose_engine()
    print(
        "Seed complete.\n"
        f"  Admin username: {settings.BOOTSTRAP_ADMIN_USERNAME}\n"
        f"  Admin password: {settings.BOOTSTRAP_ADMIN_PASSWORD} (change immediately -- "
        "must_change_password is set)\n"
    )


async def _run_seed_with_retry(max_retries: int = 5, delay: float = 2.0) -> None:
    last_exc = None
    for attempt in range(1, max_retries + 1):
        try:
            await seed()
            return
        except Exception as exc:
            last_exc = exc
            if attempt < max_retries:
                logger.warning(
                    f"Seed connection attempt {attempt}/{max_retries} failed: {exc}. Retrying in {delay:.1f}s..."
                )
                await asyncio.sleep(delay)
                delay *= 1.5
            else:
                raise last_exc


if __name__ == "__main__":
    asyncio.run(_run_seed_with_retry())