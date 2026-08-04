import asyncio
from app.database.engine import get_engine
from app.database.base import Base
import app.rbac.models
import app.users.models
import app.employees.models
import app.departments.models
import app.designations.models
import app.auth.models
import app.audit.models
import app.queue.models

async def main():
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("All database tables created successfully.")

if __name__ == "__main__":
    asyncio.run(main())
