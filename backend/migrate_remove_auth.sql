-- One-time migration for a database that was running the Supabase-login
-- version of Aptly. Run it ONCE (psql "$DATABASE_URL" -f migrate_remove_auth.sql).
-- Nothing is deleted: every existing user's quizzes, attempts, documents and
-- tasks keep their UUID owner, which simply becomes a "learner" instead of a
-- Supabase account. (The frontend adopts the old Supabase user id from the
-- browser on first load, so returning users still see their own data.)
BEGIN;

CREATE TABLE IF NOT EXISTS learners (
    id         UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO learners (id)
SELECT user_id FROM documents WHERE user_id IS NOT NULL
UNION SELECT user_id FROM quiz_sessions
UNION SELECT user_id FROM attempts
UNION SELECT user_id FROM todos
ON CONFLICT (id) DO NOTHING;

-- Re-point every owner foreign key from profiles -> learners.
ALTER TABLE documents     DROP CONSTRAINT IF EXISTS documents_user_id_fkey;
ALTER TABLE quiz_sessions DROP CONSTRAINT IF EXISTS quiz_sessions_user_id_fkey;
ALTER TABLE attempts      DROP CONSTRAINT IF EXISTS attempts_user_id_fkey;
ALTER TABLE todos         DROP CONSTRAINT IF EXISTS todos_user_id_fkey;

ALTER TABLE documents     ADD CONSTRAINT documents_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES learners(id) ON DELETE CASCADE;
ALTER TABLE quiz_sessions ADD CONSTRAINT quiz_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES learners(id) ON DELETE CASCADE;
ALTER TABLE attempts      ADD CONSTRAINT attempts_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES learners(id) ON DELETE CASCADE;
ALTER TABLE todos         ADD CONSTRAINT todos_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES learners(id) ON DELETE CASCADE;

-- Stop creating profile rows for new Supabase sign-ups (only if the Supabase
-- auth schema exists in this database).
DO $$
BEGIN
    IF to_regclass('auth.users') IS NOT NULL THEN
        EXECUTE 'DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users';
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.handle_new_user();

COMMIT;

-- OPTIONAL cleanup. Run only after you've confirmed the app works.
-- These tables hold only login-era data (names / old password hashes):
-- DROP TABLE IF EXISTS profiles;
-- DROP TABLE IF EXISTS user_id_migration_map;
-- DROP TABLE IF EXISTS users;
