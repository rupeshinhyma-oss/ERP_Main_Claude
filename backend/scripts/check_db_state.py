"""Check database state for permissions, roles, user_roles."""
import asyncio
import os
import sys
sys.path.insert(0, ".")

from dotenv import load_dotenv
load_dotenv()

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy import text

DATABASE_URL = os.environ.get("DATABASE_URL", "")
print("DB URL prefix:", DATABASE_URL[:80])

async def check():
    engine = create_async_engine(DATABASE_URL, echo=False)
    async with AsyncSession(engine) as session:
        r1 = await session.execute(text("SELECT COUNT(*) FROM permissions"))
        print("Permissions count:", r1.scalar())

        r2 = await session.execute(text("SELECT COUNT(*) FROM user_roles"))
        print("User_roles count:", r2.scalar())

        r3 = await session.execute(text(
            "SELECT u.username, r.name FROM users u "
            "JOIN user_roles ur ON ur.user_id=u.id "
            "JOIN roles r ON r.id=ur.role_id "
            "WHERE u.username='admin'"
        ))
        rows = r3.fetchall()
        print("Admin roles:", rows)

        r4 = await session.execute(text(
            "SELECT COUNT(*) FROM role_permissions rp "
            "JOIN roles r ON r.id=rp.role_id WHERE r.name='super_admin'"
        ))
        print("super_admin role_permissions:", r4.scalar())

        r5 = await session.execute(text("SELECT code FROM permissions LIMIT 5"))
        print("Sample perms:", r5.fetchall())

        # Check user_permissions table
        r6 = await session.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='user_permissions'"
        ))
        print("user_permissions columns:", [row[0] for row in r6.fetchall()])

    await engine.dispose()

asyncio.run(check())
