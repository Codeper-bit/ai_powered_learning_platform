-- ----------------------------------------------------------------------------
BEGIN;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id_new UUID
    REFERENCES profiles(id) ON DELETE CASCADE;

UPDATE documents d
SET user_id_new = m.new_id
FROM user_id_migration_map m
WHERE d.user_id = m.old_id
  AND d.user_id_new IS NULL;

DO $$
DECLARE
    unmapped INTEGER;
BEGIN
    SELECT COUNT(*) INTO unmapped
    FROM documents
    WHERE user_id IS NOT NULL AND user_id_new IS NULL;

    IF unmapped > 0 THEN
        RAISE EXCEPTION
            '% documents row(s) have a user_id with no entry in user_id_migration_map — aborting, nothing changed.',
            unmapped;
    END IF;
END $$;

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_user_id_fkey;
ALTER TABLE documents DROP COLUMN user_id;
ALTER TABLE documents RENAME COLUMN user_id_new TO user_id;
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);

COMMIT;

-- ----------------------------------------------------------------------------
-- quiz_sessions (user_id is NOT NULL)
-- ----------------------------------------------------------------------------
BEGIN;

ALTER TABLE quiz_sessions ADD COLUMN IF NOT EXISTS user_id_new UUID
    REFERENCES profiles(id) ON DELETE CASCADE;

UPDATE quiz_sessions s
SET user_id_new = m.new_id
FROM user_id_migration_map m
WHERE s.user_id = m.old_id
  AND s.user_id_new IS NULL;

DO $$
DECLARE
    unmapped INTEGER;
BEGIN
    SELECT COUNT(*) INTO unmapped FROM quiz_sessions WHERE user_id_new IS NULL;
    IF unmapped > 0 THEN
        RAISE EXCEPTION
            '% quiz_sessions row(s) have no mapped user_id_new — aborting, nothing changed.',
            unmapped;
    END IF;
END $$;

ALTER TABLE quiz_sessions DROP CONSTRAINT IF EXISTS quiz_sessions_user_id_fkey;
ALTER TABLE quiz_sessions DROP COLUMN user_id;
ALTER TABLE quiz_sessions RENAME COLUMN user_id_new TO user_id;
ALTER TABLE quiz_sessions ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON quiz_sessions(user_id);

COMMIT;

-- ----------------------------------------------------------------------------
-- attempts (user_id is NOT NULL; two partial-unique indexes to recreate —
-- see schema.sql)
-- ----------------------------------------------------------------------------
BEGIN;

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS user_id_new UUID
    REFERENCES profiles(id) ON DELETE CASCADE;

UPDATE attempts a
SET user_id_new = m.new_id
FROM user_id_migration_map m
WHERE a.user_id = m.old_id
  AND a.user_id_new IS NULL;

DO $$
DECLARE
    unmapped INTEGER;
BEGIN
    SELECT COUNT(*) INTO unmapped FROM attempts WHERE user_id_new IS NULL;
    IF unmapped > 0 THEN
        RAISE EXCEPTION
            '% attempts row(s) have no mapped user_id_new — aborting, nothing changed.',
            unmapped;
    END IF;
END $$;

ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_user_id_fkey;
ALTER TABLE attempts DROP COLUMN user_id;
ALTER TABLE attempts RENAME COLUMN user_id_new TO user_id;
ALTER TABLE attempts ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempts_user_attempt_key
    ON attempts (user_id, attempt_key) WHERE attempt_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempts_user_question_unkeyed
    ON attempts (user_id, question_id) WHERE attempt_key IS NULL;

COMMIT;

-- ----------------------------------------------------------------------------
-- todos (user_id is NOT NULL)
-- ----------------------------------------------------------------------------
BEGIN;

ALTER TABLE todos ADD COLUMN IF NOT EXISTS user_id_new UUID
    REFERENCES profiles(id) ON DELETE CASCADE;

UPDATE todos t
SET user_id_new = m.new_id
FROM user_id_migration_map m
WHERE t.user_id = m.old_id
  AND t.user_id_new IS NULL;

DO $$
DECLARE
    unmapped INTEGER;
BEGIN
    SELECT COUNT(*) INTO unmapped FROM todos WHERE user_id_new IS NULL;
    IF unmapped > 0 THEN
        RAISE EXCEPTION
            '% todos row(s) have no mapped user_id_new — aborting, nothing changed.',
            unmapped;
    END IF;
END $$;

ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_user_id_fkey;
ALTER TABLE todos DROP COLUMN user_id;
ALTER TABLE todos RENAME COLUMN user_id_new TO user_id;
ALTER TABLE todos ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);

COMMIT;

-- ============================================================================
-- CLEANUP — do NOT run this yet.
-- Only after all four tables above are committed AND you've verified the
-- live app works end to end against them (logins, uploads, quizzes, todos
-- all showing the right owner's data).
-- ============================================================================
-- DROP TABLE IF EXISTS user_id_migration_map;
-- DROP TABLE IF EXISTS users;
