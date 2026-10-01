-- Aptly schema. Fully idempotent: safe to run on a new database or re-run on
-- an existing one (setup_db.py does exactly this). Plain Postgres only; no
-- Supabase-specific objects.

-- One row per browser/device. `id` is the random UUID the frontend sends as
-- X-Device-Id (see deps.py). Deleting a learner cascades to all their data.
CREATE TABLE IF NOT EXISTS learners (
    id         UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
    id         SERIAL PRIMARY KEY,
    user_id    UUID REFERENCES learners(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    content    TEXT NOT NULL,            -- extracted text only; the file is never stored
    word_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);

CREATE TABLE IF NOT EXISTS quiz_sessions (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
    document_id     INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    exam_type       TEXT,
    subject         TEXT NOT NULL,
    topic           TEXT,
    time_limit      INTEGER,             -- minutes
    total_questions INTEGER NOT NULL,
    min_difficulty  TEXT NOT NULL,
    max_difficulty  TEXT NOT NULL,
    custom_request  TEXT,
    status          TEXT NOT NULL DEFAULT 'active',   -- active | completed
    -- How many times this session's question set was copied into another
    -- session (the reuse/cache layer in routers/sessions.py). Capped so
    -- content still refreshes under sustained traffic.
    reuse_count     INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE quiz_sessions ADD COLUMN IF NOT EXISTS reuse_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON quiz_sessions(user_id);
-- Hot path of the reuse layer: "was a matching topic-based batch generated recently?"
CREATE INDEX IF NOT EXISTS idx_sessions_cache_lookup
    ON quiz_sessions (subject, exam_type, min_difficulty, max_difficulty, created_at DESC)
    WHERE document_id IS NULL;

CREATE TABLE IF NOT EXISTS questions (
    id             SERIAL PRIMARY KEY,
    session_id     INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL,     -- order generated in (1..N)
    question       TEXT NOT NULL,
    options        JSONB NOT NULL,
    correct_answer TEXT NOT NULL,
    concept        TEXT,
    difficulty     TEXT NOT NULL,
    explanation    TEXT,
    misconception  TEXT,
    option_insights JSONB                -- {"Option text": "what choosing it suggests"}
);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_insights JSONB;
CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id);

CREATE TABLE IF NOT EXISTS attempts (
    id                       SERIAL PRIMARY KEY,
    user_id                  UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
    question_id              INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    answer                   TEXT NOT NULL,
    is_correct               BOOLEAN NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    misconception            TEXT,       -- likely misconception for THIS attempt (null when correct)
    misconception_confidence TEXT,       -- 'Needs more evidence' | 'Possible misconception' | 'Likely weakness'
    synced_from_offline      BOOLEAN NOT NULL DEFAULT false,
    -- Client-minted idempotency token for ONE genuine attempt: a retried or
    -- duplicate offline sync re-sends the same key and is a no-op, while
    -- answering the same question again later gets a new key and a new row.
    attempt_key              TEXT
);
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS misconception TEXT;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS misconception_confidence TEXT;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS synced_from_offline BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS attempt_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempts_user_attempt_key
    ON attempts (user_id, attempt_key) WHERE attempt_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempts_user_question_unkeyed
    ON attempts (user_id, question_id) WHERE attempt_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);

CREATE TABLE IF NOT EXISTS todos (
    id          SERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    subject     TEXT,
    due_date    DATE,
    priority    TEXT NOT NULL DEFAULT 'medium',   -- low | medium | high
    is_complete BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
