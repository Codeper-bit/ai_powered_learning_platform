-- AI Tutor: full schema, idempotent.
--
-- This is the ONLY schema file — run it via `python setup_db.py` any time:
-- on a brand-new database, or against an existing one to pick up new
-- columns/indexes added since it was first set up. Every statement here
-- uses IF NOT EXISTS (tables, columns, indexes), so re-running this is
-- always safe and never touches existing rows or drops data.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT
);
-- Columns added after the table's first release, for upgrades in place:
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,           -- full extracted text
    word_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
    misconception TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    answer TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, question_id)    -- one attempt per question per user;
                                      -- makes double-submit safe via ON CONFLICT
);

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
