import asyncio
import urllib.parse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

PROJ = "mpvzjzunkiqchhhvxrza"
PASSWORDS = [
    "om@30092004inhymaom@30092004inhyma",
    "om@30092004",
    "Inhyma@2026",
    "inhyma@2026",
    "ChangeMe!12345",
    "postgres",
    "om30092004",
    "inhyma",
    "inhyma2026"
]

async def test_pass(pwd):
    encoded_pass = urllib.parse.quote_plus(pwd)
    url = f"postgresql+asyncpg://postgres.{PROJ}:{encoded_pass}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres"
    try:
        engine = create_async_engine(url, connect_args={"statement_cache_size": 0})
        async with engine.connect() as conn:
            res = await conn.execute(text("SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"))
            count = res.scalar()
            print(f"SUCCESS WITH PASSWORD '{pwd}'! Found {count} public tables.")
            t_res = await conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema='public';"))
            tables = [r[0] for r in t_res.fetchall()]
            print("Tables:", tables)
            return pwd, url
    except Exception as e:
        err_msg = str(e)
        if "password authentication failed" in err_msg:
            print(f"Auth failed for '{pwd}'")
        else:
            print(f"Error for '{pwd}': {e}")
        return None, None

async def main():
    for p in PASSWORDS:
        working_pwd, url = await test_pass(p)
        if working_pwd:
            print(f"\nFOUND CORRECT PASSWORD FOR {PROJ}: {working_pwd}")
            break

if __name__ == "__main__":
    asyncio.run(main())
