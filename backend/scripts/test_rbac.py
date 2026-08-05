import asyncio
import uuid
import app.users.models
from app.database.engine import get_sessionmaker
from app.rbac.repository import RoleRepository

async def main():
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        repo = RoleRepository(session)
        user_id = uuid.UUID('84d1a995-261c-4c6d-94ef-7667b759c460')
        perms = await repo.get_permission_codes_for_user(user_id)
        print(f"PERMISSIONS COUNT FOR ADMIN ({user_id}): {len(perms)}")
        print(f"SAMPLE PERMISSIONS: {list(perms)[:10]}")

if __name__ == "__main__":
    asyncio.run(main())
