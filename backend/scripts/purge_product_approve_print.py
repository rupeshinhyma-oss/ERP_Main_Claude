"""
Purge product.approve and product.print permissions from database.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.core.logging import configure_logging
from app.database.engine import dispose_engine, get_sessionmaker
from app.rbac.models import Permission, RolePermission, UserPermission
from app.rbac.repository import PermissionRepository
from app.users.repository import UserRepository  # noqa: F401

CODES_TO_PURGE = ["product.approve", "product.print"]


async def main() -> None:
    configure_logging()
    session_factory = get_sessionmaker()

    async with session_factory() as session:
        permission_repo = PermissionRepository(session)

        stmt = select(Permission).where(Permission.code.in_(CODES_TO_PURGE))
        perms = (await session.execute(stmt)).scalars().all()

        print(f"Found {len(perms)} permission(s) to purge: {[p.code for p in perms]}")

        for perm in perms:
            # Delete associated role permissions
            role_perm_stmt = select(RolePermission).where(RolePermission.permission_id == perm.id)
            role_perms = (await session.execute(role_perm_stmt)).scalars().all()
            for rp in role_perms:
                await session.delete(rp)

            # Delete associated user permissions
            user_perm_stmt = select(UserPermission).where(UserPermission.permission_id == perm.id)
            user_perms = (await session.execute(user_perm_stmt)).scalars().all()
            for up in user_perms:
                await session.delete(up)

            await permission_repo.delete(perm)
            print(f"  Deleted permission '{perm.code}' and associated grants.")

        await session.commit()

    await dispose_engine()
    print("Purge completed successfully.")


if __name__ == "__main__":
    asyncio.run(main())
