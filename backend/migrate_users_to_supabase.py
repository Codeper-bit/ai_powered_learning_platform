"""
One-time script — Situation B, step 1 of the Supabase Auth migration.

For each row in the old `users` table, either invites that person by email
to create a matching Supabase Auth account, or (if that email is already
registered in Supabase — e.g. they already signed up through the new flow)
looks up the existing account instead. Either way, records (old_id, new_id)
in `user_id_migration_map` so supabase_migration_situation_b.sql can join
through it to backfill documents/quiz_sessions/attempts/todos.

Requires, IN ADDITION to the app's usual backend/.env:
    SUPABASE_URL                 (already needed by the backend)
    SUPABASE_SERVICE_ROLE_KEY    NEW — Supabase dashboard -> Project Settings
                                  -> API -> service_role secret key.
                                  This key bypasses all Row Level Security.
                                  Never expose it to the frontend, never
                                  commit it. Add it to backend/.env only for
                                  as long as it takes to run this script,
                                  then delete it from the file.

One-time dependency (not needed by the app itself, only this script):
    pip install supabase --break-system-packages

Usage:
    python migrate_users_to_supabase.py            # dry run: prints the plan only
    python migrate_users_to_supabase.py --apply     # actually invites/maps users
"""
import asyncio
import os
import sys

import asyncpg
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")


def _find_existing_by_email(supabase, email: str):
    """Paginate list_users looking for a matching email. list_users has no
    server-side email filter in supabase-py, so for a large user base this
    is the slow part — for a big table, use the Admin REST API's
    GET /auth/v1/admin/users?email= instead, if your project supports it."""
    page = 1
    while True:
        users = supabase.auth.admin.list_users(page=page, per_page=200)
        if not users:
            return None
        for user in users:
            if (user.email or "").lower() == email.lower():
                return user.id
        page += 1


async def main():
    apply = "--apply" in sys.argv

    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set.")
    if not SUPABASE_URL or not SERVICE_ROLE_KEY:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set. "
            "Get the service_role key from Project Settings -> API in the "
            "Supabase dashboard — remove it from .env again once this "
            "script has run."
        )

    supabase = create_client(SUPABASE_URL, SERVICE_ROLE_KEY)
    conn = await asyncpg.connect(DATABASE_URL)

    try:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_id_migration_map (
                old_id INTEGER PRIMARY KEY,
                new_id UUID NOT NULL
            )
            """
        )

        already_mapped = {
            r["old_id"]
            for r in await conn.fetch("SELECT old_id FROM user_id_migration_map")
        }

        old_users = await conn.fetch("SELECT id, name, email FROM users ORDER BY id")

        no_email, to_create, skipped = [], [], []
        for u in old_users:
            if u["id"] in already_mapped:
                skipped.append(u)
            elif not u["email"]:
                no_email.append(u)
            else:
                to_create.append(u)

        print(f"{len(old_users)} old users total")
        print(f"  {len(skipped)} already mapped — skipping")
        print(f"  {len(no_email)} have no email — cannot auto-migrate (see below)")
        suffix = "" if apply else " (dry run — pass --apply to actually do it)"
        print(f"  {len(to_create)} to invite{suffix}")

        if no_email:
            print(
                "\nNo-email users — handle manually (e.g. have them re-register "
                "and match by name), then insert their row into "
                "user_id_migration_map yourself:"
            )
            for u in no_email:
                print(f"    old_id={u['id']}  name={u['name']!r}")

        if not apply:
            return

        for u in to_create:
            email = u["email"]
            try:
                result = supabase.auth.admin.invite_user_by_email(email)
                new_id = result.user.id
                print(f"  invited  old_id={u['id']}  email={email}  -> new_id={new_id}")
            except Exception as exc:
                msg = str(exc).lower()
                if "already" in msg or "registered" in msg:
                    match = _find_existing_by_email(supabase, email)
                    if not match:
                        print(
                            f"  SKIP     old_id={u['id']}  email={email}  — "
                            f"reported as already registered but not found via "
                            f"list_users; check manually. ({exc})"
                        )
                        continue
                    new_id = match
                    print(f"  existing old_id={u['id']}  email={email}  -> new_id={new_id}")
                else:
                    print(f"  ERROR    old_id={u['id']}  email={email}  — {exc}")
                    continue

            await conn.execute(
                "INSERT INTO user_id_migration_map (old_id, new_id) VALUES ($1, $2) "
                "ON CONFLICT (old_id) DO NOTHING",
                u["id"],
                new_id,
            )

        print(
            "\nDone. Resolve any no-email/SKIP/ERROR rows above by hand, then "
            "run supabase_migration_situation_b.sql."
        )
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
