"""One-off dev script: drops and recreates all tables from schema.sql.
Usage: python run_schema.py
"""
import asyncio

import asyncpg

from config import settings


async def main():
    conn = await asyncpg.connect(settings.DATABASE_URL)

    await conn.execute("DROP TABLE IF EXISTS attempts CASCADE;")
    await conn.execute("DROP TABLE IF EXISTS questions CASCADE;")
    await conn.execute("DROP TABLE IF EXISTS quiz_sessions CASCADE;")
    await conn.execute("DROP TABLE IF EXISTS documents CASCADE;")
    with open("schema.sql", "r") as f:
        schema_sql = f.read()
    await conn.execute(schema_sql)
    print("Done: schema applied (users, documents, quiz_sessions, questions, attempts)")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
