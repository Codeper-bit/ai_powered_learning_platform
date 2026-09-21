-- AI Tutor: full schema, idempotent.
--
-- This is the ONLY schema file — run it via `python setup_db.py` any time:
-- on a brand-new database, or against an existing one to pick up new
-- columns/indexes added since it was first set up. Every statement here
-- uses IF NOT EXISTS (tables, columns, indexes), so re-running this is
-- always safe and never touches existing rows or drops data.
--
-- NOTE (Supabase Auth migration): this file only ADDS the new `profiles`
-- table below — it does NOT change `documents`/`quiz_sessions`/`attempts`/
-- `todos`.user_id from INTEGER to UUID, because that change is inherently
-- NOT idempotent/non-destructive for a database with existing rows (an
-- INTEGER can't be losslessly reinterpreted as a UUID). That change lives
-- in supabase_migration.sql instead, as a one-time, explicitly-reviewed
-- step — see MIGRATION.md before running it.

-- Old custom-auth users table. Superseded by Supabase's own auth.users
-- plus the `profiles` table below. Left in place (not dropped) until the
-- FK migration in supabase_migration.sql runs — see MIGRATION.md.
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- App-specific profile data for a Supabase Auth user. Kept separate from
-- Supabase's own `auth.users` table (never edit that one directly — it's
-- managed by Supabase), per Supabase's recommended pattern. `id` is the
-- same UUID as auth.users.id, so this is a 1:1 extension table, not a
-- second source of truth for identity.
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create a profiles row whenever Supabase creates a new auth user, so
-- the app never has to remember to do it from the frontend (and so
-- supabase_auth.get_current_user's existence check always has something to
-- find for a freshly-registered, already-verified user). SECURITY DEFINER
-- is required here: this function must run with privileges to insert into
-- `public.profiles` even though it's triggered by a write to `auth.users`,
-- which the calling role does not otherwise own.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, name)
    VALUES (
        new.id,
        COALESCE(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1))
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,           -- full extracted text
    word_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- user_id used to be nullable/unset (uploads weren't tied to an owner).
-- New uploads always set it (see routers/documents.py); the column stays
-- nullable so old rows aren't touched, but is now indexed for ownership
-- checks on every document read.
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);

CREATE TABLE IF NOT EXISTS quiz_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    exam_type TEXT,
    subject TEXT NOT NULL,
    topic TEXT,
    time_limit INTEGER,              -- minutes
    total_questions INTEGER NOT NULL,
    min_difficulty TEXT NOT NULL,
    max_difficulty TEXT NOT NULL,
    custom_request TEXT,
    status TEXT NOT NULL DEFAULT 'active',   -- active | completed
    -- How many times this session's question set has been copied into a
    -- new session for a different request (see the reuse/caching lookup
    -- in routers/sessions.py). Capped so content still refreshes over time
    -- under sustained traffic instead of one batch circulating forever.
    reuse_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE quiz_sessions ADD COLUMN IF NOT EXISTS reuse_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,       -- order the question was generated in (1..N)
    question TEXT NOT NULL,
    options JSONB NOT NULL,
    correct_answer TEXT NOT NULL,
    concept TEXT,
    difficulty TEXT NOT NULL,
    explanation TEXT,
    misconception TEXT,
    -- Optional per-option diagnostic metadata generated alongside the
    -- question: {"Option text": "what picking this option indicates"}.
    -- Nullable/absent for older rows and gracefully ignored where unused.
    option_insights JSONB
);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_insights JSONB;

CREATE TABLE IF NOT EXISTS attempts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    answer TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The likely misconception identified for THIS attempt (null when
    -- correct). Persisting it — instead of only returning it to the client
    -- once — is what lets the diagnostic engine notice a repeated error
    -- pattern across attempts instead of re-deriving it from scratch and
    -- forgetting it happened.
    misconception TEXT,
    -- Evidence-based label for how confident we are that this attempt's
    -- misconception reflects a real, recurring gap rather than one slip:
    -- 'needs_more_evidence' | 'possible' | 'likely'. See ai diagnostic
    -- logic in routers/attempts.py.
    misconception_confidence TEXT,
    -- True when this row arrived via the offline-sync queue rather than a
    -- live submission. Kept for transparency/debugging; scoring is always
    -- recalculated server-side regardless of this flag.
    synced_from_offline BOOLEAN NOT NULL DEFAULT false
    -- Uniqueness lives in the two partial indexes below (attempt_key).
);
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS misconception TEXT;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS misconception_confidence TEXT;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS synced_from_offline BOOLEAN NOT NULL DEFAULT false;

-- Idempotency token for ONE genuine attempt, minted by the client when the
-- student answers (a UUID). Re-sending the same submission (a network retry,
-- a duplicate offline sync) re-sends the same key and is recognised as a
-- duplicate; answering the same question again later gets a NEW key and is
-- stored as a NEW row, so earlier attempts are never overwritten.
-- NULL = submitted without a key (live online answers, older clients, items
-- queued before this column existed).
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS attempt_key TEXT;

-- These two indexes REPLACE the old UNIQUE (user_id, question_id), which
-- made "answer the same question again" overwrite the earlier attempt.
--  1) keyed submissions: one row per (user, key)  -> duplicate syncs are no-ops
--  2) keyless submissions keep the old one-row-per-question protection
--     (existing rows are all keyless and already satisfy it)
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempts_user_attempt_key
    ON attempts (user_id, attempt_key) WHERE attempt_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempts_user_question_unkeyed
    ON attempts (user_id, question_id) WHERE attempt_key IS NULL;

-- Drop the old UNIQUE (user_id, question_id) constraint from databases that
-- already have it (looked up by its columns, so it works whatever it was
-- named). Runs only after the replacement indexes exist above; a no-op on
-- fresh databases and on re-runs. Rows are never touched.
DO $$
DECLARE con RECORD;
BEGIN
    FOR con IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.conrelid = 'attempts'::regclass
          AND c.contype = 'u'
          AND (
              SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM pg_attribute a
              WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          ) = ARRAY['question_id', 'user_id']
    LOOP
        EXECUTE format('ALTER TABLE attempts DROP CONSTRAINT %I', con.conname);
    END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    subject TEXT,
    due_date DATE,
    priority TEXT NOT NULL DEFAULT 'medium',   -- low | medium | high
    is_complete BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);

CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON quiz_sessions(user_id);

-- Speeds up the reuse/caching lookup: "has anyone already generated a
-- topic-based (non-document) batch matching these exact parameters
-- recently?" — the hot path that saves LLM calls under repeated traffic.
CREATE INDEX IF NOT EXISTS idx_sessions_cache_lookup
    ON quiz_sessions (subject, exam_type, min_difficulty, max_difficulty, created_at DESC)
    WHERE document_id IS NULL;
