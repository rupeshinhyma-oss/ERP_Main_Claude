import asyncio
from app.database.engine import get_sessionmaker, dispose_engine
from app.auth.service import AuthService, LoginContext
from app.auth.repository import SessionRepository, TokenBlacklistRepository, PasswordHistoryRepository
from app.users.repository import UserRepository
from app.rbac.repository import RoleRepository
from app.cache.in_memory import InMemoryCacheBackend

async def main():
    async with get_sessionmaker()() as session:
        cache = InMemoryCacheBackend()
        auth_service = AuthService(
            user_repository=UserRepository(session),
            role_repository=RoleRepository(session),
            session_repository=SessionRepository(session),
            token_blacklist_repository=TokenBlacklistRepository(session),
            password_history_repository=PasswordHistoryRepository(session),
            cache=cache,
        )
        user, access_token, refresh_token = await auth_service.login(
            identifier="admin",
            password="ChangeMe!12345",
            context=LoginContext(ip_address="127.0.0.1", user_agent="test-script")
        )
        print("AUTHENTICATION SUCCESSFUL!")
        print(f"Logged in User: {user.username} ({user.email})")
        print(f"Status: {user.status}")
        print(f"Must Change Password: {user.must_change_password}")
        print(f"Access Token: {access_token[:25]}...")

    await dispose_engine()

if __name__ == "__main__":
    asyncio.run(main())
