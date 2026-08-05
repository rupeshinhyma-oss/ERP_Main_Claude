import asyncio
import uuid
from app.database.engine import get_sessionmaker, dispose_engine
from app.members.dependencies import get_team_member_service
from app.auth.service import AuthService
from app.auth.repository import SessionRepository, TokenBlacklistRepository, PasswordHistoryRepository
from app.users.repository import UserRepository
from app.rbac.repository import RoleRepository
from app.cache.in_memory import InMemoryCacheBackend

async def main():
    async with get_sessionmaker()() as session:
        cache = InMemoryCacheBackend()
        user_repo = UserRepository(session)
        admin_user = await user_repo.get_by_username("admin")
        if not admin_user:
            print("Admin user not found in DB!")
            return

        auth_service = AuthService(
            user_repository=user_repo,
            role_repository=RoleRepository(session),
            session_repository=SessionRepository(session),
            token_blacklist_repository=TokenBlacklistRepository(session),
            password_history_repository=PasswordHistoryRepository(session),
            cache=cache,
        )
        service = get_team_member_service(session, None, auth_service)
        
        test_email = f"test_{uuid.uuid4().hex[:6]}@example.com"
        print(f"Creating team member with email {test_email} (created_by admin {admin_user.id})...")
        res = await service.create_member(
            full_name="Test User",
            email=test_email,
            password="Password@123",
            department_id=None,
            designation_id=None,
            created_by=admin_user.id
        )
        print("SUCCESS! Created member:", res)

    await dispose_engine()

if __name__ == "__main__":
    asyncio.run(main())
