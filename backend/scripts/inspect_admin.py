import asyncio
from sqlalchemy import select
from app.database.engine import get_sessionmaker, dispose_engine
from app.users.models import User, UserStatus
from app.auth.security import hash_password

async def main():
    async with get_sessionmaker()() as session:
        stmt = select(User).where(User.username == "admin")
        res = await session.execute(stmt)
        user = res.scalar_one_or_none()
        if not user:
            print("ADMIN USER NOT FOUND IN DB!")
            return
        print(f"User ID: {user.id}")
        print(f"Username: {user.username}")
        print(f"Email: {user.email}")
        print(f"Status: {user.status}")
        print(f"Is Active: {user.is_active}")
        print(f"Failed Login Count: {user.failed_login_count}")
        print(f"Locked Until: {user.locked_until}")
        print(f"Must Change Password: {user.must_change_password}")

        # Reset admin password and ensure active status
        user.password_hash = hash_password("ChangeMe!12345")
        user.status = UserStatus.ACTIVE.value
        user.is_active = True
        user.failed_login_count = 0
        user.locked_until = None
        user.must_change_password = False
        await session.commit()
        print("\nSUCCESS: Admin user password reset to 'ChangeMe!12345', must_change_password set to False, and account fully unlocked!")

    await dispose_engine()

if __name__ == "__main__":
    asyncio.run(main())
