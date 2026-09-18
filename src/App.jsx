import { useCallback, useEffect, useRef, useState } from "react";
import QuestionCard from "./components/QuestionCard";
import OnboardingForm from "./components/OnboardingForm";
import Login from "./components/Login";
import Dashboard from "./components/Dashboard";
import ThemeToggle from "./components/ThemeToggle";
import { downloadReport } from "./downloadReport";
import {
  loadUser,
  saveUser,
  clearUser,
  loadOfflineBanks,
  saveOfflineBank,
  enqueueSyncItem,
  loadSyncQueue,
  removeSyncItems,
  countPendingSync,
} from "./offlineStore";
import { apiFetch, describeFetchError } from "./api";


const API_BASE = import.meta.env.VITE_API_BASE;

// A bare "Failed to fetch" from the browser's fetch() is almost always
// either (a) the backend is unreachable at API_BASE, or (b) the backend
// responded but CORS_ORIGINS on the backend doesn't include this site's
// origin, so the browser threw the response away. Surface that instead of
// a generic message so it's actionable without opening devtools.


function App() {
  // login -> home -> setup -> quiz -> summary
  //                -> offlinePractice -> offlineQuiz -> offlineSummary
  //                -> dashboard (learning curve + overall impression, cross-session)
  const [step, setStep] = useState("login");
  const [user, setUser] = useState(null); // { user_id, name }

  const [session, setSession] = useState(null); // { session_id, user_id, total_questions, time_limit, source }
  const [question, setQuestion] = useState(null);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState([]);
  const [timeLeft, setTimeLeft] = useState(0);

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Offline mode state
  const [offlineBanks, setOfflineBanks] = useState([]);
  const [activeBank, setActiveBank] = useState(null); // the bank being replayed
  const [offlineIndex, setOfflineIndex] = useState(0);
  const [offlineAnswers, setOfflineAnswers] = useState([]); // per-question {isCorrect, ...}
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  // Keep the latest session in a ref so the single long-lived timer
  // interval below never has to be torn down and rebuilt every second.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const userRef = useRef(user);
  userRef.current = user;

  // ---- Offline sync: replay queued offline answers against the real
  // /attempts endpoint as soon as we're back online. The backend re-grades
  // and re-validates every one of them (see routers/attempts.py) — nothing
  // here is trusted as a final score, it's just "try to deliver this
  // answer now that we can."
  const syncPendingAttempts = useCallback(async () => {
    const currentUser = userRef.current;
    if (!currentUser || syncing) return;
    const queue = loadSyncQueue(currentUser.user_id);
    if (!queue.length) {
      setPendingSyncCount(0);
      return;
    }
    setSyncing(true);
    const synced = [];
    for (const item of queue) {
      try {
        const response = await apiFetch(`/attempts`, {
          method: "POST",
          body: JSON.stringify({
            question_id: item.questionId,
            selected_answer: item.answer,
            from_offline_sync: true,
          }),
        });
        // Any response the server actually returned (even a 4xx like "question
        // not found") means this item is resolved and shouldn't be retried
        // forever; only a network failure (thrown below) leaves it queued.
        if (response) synced.push(item.clientId);
      } catch (err) {
        // Still offline, or the request failed outright — leave this (and
        // everything after it, since order doesn't matter here) queued for
        // the next attempt.
        console.error("Offline sync failed for one item:", err);
      }
    }
    if (synced.length) {
      const remaining = removeSyncItems(currentUser.user_id, synced);
      setPendingSyncCount(remaining.length);
    }
    setSyncing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing]);

  // Try to flush the queue whenever connectivity comes back, and once on
  // startup in case it was never flushed last session.
  useEffect(() => {
    function handleOnline() {
      syncPendingAttempts();
    }
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [syncPendingAttempts]);

  // Restore a logged-in user on load, so the name never has to be typed twice.
  useEffect(() => {
    const stored = loadUser();
    if (stored) {
      setUser(stored);
      setOfflineBanks(loadOfflineBanks(stored.user_id));
      setPendingSyncCount(countPendingSync(stored.user_id));
      setStep("home");
      if (navigator.onLine) syncPendingAttempts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleAuthenticated(authedUser) {
    setUser(authedUser);
    saveUser(authedUser);
    setOfflineBanks(loadOfflineBanks(authedUser.user_id));
    setPendingSyncCount(countPendingSync(authedUser.user_id));
    setStep("home");
    if (navigator.onLine) syncPendingAttempts();
  }

  function handleLogout() {
    clearUser();
    setUser(null);
    setStep("login");
  }

  const finishSession = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const response = await apiFetch(`/sessions/${current.session_id}/progress`);
      const data = await response.json();
      setProgress(data);
    } catch (err) {
      console.error("Progress error:", err);
    } finally {
      setStep("summary");
    }
  }, []);

  // Countdown timer: one interval for the whole quiz, not recreated each
  // tick. It just decrements state and calls finishSession once at zero.
  useEffect(() => {
    if (step !== "quiz") return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          finishSession();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [step, finishSession]);

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  // After a session is created, pull down the whole question batch (which
  // is already fully generated and stored server-side at this point — no
  // extra AI call) and cache it locally. That cached copy is what lets
  // "Practice Offline" work later with zero network calls.
  async function cacheSessionForOffline(sessionData) {
    try {
      const response = await apiFetch(`/sessions/${sessionData.session_id}/questions`);
      if (!response.ok) return;
      const questions = await response.json();
      const bank = {
        bankId: `${sessionData.session_id}-${Date.now()}`,
        subject: sessionData.subject,
        examType: sessionData.exam_type,
        totalQuestions: questions.length,
        createdAt: new Date().toISOString(),
        questions,
      };
      const ok = saveOfflineBank(sessionData.user_id, bank);
      if (ok) setOfflineBanks(loadOfflineBanks(sessionData.user_id));
    } catch (err) {
      // Offline caching is a bonus, not a requirement — a failure here
      // should never interrupt the (already-successful) live quiz.
      console.error("Offline caching failed:", err);
    }
  }

  async function startSession(payload) {
    setLoading(true);
    setError("");

    try {
      const response = await apiFetch(`/sessions`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || "Failed to create quiz session");
      }

      const data = await response.json();
      setSession(data);
      setQuestion(data.first_question);
      setAnsweredCount(0);
      setResult(null);
      setTimeLeft(data.time_limit * 60);
      setStep("quiz");
      cacheSessionForOffline(data); // fire-and-forget, doesn't block the quiz
    } catch (err) {
      console.error(err);
      setError(describeFetchError(err));
    } finally {
      setLoading(false);
    }
  }

  // Learning-recovery flow: jump straight into a short, targeted quiz on
  // whatever concept the dashboard identified as WEAK (see
  // GET /users/me/recovery), instead of routing back through the general
  // setup form. Reuses the exact same /sessions endpoint and adaptive
  // next-question logic as any other quiz — "targeted" here just means the
  // AI is told which concept to focus on via `topic`.
  function startTargetedPractice(recommendation) {
    const note = recommendation.suspected_misconception
      ? `The student has a suspected misconception on "${recommendation.concept}": ${recommendation.suspected_misconception}. Write questions that directly test whether this misconception is still present.`
      : `The student is weak on "${recommendation.concept}". Focus every question tightly on this concept.`;
    startSession({
      subject: recommendation.concept,
      exam_type: "General",
      topic: recommendation.concept,
      custom_request: note,
      total_questions: recommendation.recommended_question_count || 5,
      min_difficulty: "Easy",
      max_difficulty: "Medium",
      time_limit: 15,
      document_id: null,
    });
  }

  async function submitAnswer(questionId, answer) {
    if (!session || submitting) return;
    setSubmitting(true);
    try {
      const response = await apiFetch(`/attempts`, {
        method: "POST",
        body: JSON.stringify({
          question_id: questionId,
          selected_answer: answer,
        }),
      });

      if (!response.ok) throw new Error("Failed to submit answer");

      const data = await response.json();
      setResult(data);
      setAnsweredCount((prev) => prev + 1);

      if (data.session_complete) {
        await finishSession();
      }
    } catch (err) {
      console.error("Submit answer error:", err);
      setError("Could not submit answer");
    } finally {
      setSubmitting(false);
    }
  }

  async function loadNextQuestion() {
    if (!session) return;
    setLoading(true);
    setResult(null);

    try {
      const response = await apiFetch(`/sessions/${session.session_id}/next-question`);
      const data = await response.json();

      if (data.session_complete) {
        await finishSession();
        return;
      }
      setQuestion(data);
    } catch (err) {
      console.error("Next question error:", err);
      setError("Could not load the next question");
    } finally {
      setLoading(false);
    }
  }

  function resetToHome() {
    setStep("home");
    setSession(null);
    setQuestion(null);
    setResult(null);
    setProgress([]);
    setAnsweredCount(0);
    setError("");
  }

  // ---- Offline practice: entirely local, no network calls ----

  function startOfflineBank(bank) {
    setActiveBank(bank);
    setOfflineIndex(0);
    setOfflineAnswers([]);
    setResult(null);
    setStep("offlineQuiz");
  }

  function submitOfflineAnswer(questionId, answer) {
    const q = activeBank.questions[offlineIndex];
    const isCorrect = answer.trim() === q.correct_answer.trim();
    const offlineResult = {
      is_correct: isCorrect,
      correct_answer: q.correct_answer,
      misconception_analysis: isCorrect
        ? null
        : {
          targeted_explanation:
            q.explanation || "Review this concept and try a similar question.",
        },
    };
    setResult(offlineResult);
    setOfflineAnswers((prev) => [...prev, { concept: q.concept, isCorrect }]);

    // Queue for sync instead of trusting this local score as final — the
    // backend re-grades every one of these against the stored correct
    // answer once they're replayed (see routers/attempts.py). The client's
    // isCorrect above is only ever used for the immediate on-screen
    // feedback and the local offline summary, never sent as the score.
    if (user) {
      const updatedQueue = enqueueSyncItem(user.user_id, {
        questionId,
        answer,
      });
      setPendingSyncCount(updatedQueue.length);
    }
  }

  function nextOfflineQuestion() {
    setResult(null);
    if (offlineIndex + 1 >= activeBank.questions.length) {
      setStep("offlineSummary");
      // Best-effort: try to flush the queue right away in case
      // connectivity is actually available (e.g. this bank was replayed
      // for review, not out of necessity). If it's not, these stay queued
      // and the "online" listener above will retry later.
      if (navigator.onLine) syncPendingAttempts();
    } else {
      setOfflineIndex((i) => i + 1);
    }
  }

  function offlineProgress() {
    const byConcept = {};
    for (const a of offlineAnswers) {
      const entry = byConcept[a.concept] || { attempts: 0, correct: 0 };
      entry.attempts += 1;
      if (a.isCorrect) entry.correct += 1;
      byConcept[a.concept] = entry;
    }
    return Object.entries(byConcept).map(([concept, v]) => ({
      concept,
      attempts: v.attempts,
      correct: v.correct,
      accuracy: v.attempts ? Math.round((v.correct / v.attempts) * 1000) / 10 : 0,
    }));
  }

  function downloadOnlineReport() {
    downloadReport({
      filename: `quiz-report-${session?.session_id ?? "session"}.txt`,
      title: "AI Learning Platform - Quiz Report",
      meta: {
        Student: user?.name,
        Subject: session?.subject,
        "Exam type": session?.exam_type,
        "Questions answered": answeredCount,
        Date: new Date().toLocaleString(),
      },
      progress,
    });
  }

  function downloadOfflineReport() {
    downloadReport({
      filename: `offline-quiz-report-${activeBank?.bankId ?? "session"}.txt`,
      title: "AI Learning Platform - Offline Quiz Report",
      meta: {
        Student: user?.name,
        Subject: activeBank?.subject,
        "Exam type": activeBank?.examType,
        "Questions answered": offlineAnswers.length,
        Date: new Date().toLocaleString(),
        Mode: "Offline (no internet used)",
      },
      progress: offlineProgress(),
    });
  }

  const totalQuestions = session?.total_questions ?? 0;
  const quizProgressPct = totalQuestions
    ? Math.min(100, (answeredCount / totalQuestions) * 100)
    : 0;

  return (
    <main className="paper-field relative min-h-screen font-body text-ink">
      {step !== "login" && user && (
        <header className="sticky top-0 z-10 border-b border-line bg-paper-raised/90 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 sm:px-6">
            <button
              onClick={() => setStep("home")}
              className="flex items-center gap-2"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-paper font-display text-sm font-semibold text-accent-ink">
                A+
              </span>
              <span className="hidden font-display text-base font-semibold text-ink sm:inline">
                AI Learning Platform
              </span>
            </button>

            <nav className="flex items-center gap-1 rounded-full border border-line bg-paper p-1 text-sm font-medium">
              <button
                onClick={() => setStep("home")}
                className={`rounded-full px-3 py-1.5 transition ${step === "home"
                  ? "bg-paper-raised text-ink shadow-sm ring-1 ring-line-strong"
                  : "text-muted hover:text-ink-soft"
                  }`}
              >
                Home
              </button>
              <button
                onClick={() => setStep("dashboard")}
                className={`rounded-full px-3 py-1.5 transition ${step === "dashboard"
                  ? "bg-paper-raised text-ink shadow-sm ring-1 ring-line-strong"
                  : "text-muted hover:text-ink-soft"
                  }`}
              >
                Dashboard
              </button>
            </nav>

            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-muted sm:inline">{user.name}</span>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-ink">
                {user.name?.[0]?.toUpperCase() || "?"}
              </span>
              <ThemeToggle />
              <button
                onClick={handleLogout}
                className="text-sm font-medium text-muted underline-offset-2 hover:text-ink-soft hover:underline"
              >
                Log out
              </button>
            </div>
          </div>
        </header>
      )}

      <div className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
        {step === "login" && (
          <div className="animate-rise-in mb-8 text-center sm:mb-10">
            <div className="mb-3 flex items-center justify-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-paper-raised font-display text-sm font-semibold text-accent-ink">
                A+
              </span>
              <ThemeToggle className="absolute right-4 top-4 sm:right-6 sm:top-6" />
            </div>
            <h1 className="font-display text-[1.75rem] font-semibold tracking-tight text-ink sm:text-3xl">
              AI Learning Platform
            </h1>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted sm:text-base">
              Learn from your mistakes, not just your answers.
            </p>
          </div>
        )}

        {error && step !== "setup" && (
          <div className="animate-rise-in mb-6 flex items-start gap-3 rounded-xl border border-error-soft bg-error-soft/70 p-4 text-sm text-error-text">
            <span className="mt-0.5 text-error">✕</span>
            <span>{error}</span>
          </div>
        )}

        {step === "login" && (
          <div className="animate-rise-in flex justify-center">
            <Login apiBase={API_BASE} onAuthenticated={handleAuthenticated} />
          </div>
        )}

        {step === "home" && (
          <div className="animate-rise-in grid gap-4 sm:grid-cols-2">
            <button
              onClick={() => setStep("setup")}
              className="rounded-2xl border border-line bg-paper-raised p-6 text-left shadow-card transition hover:border-accent hover:bg-accent-soft/20"
            >
              <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-xl">
                ✨
              </span>
              <h3 className="font-display text-lg font-semibold text-ink">Start a New Quiz</h3>
              <p className="mt-1 text-sm text-muted">
                Generate fresh questions on any subject. Needs internet.
              </p>
            </button>

            <button
              onClick={() => offlineBanks.length && setStep("offlinePractice")}
              disabled={!offlineBanks.length}
              className="rounded-2xl border border-line bg-paper-raised p-6 text-left shadow-card transition hover:border-accent hover:bg-accent-soft/20 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-paper-raised"
            >
              <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-xl">
                📴
              </span>
              <h3 className="font-display text-lg font-semibold text-ink">Practice Offline</h3>
              <p className="mt-1 text-sm text-muted">
                {offlineBanks.length
                  ? `${offlineBanks.length} saved question set${offlineBanks.length === 1 ? "" : "s"} ready — no internet needed.`
                  : "Complete a quiz online first — it's saved here automatically for offline replay."}
              </p>
              {pendingSyncCount > 0 && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-ink">
                  ⏳ {pendingSyncCount} answer{pendingSyncCount === 1 ? "" : "s"} pending sync
                </p>
              )}
            </button>

            <button
              onClick={() => setStep("dashboard")}
              className="rounded-2xl border border-line bg-paper-raised p-6 text-left shadow-card transition hover:border-accent hover:bg-accent-soft/20 sm:col-span-2"
            >
              <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-xl">
                📈
              </span>
              <h3 className="font-display text-lg font-semibold text-ink">Your Progress</h3>
              <p className="mt-1 text-sm text-muted">
                See your learning curve and overall impression across every session.
              </p>
            </button>
          </div>
        )}

        {step === "dashboard" && (
          <Dashboard
            onBack={() => setStep("home")}
            onStartQuiz={() => setStep("setup")}
            onStartTargeted={startTargetedPractice}
          />
        )}

        {step === "setup" && (
          <div className="animate-rise-in">
            <OnboardingForm
              apiBase={API_BASE}
              userId={user?.user_id}
              onGenerate={startSession}
              loading={loading}
              error={error}
            />
          </div>
        )}

        {step === "quiz" && question && (
          <div className="animate-rise-in">
            <div className="mb-3 flex items-center justify-between gap-3 text-sm font-medium">
              <span className="text-ink-soft">
                Question <span className="font-semibold text-ink">{answeredCount + 1}</span> of {totalQuestions}
                {session?.source === "document" && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">
                    from your document
                  </span>
                )}
                {session?.source === "cached" && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-ink">
                    ⚡ instant set
                  </span>
                )}
              </span>
              <span
                className={`tabular-nums inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${timeLeft < 60
                  ? "border-error-soft bg-error-soft text-error-text"
                  : "border-line-strong bg-paper-raised text-ink-soft"
                  }`}
              >
                ⏱ {formatTime(timeLeft)}
              </span>
            </div>

            <div className="mb-5 h-2 w-full overflow-hidden rounded-full border border-line bg-paper-raised">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
                style={{ width: `${quizProgressPct}%` }}
              />
            </div>

            <QuestionCard question={question} onSubmitAnswer={submitAnswer} submitting={submitting} />

            {result && (
              <div className="animate-stamp-in mt-5 rounded-2xl border border-line bg-paper-raised p-5 shadow-card sm:p-6">
                {result.is_correct ? (
                  <div className="flex items-center justify-center gap-2 text-center">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success-soft text-lg font-bold text-success-text">
                      ✓
                    </span>
                    <p className="font-display text-xl font-semibold text-success-text">Correct!</p>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-error-soft text-lg font-bold text-error-text">
                        ✕
                      </span>
                      <p className="pt-1.5 font-semibold text-error-text">
                        Incorrect. Correct answer: {result.correct_answer}
                      </p>
                    </div>
                    {result.misconception_analysis && (
                      <p className="mt-3 rounded-xl border-l-4 border-accent bg-accent-soft/50 p-3 text-sm leading-relaxed text-ink-soft">
                        {result.misconception_analysis.targeted_explanation}
                      </p>
                    )}
                  </div>
                )}

                <button
                  onClick={loadNextQuestion}
                  disabled={loading}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-ink py-3 font-semibold text-paper-raised transition hover:bg-ink-soft active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-faint"
                >
                  {loading ? (
                    <>
                      <span className="animate-spin-slow h-4 w-4 rounded-full border-2 border-paper-raised/40 border-t-paper-raised" />
                      Loading...
                    </>
                  ) : (
                    <>Next Question →</>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {step === "summary" && (
          <div className="animate-rise-in rounded-2xl border border-line bg-paper-raised p-6 text-center shadow-card sm:p-8">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-2xl">
              🎉
            </span>
            <h2 className="mb-2 font-display text-2xl font-semibold text-ink">Session Complete!</h2>
            <p className="mb-7 text-sm text-muted sm:text-base">
              You answered {answeredCount} questions in {session?.subject}.
            </p>
            <p className="mb-7 text-xs text-faint">
              This question set has been saved for offline practice too.
            </p>

            {progress.length === 0 && (
              <p className="mb-7 rounded-xl border border-dashed border-line-strong bg-paper p-4 text-sm text-muted">
                No attempts were recorded for this session.
              </p>
            )}

            <div className="space-y-4 text-left">
              {progress.map((item) => (
                <div key={item.concept}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <span className="font-medium text-ink-soft">{item.concept}</span>
                    <span
                      className={`text-sm font-semibold ${item.accuracy >= 70
                        ? "text-success-text"
                        : item.accuracy >= 40
                          ? "text-accent-ink"
                          : "text-error-text"
                        }`}
                    >
                      {item.accuracy}%
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full border border-line bg-paper">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ease-out ${item.accuracy >= 70
                        ? "bg-success"
                        : item.accuracy >= 40
                          ? "bg-accent"
                          : "bg-error"
                        }`}
                      style={{ width: `${item.accuracy}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={downloadOnlineReport}
              className="mt-8 mr-3 rounded-xl border border-line-strong bg-paper px-6 py-3 font-semibold text-ink-soft transition hover:bg-paper-raised active:scale-[0.99]"
            >
              ⬇ Download Report
            </button>
            <button
              onClick={() => setStep("dashboard")}
              className="mt-8 mr-3 rounded-xl border border-line-strong bg-paper px-6 py-3 font-semibold text-ink-soft transition hover:bg-paper-raised active:scale-[0.99]"
            >
              📈 Learning Curve
            </button>
            <button
              onClick={resetToHome}
              className="mt-8 rounded-xl bg-ink px-6 py-3 font-semibold text-paper-raised transition hover:bg-ink-soft active:scale-[0.99]"
            >
              Back to Home
            </button>
          </div>
        )}

        {step === "offlinePractice" && (
          <div className="animate-rise-in rounded-2xl border border-line bg-paper-raised p-6 shadow-card sm:p-8">
            <h2 className="mb-1 font-display text-xl font-semibold text-ink">Practice Offline</h2>
            <p className="mb-6 text-sm text-muted">
              These question sets were saved on this device — no internet needed to use them.
            </p>
            <div className="space-y-3">
              {offlineBanks.map((bank) => (
                <button
                  key={bank.bankId}
                  onClick={() => startOfflineBank(bank)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-paper p-4 text-left transition hover:border-accent hover:bg-accent-soft/20"
                >
                  <div>
                    <p className="font-medium text-ink">
                      {bank.subject} <span className="text-faint">· {bank.examType}</span>
                    </p>
                    <p className="text-xs text-faint">
                      {bank.totalQuestions} questions · saved {new Date(bank.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="text-accent-ink">→</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setStep("home")}
              className="mt-6 text-sm font-medium text-muted underline hover:text-ink-soft"
            >
              ← Back
            </button>
          </div>
        )}

        {step === "offlineQuiz" && activeBank && (
          <div className="animate-rise-in">
            <div className="mb-3 flex items-center justify-between gap-3 text-sm font-medium">
              <span className="text-ink-soft">
                Question <span className="font-semibold text-ink">{offlineIndex + 1}</span> of{" "}
                {activeBank.questions.length}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-paper-raised px-3 py-1 text-xs font-semibold text-ink-soft">
                📴 Offline
              </span>
            </div>

            <div className="mb-5 h-2 w-full overflow-hidden rounded-full border border-line bg-paper-raised">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
                style={{ width: `${((offlineIndex + (result ? 1 : 0)) / activeBank.questions.length) * 100}%` }}
              />
            </div>

            <QuestionCard
              question={activeBank.questions[offlineIndex]}
              onSubmitAnswer={submitOfflineAnswer}
              submitting={false}
            />

            {result && (
              <div className="animate-stamp-in mt-5 rounded-2xl border border-line bg-paper-raised p-5 shadow-card sm:p-6">
                {result.is_correct ? (
                  <div className="flex items-center justify-center gap-2 text-center">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success-soft text-lg font-bold text-success-text">
                      ✓
                    </span>
                    <p className="font-display text-xl font-semibold text-success-text">Correct!</p>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-error-soft text-lg font-bold text-error-text">
                        ✕
                      </span>
                      <p className="pt-1.5 font-semibold text-error-text">
                        Incorrect. Correct answer: {result.correct_answer}
                      </p>
                    </div>
                    {result.misconception_analysis && (
                      <p className="mt-3 rounded-xl border-l-4 border-accent bg-accent-soft/50 p-3 text-sm leading-relaxed text-ink-soft">
                        {result.misconception_analysis.targeted_explanation}
                      </p>
                    )}
                  </div>
                )}

                <button
                  onClick={nextOfflineQuestion}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-ink py-3 font-semibold text-paper-raised transition hover:bg-ink-soft active:scale-[0.99]"
                >
                  {offlineIndex + 1 >= activeBank.questions.length ? "See Results →" : "Next Question →"}
                </button>
              </div>
            )}
          </div>
        )}

        {step === "offlineSummary" && activeBank && (
          <div className="animate-rise-in rounded-2xl border border-line bg-paper-raised p-6 text-center shadow-card sm:p-8">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-2xl">
              📴
            </span>
            <h2 className="mb-2 font-display text-2xl font-semibold text-ink">Offline Session Complete!</h2>
            <p className="mb-7 text-sm text-muted sm:text-base">
              You answered {offlineAnswers.length} questions in {activeBank.subject} — no internet used.
            </p>
            <p className="mb-7 text-xs text-faint">
              {pendingSyncCount > 0
                ? `⏳ ${pendingSyncCount} answer${pendingSyncCount === 1 ? "" : "s"} will sync to your account automatically once you're back online.`
                : "✓ Synced to your account."}
            </p>

            <div className="space-y-4 text-left">
              {offlineProgress().map((item) => (
                <div key={item.concept}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <span className="font-medium text-ink-soft">{item.concept}</span>
                    <span
                      className={`text-sm font-semibold ${item.accuracy >= 70
                        ? "text-success-text"
                        : item.accuracy >= 40
                          ? "text-accent-ink"
                          : "text-error-text"
                        }`}
                    >
                      {item.accuracy}%
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full border border-line bg-paper">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ease-out ${item.accuracy >= 70
                        ? "bg-success"
                        : item.accuracy >= 40
                          ? "bg-accent"
                          : "bg-error"
                        }`}
                      style={{ width: `${item.accuracy}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={downloadOfflineReport}
              className="mt-8 mr-3 rounded-xl border border-line-strong bg-paper px-6 py-3 font-semibold text-ink-soft transition hover:bg-paper-raised active:scale-[0.99]"
            >
              ⬇ Download Report
            </button>
            <button
              onClick={() => setStep("dashboard")}
              className="mt-8 mr-3 rounded-xl border border-line-strong bg-paper px-6 py-3 font-semibold text-ink-soft transition hover:bg-paper-raised active:scale-[0.99]"
            >
              📈 Learning Curve
            </button>
            <button
              onClick={() => setStep("home")}
              className="mt-8 rounded-xl bg-ink px-6 py-3 font-semibold text-paper-raised transition hover:bg-ink-soft active:scale-[0.99]"
            >
              Back to Home
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default App;
