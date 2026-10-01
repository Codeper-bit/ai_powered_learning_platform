"""One script, for both first-time setup and upgrades.

Run this any time you point the app at a database: a brand-new one, or an
existing one that just needs newer columns/indexes. schema.sql is fully
idempotent (IF NOT EXISTS everywhere), so this never drops or overwrites
existing data — it only creates what's missing.

Usage:
    python setup_db.py          (reads DATABASE_URL from .env or the environment)

An EXISTING database from the old login version: also run
migrate_remove_auth.sql once (see README).
"""
import asyncio
import os
import asyncpg
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")


async def main():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set — set it in .env or the environment first.")

    conn = await asyncpg.connect(DATABASE_URL)
    try:
        with open("schema.sql", "r") as f:
            await conn.execute(f.read())
        print("Done: schema is up to date (learners, documents, quiz_sessions, questions, attempts, todos).")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
