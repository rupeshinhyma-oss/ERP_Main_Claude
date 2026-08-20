"""
Seed missing export, import, and bulk_action permissions for master data configurations:
- Countries (country.export, country.import, country.bulk_action)
- States / Provinces (state.export, state.import, state.bulk_action)
- Cities (city.export, city.import, city.bulk_action)
- Currencies (currency.export, currency.import, currency.bulk_action)
- Units of Measurement (uom.export, uom.import, uom.bulk_action)
- HSN Codes (hsn.export, hsn.import, hsn.bulk_action)

Grants these newly created permissions to existing roles that hold view/update for these modules.

Usage:
    python -m scripts.seed_missing_master_permissions
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.core.logging import configure_logging, get_logger
from app.database.engine import dispose_engine, get_sessionmaker
from app.rbac.models import Permission, Role, RolePermission
from app.rbac.repository import PermissionRepository, RoleRepository
from app.users.repository import UserRepository  # noqa: F401

logger = get_logger(__name__)

NEW_PERMISSIONS = [
    # (code, module, page, action, scope, description)
    ("country.export", "country", "masters-countries", "export", "ALL", "Export country data."),
    ("country.import", "country", "masters-countries", "import", "ALL", "Import country data."),
    ("country.bulk_action", "country", "masters-countries", "manage", "ALL", "Use Bulk Actions in the country list."),
    ("state.export", "state", "masters-states", "export", "ALL", "Export state data."),
    ("state.import", "state", "masters-states", "import", "ALL", "Import state data."),
    ("state.bulk_action", "state", "masters-states", "manage", "ALL", "Use Bulk Actions in the state list."),
    ("city.export", "city", "masters-cities", "export", "ALL", "Export city data."),
    ("city.import", "city", "masters-cities", "import", "ALL", "Import city data."),
    ("city.bulk_action", "city", "masters-cities", "manage", "ALL", "Use Bulk Actions in the city list."),
    ("currency.export", "currency", "masters-currencies", "export", "ALL", "Export currency data."),
    ("currency.import", "currency", "masters-currencies", "import", "ALL", "Import currency data."),
    ("currency.bulk_action", "currency", "masters-currencies", "manage", "ALL", "Use Bulk Actions in the currency list."),
    ("uom.export", "uom", "masters-uom", "export", "ALL", "Export unit of measurement data."),
    ("uom.import", "uom", "masters-uom", "import", "ALL", "Import unit of measurement data."),
    ("uom.bulk_action", "uom", "masters-uom", "manage", "ALL", "Use Bulk Actions in the unit of measurement list."),
    ("hsn.export", "hsn", "masters-hsn", "export", "ALL", "Export HSN code data."),
    ("hsn.import", "hsn", "masters-hsn", "import", "ALL", "Import HSN code data."),
    ("hsn.bulk_action", "hsn", "masters-hsn", "manage", "ALL", "Use Bulk Actions in the HSN code list."),
]


async def seed_master_permissions() -> None:
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        permission_repo = PermissionRepository(session)
        role_repo = RoleRepository(session)

        # 1. Ensure permissions exist
        created_perms: list[Permission] = []
        for code, module, page, action, scope, description in NEW_PERMISSIONS:
            existing = await permission_repo.get_by_code(code)
            if existing is None:
                perm = Permission(
                    code=code,
                    module=module,
                    page=page,
                    action=action,
                    scope=scope,
                    description=description,
                )
                session.add(perm)
                created_perms.append(perm)
                print(f"Created permission: {code}")
            else:
                created_perms.append(existing)

        await session.flush()

        # 2. Grant new permissions to all roles that have the module's .view or .update permission
        role_stmt = select(Role)
        all_roles = (await session.execute(role_stmt)).scalars().all()
        for role in all_roles:
            for perm in created_perms:
                view_perm_code = f"{perm.module}.view"
                # Check if role has view_perm_code
                view_perm = await permission_repo.get_by_code(view_perm_code)
                if view_perm:
                    has_view_stmt = select(RolePermission).where(
                        RolePermission.role_id == role.id,
                        RolePermission.permission_id == view_perm.id,
                    )
                    has_view = (await session.execute(has_view_stmt)).scalar_one_or_none()
                    if has_view is not None or role.name == "super_admin":
                        # Check if already granted
                        existing_grant_stmt = select(RolePermission).where(
                            RolePermission.role_id == role.id,
                            RolePermission.permission_id == perm.id,
                        )
                        existing_grant = (await session.execute(existing_grant_stmt)).scalar_one_or_none()
                        if existing_grant is None:
                            session.add(RolePermission(role_id=role.id, permission_id=perm.id))
                            print(f"  Granted '{perm.code}' to role '{role.name}'")

        await session.commit()

    await dispose_engine()
    print("\nSuccessfully seeded all missing master configuration permissions.")


if __name__ == "__main__":
    asyncio.run(seed_master_permissions())
