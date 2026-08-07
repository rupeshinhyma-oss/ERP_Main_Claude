import asyncio
import sys
from pathlib import Path
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import settings

async def check():
    print(f"DATABASE_URL: {settings.DATABASE_URL}")
    engine = create_async_engine(str(settings.DATABASE_URL))
    async with engine.connect() as conn:
        res = await conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"))
        tables = [row[0] for row in res.fetchall()]
        print(f"Total Tables: {len(tables)}")
        for t in sorted(tables):
            if t == 'alembic_version':
                continue
            c_res = await conn.execute(text(f'SELECT COUNT(*) FROM "{t}"'))
            count = c_res.scalar()
            print(f"  {t}: {count}")
    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(check())
