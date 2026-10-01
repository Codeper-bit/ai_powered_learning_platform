# AI Learning Platform

> **Learn from your mistakes, not just your answers.**

An AI-powered exam-practice platform. Students generate quizzes on any subject (or from their own study notes), answer them under a timer, and get feedback that goes beyond right and wrong: the app identifies *why* an answer was wrong, tracks concepts over time, and recommends what to study next.

Built with **React + Vite** on the front end, **FastAPI + PostgreSQL** on the back end, **Supabase Auth** for accounts, and **Groq** for AI question generation and analysis.

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Authentication](#authentication)
- [API reference](#api-reference)
- [Database schema](#database-schema)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

---

## Features

**Quiz generation**
- Generate multiple-choice quizzes on any subject or topic.
- Choose an exam style: General, WAEC, NECO or JAMB.
- Set the number of questions (up to 50), a time limit, and a difficulty range (Easy to Hard).
- Add custom instructions, for example "WAEC 2023 past-question style".
- Upload your own material (`.txt`, `.md`, `.pdf`, `.docx`, `.csv`, `.rtf`, up to 8 MB) and get questions based strictly on it.

**Adaptive quizzing**
- The next question adjusts to how you are doing, based on your last answer and your weak concepts.
- Retry a finished quiz with the same setup: a fresh session with new questions, and your history stays untouched.

**Mistake diagnosis**
- Every wrong answer is analysed for the underlying misconception, with a targeted explanation.
- Evidence is labelled honestly, so one wrong answer is never called a weakness:

| Times the same misconception appears | Label |
| --- | --- |
| 1 | Needs more evidence |
| 2 | Possible misconception |
| 3 or more | Likely weakness |

**Progress tracking**
- **Dashboard** with a learning curve (smoothed with a rolling average) and a 70% mastery line.
- **Concept mastery**: each concept is `NEW`, `DEVELOPING`, `WEAK` (50% accuracy or lower) or `MASTERED` (80% or higher). A verdict needs at least 3 attempts.
- **Recovery recommendation**: "what should I study next, and why", shown only once a concept has enough evidence to be called weak.

**Study to-do list**
- Tasks with subject, due date and priority (low, medium, high).

**Offline practice**
- Question batches are cached in the browser after each quiz.
- Practice offline; answers are queued and synced automatically when you are back online.

**Everything else**
- Email and password accounts with a name shown in the header.
- Downloadable plain-text results report for each session.
- Light and dark themes, remembering your choice or following your system setting.
- Responsive layout for phone and desktop.

---

## How it works

```
 Student ──► React app (Vite) ──► FastAPI backend ──► PostgreSQL
                │   ▲                  │
                │   │                  └──► Groq LLM (questions + analysis)
                ▼   │
            Supabase Auth  (email + password, issues the access token)
```

1. **Sign up or log in** through Supabase Auth. The app receives an access token (JWT).
2. **Create a quiz.** The front end sends the setup form to `POST /sessions`. The backend asks the LLM for a batch of questions, or reuses a recent matching batch to save cost, and stores them.
3. **Answer questions.** Each answer goes to `POST /attempts`. Grading is always done server-side. Wrong answers are analysed by the LLM for misconceptions.
4. **Adapt.** `GET /sessions/{id}/next-question` picks the next unanswered question using the previous result and the student's weak concepts.
5. **Review.** The dashboard reads stored attempts to compute concept mastery, the learning curve and the recovery recommendation. Nothing is estimated; every figure comes from real attempts.

Design notes:

- **Question reuse.** Before calling the LLM, the backend looks for a recent batch (default: last 14 days) with the same subject, exam type and difficulty and copies it. This keeps token spend roughly flat as traffic grows.
- **Idempotent submissions.** Each attempt can carry a client-generated `attempt_key`, so a replayed offline submission never records a duplicate.
- **Ownership checks.** Sessions and documents are only accessible to the user who created them.
- **Uploaded files are not stored.** Only the extracted text is kept.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Front end | React, Vite, Tailwind CSS v4 |
| Back end | Python, FastAPI, Uvicorn, asyncpg, Pydantic |
| Database | PostgreSQL (hosted on Supabase, or any Postgres) |
| Authentication | Supabase Auth (email + password) |
| AI | Groq API (`openai/gpt-oss-120b`) |
| Document parsing | pypdf, python-docx |

---

## Project structure

```
.
├── backend/
│   ├── main.py                    # FastAPI app, CORS, error handlers
│   ├── config.py                  # All environment settings in one place
│   ├── database.py                # asyncpg connection pool
│   ├── deps.py                    # Shared dependencies (DB access)
│   ├── supabase_jwt_auth.py       # Verifies Supabase tokens → current user
│   ├── ai_engine.py               # Groq prompts: question generation + analysis
│   ├── concept_profile.py         # Concept status logic (weak / mastered / ...)
│   ├── text_extraction.py         # PDF / DOCX / TXT text extraction
│   ├── schemas.py                 # Pydantic request/response models
│   ├── schema.sql                 # Database schema (idempotent)
│   ├── setup_db.py                # Applies schema.sql to your database
│   ├── migrate_users_to_supabase.py        # One-time legacy user migration
│   ├── supabase_migration_situation_b.sql  # One-time legacy data migration
│   └── routers/
│       ├── sessions.py            # Create / retry sessions, next question, progress
│       ├── attempts.py            # Submit and grade answers, misconception analysis
│       ├── documents.py           # Upload study material
│       ├── progress.py            # Dashboard overview and recovery recommendation
│       └── todos.py               # Study to-do list
│
└── src/
    ├── main.jsx                   # Entry point, applies saved theme
    ├── App.jsx                    # App shell, auth session, screen flow
    ├── api.js                     # Fetch helper that attaches the auth token
    ├── supabaseClient.js          # Supabase client
    ├── offlineStore.js            # Offline question banks + sync queue
    ├── downloadReport.js          # Client-side results report
    ├── theme.js                   # Light / dark theme helpers
    ├── index.css                  # Design tokens and shared styles
    └── components/
        ├── Login.jsx              # Log in / sign up
        ├── OnboardingForm.jsx     # Quiz setup form
        ├── DocumentUpload.jsx     # Study-material upload
        ├── QuestionCard.jsx       # Question display and answer selection
        ├── Dashboard.jsx          # Progress, mastery, learning curve, recovery
        ├── StudyTodoList.jsx      # To-do list
        └── ThemeToggle.jsx        # Light / dark switch
```

App screen flow: `login → home → setup → quiz → summary`, with `dashboard` and offline practice reachable from `home`.

---

## Getting started

### Prerequisites

- **Node.js** 18 or newer
- **Python** 3.10 or newer
- A **PostgreSQL** database (a free Supabase project works)
- A **Supabase** project (for authentication)
- A **Groq** API key ([console.groq.com](https://console.groq.com))

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Create `backend/.env` (see [Environment variables](#environment-variables)), then create the database tables:

```bash
python setup_db.py
```

Start the API:

```bash
uvicorn main:app --reload
```

The API runs at `http://127.0.0.1:8000`. Interactive docs are at `/docs`.

### 2. Front end

From the project root, create `.env` (see below), then:

```bash
npm install
npm run dev
```

The app runs at `http://localhost:5173`.

Front-end dependencies include `react`, `react-dom`, `@supabase/supabase-js`, `tailwindcss` and `vite`.

---

## Environment variables

### Backend: `backend/.env`

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `GROQ_API_KEY` | Yes | Groq API key for question generation and analysis. |
| `SUPABASE_URL` | Yes | Your Supabase project URL. |
| `SUPABASE_JWT_SECRET` | Yes | Supabase → Project Settings → API → JWT Settings. Server-side only. |
| `CORS_ORIGINS` | Yes in production | Comma-separated front-end URLs allowed to call the API. |
| `SUPABASE_JWT_AUD` | No | Token audience. Default `authenticated`. |
| `MAX_BATCH_SIZE` | No | Max questions per quiz. Default `50`. |
| `QUESTION_REUSE_WINDOW_DAYS` | No | How far back to look for reusable question batches. Default `14`. |
| `QUESTION_REUSE_MAX_COUNT` | No | Max questions copied from a reused batch. Default `25`. |
| `AI_TIMEOUT_SECONDS` | No | Ceiling on a single LLM call. Default `45`. |
| `MAX_UPLOAD_BYTES` | No | Max upload size. Default 8 MB. |
| `MAX_SOURCE_CHARS` | No | Characters of uploaded text sent to the LLM. Default `12000`. |
| `DB_POOL_MIN_SIZE` / `DB_POOL_MAX_SIZE` | No | Connection pool bounds. Defaults `2` / `10`. |

### Front end: `.env`

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Yes | Your Supabase project URL. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes | Supabase publishable (anon) key. |
| `VITE_API_BASE` | No | Backend URL. Default `http://127.0.0.1:8000`. |

> **Never commit `.env` files.** Add them to `.gitignore`. The JWT secret and database URL must stay on the server.

---

## Authentication

Accounts use **Supabase Auth with email and password**.

- **Sign up** collects a name, email and password. The name is stored in the user's auth metadata and shown in the dashboard header. If a user has no name, their email is shown instead.
- **Log in** uses email and password. Supabase keeps the session in the browser and refreshes it automatically.
- **API protection.** The front end sends the access token as `Authorization: Bearer <token>`. The backend verifies the signature locally with `SUPABASE_JWT_SECRET`, reads the user id, and confirms the user still has a row in `profiles`.
- **Profiles.** A database trigger (`handle_new_user`) creates a `profiles` row automatically whenever Supabase creates a user.

Supabase dashboard settings to check:

1. **Authentication → Providers → Email** is enabled.
2. **Authentication → URL Configuration:** set the Site URL to your deployed front end and add `http://localhost:5173` to Redirect URLs.
3. If **Confirm email** is on, new users must click the link in their inbox before logging in. The app tells them so after sign-up.

---

## API reference

All endpoints require `Authorization: Bearer <access token>`.

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/sessions` | Create a quiz session and generate its questions. |
| `POST` | `/sessions/{id}/retry` | Start a new session with the same setup as a previous one. |
| `GET` | `/sessions/{id}/next-question` | Get the next question, chosen adaptively. |
| `GET` | `/sessions/{id}/progress` | Score and progress for a session. |
| `GET` | `/sessions/{id}/questions` | Full question batch (used for offline caching). |
| `POST` | `/attempts` | Submit an answer; returns correctness and misconception feedback. |
| `POST` | `/documents/upload` | Upload study material for quiz generation. |
| `GET` | `/users/me/overview` | Dashboard data: learning curve and concept mastery. |
| `GET` | `/users/me/recovery` | "What to study next" recommendation, or `null`. |
| `GET` | `/todos` | List to-dos. |
| `POST` | `/todos` | Create a to-do. |
| `PATCH` | `/todos/{id}` | Update a to-do. |
| `DELETE` | `/todos/{id}` | Delete a to-do. |
| `GET` | `/` | Health check (no auth). |

Full request and response schemas are available at `/docs` when the backend is running.

---

## Database schema

| Table | Purpose |
| --- | --- |
| `profiles` | One row per user, linked 1:1 to Supabase `auth.users`. Created by trigger. |
| `documents` | Extracted text from uploaded study material. |
| `quiz_sessions` | One row per quiz: subject, exam type, difficulty range, time limit. |
| `questions` | Generated questions with options, correct answer, concept, difficulty, explanation. |
| `attempts` | Every answer a student gives, used for all analytics. |
| `todos` | Study to-do items. |

`schema.sql` is idempotent (`IF NOT EXISTS` throughout), so `python setup_db.py` is safe to run repeatedly, for first-time setup and for upgrades. It never drops data.

> The `users` table and the files `migrate_users_to_supabase.py` and `supabase_migration_situation_b.sql` are left over from moving the app from its earlier custom login to Supabase Auth. They are only needed if you still have old accounts to migrate.

---

## Deployment

The backend and front end deploy separately, for example the API on Render and the front end on Vercel or Render Static.

**Backend**
- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Set every variable from the backend table above.
- Set `CORS_ORIGINS` to the **exact** front-end URL. Otherwise the browser blocks every request.

**Front end**
- Build command: `npm run build`, publish the `dist` folder.
- Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` and `VITE_API_BASE` (pointing at the deployed backend) **before** building. Vite bakes them in at build time.
- Add the deployed URL to Supabase's Redirect URLs.

---

## Troubleshooting

| Problem | Likely cause and fix |
| --- | --- |
| "Could not reach the server" in the app | Backend is stopped, `VITE_API_BASE` is wrong, or `CORS_ORIGINS` does not include the front-end URL. |
| Every request returns 500 mentioning `SUPABASE_JWT_SECRET` | The secret is not set on the backend. |
| Every request returns 401 "Invalid session" | `SUPABASE_JWT_SECRET` does not match the Supabase project the front end uses. |
| "Account no longer exists" | The user has no `profiles` row. Confirm the `on_auth_user_created` trigger exists (run `python setup_db.py`). |
| Backend fails at startup mentioning `DATABASE_URL` | The variable is empty or still a placeholder host. |
| Quiz generation fails | Check `GROQ_API_KEY`, and the `AI_TIMEOUT_SECONDS` limit. |
| Can't log in right after sign-up | Email confirmation is on. Click the link in the confirmation email first. |

---

d your license here.
