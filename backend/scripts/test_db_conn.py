import asyncio
import os
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# List candidate connection URLs for Supabase project mpvzjzunkiqchhhvxrza
PASS = "om%4030092004inhymaom%4030092004inhyma"
PROJ = "mpvzjzunkiqchhhvxrza"

CANDIDATES = [
    f"postgresql+asyncpg://postgres.{PROJ}:{PASS}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
    f"postgresql+asyncpg://postgres.{PROJ}:{PASS}@aws-1-ap-south-1.pooler.supabase.com:6543/postgres",
    f"postgresql+asyncpg://postgres.{PROJ}:{PASS}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
    f"postgresql+asyncpg://postgres:{PASS}@db.{PROJ}.supabase.co:5432/postgres",
]

async def test_candidate(url):
    print(f"Testing URL: {url.split('@')[1]} ...")
    try:
        engine = create_async_engine(url, connect_args={"statement_cache_size": 0})
        async with engine.connect() as conn:
            res = await conn.execute(text("SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"))
            count = res.scalar()
            print(f"SUCCESS! Connected to {url.split('@')[1]} - Found {count} public tables.")
            
            # List existing tables
            t_res = await conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema='public';"))
            tables = [r[0] for r in t_res.fetchall()]
            print("Existing Tables in DB:", tables)
            return url
    except Exception as e:
        print(f"FAILED: {e}")
        return None

async def main():
    for cand in CANDIDATES:
        working = await test_candidate(cand)
        if working:
            print("\nWORKING DATABASE URL IDENTIFIED:", working)
            break

if __name__ == "__main__":
    asyncio.run(main())
