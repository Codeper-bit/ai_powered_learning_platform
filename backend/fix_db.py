"""One-off migration: relax users.email to nullable (legacy DBs created
before that column allowed NULL). Usage: python fix_db.py
"""
import asyncio

import asyncpg

from config import settings


async def main():
    conn = await asyncpg.connect(settings.DATABASE_URL)
    await conn.execute("ALTER TABLE users ALTER COLUMN email DROP NOT NULL;")
    print("Done: users.email no longer requires a value")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
