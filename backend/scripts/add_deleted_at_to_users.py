"""
Add deleted_at column to users table in PostgreSQL database.
"""

import asyncio
import sys
from pathlib import Path

# Add backend directory to sys.path
backend_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import text
from app.database.engine import get_engine, dispose_engine


async def main():
    engine = get_engine()
    async with engine.begin() as conn:
        print("Adding column deleted_at to users table if it does not exist...")
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE NULL;"))
        print("Done!")
    await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
