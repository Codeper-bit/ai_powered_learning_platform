import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QuestionCard from "./components/QuestionCard";
import OnboardingForm from "./components/OnboardingForm";
import ThemeToggle from "./components/ThemeToggle";
import { ConceptBars, QuizFeedback, Spinner } from "./components/ui";
import { downloadReport } from "./downloadReport";
import {
  loadOfflineBanks,
  saveOfflineBank,
  enqueueSyncItem,
  newAttemptKey,
  loadSyncQueue,
  removeSyncItems,
  countPendingSync,
} from "./offlineStore";
import { apiFetch, apiFetchJson, describeFetchError } from "./api";
import { getDeviceId } from "./identity";

// The charts library is the heaviest part of the app and is only needed on
// the dashboard, so it loads on demand instead of delaying the first paint.
const Dashboard = lazy(() => import("./components/Dashboard"));

// This browser's id (see identity.js). Also keys the offline caches.
const LEARNER_ID = getDeviceId();

const NAV_LINK = "rounded-full px-3 py-1.5 transition-colors duration-150";
const NAV_ACTIVE = "bg-paper-raised text-ink shadow-sm ring-1 ring-line-strong";
const NAV_IDLE = "text-muted hover:text-ink-soft";

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function PageLoading({ label }) {
  return (
    <div className="rounded-2xl border border-line bg-paper-raised p-8 text-center shadow-card">
      <Spinner className="mx-auto mb-3 h-6 w-6 text-accent" />
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}

function HomeCard({ icon, title, children, onClick, disabled = false, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-2xl border border-line bg-paper-raised p-5 text-left shadow-card transition-colors duration-150 hover:border-accent hover:bg-accent-soft/20 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-paper-raised sm:p-6 ${className}`}
    >
      <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-xl">
        {icon}
      </span>
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      {children}
    </button>
  );
}

function SummaryActions({ onReport, onCurve, onHome }) {
  return (
    <div className="mt-8 grid gap-3 sm:flex sm:flex-wrap sm:justify-center">
      <button type="button" onClick={onReport} className="btn-secondary">
        ⬇ Download Report
      </button>
      <button type="button" onClick={onCurve} className="btn-secondary">
        📈 Learning Curve
      </button>
      <button type="button" onClick={onHome} className="btn-primary">
        Back to Home
      </button>
    </div>
  );
}

function App() {
  // home -> setup -> quiz -> summary
  //      -> offlinePractice -> offlineQuiz -> offlineSummary
  //      -> dashboard (learning curve + overall impression, cross-session)
  const [step, setStep] = useState("home");

  const [session, setSession] = useState(null); // { session_id, user_id, total_questions, time_limit, source }
  const [question, setQuestion] = useState(null);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState([]);
  const [timeLeft, setTimeLeft] = useState(0);

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(() => navigator.onLine);

  // "Retry" on the summary screen. The ref is the real double-click guard
  // (state updates are async, so two fast clicks could both see
  // retrying === false); the state just drives the button's loading UI.
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const retryLockRef = useRef(false);

  // Offline mode
  const [offlineBanks, setOfflineBanks] = useState(() => loadOfflineBanks(LEARNER_ID));
  const [activeBank, setActiveBank] = useState(null);
  const [offlineIndex, setOfflineIndex] = useState(0);
  const [offlineAnswers, setOfflineAnswers] = useState([]); // { concept, isCorrect }
  const [pendingSyncCount, setPendingSyncCount] = useState(() => countPendingSync(LEARNER_ID));

  // Latest session for callbacks that outlive a render (timer, finish).
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const finishLockRef = useRef(false); // finishSession runs once per quiz
  const deadlineRef = useRef(0); // wall-clock end of the quiz (ms)
  const nextRef = useRef(null); // prefetched next question { sid, promise }
  const syncLockRef = useRef(false);
  const errorRef = useRef(null);

  function go(nextStep) {
    setError("");
    setStep(nextStep);
  }

  // ---- Connectivity -------------------------------------------------------
  // Replay answers queued while offline against the real /attempts endpoint.
  // The backend re-grades every one of them (routers/attempts.py): nothing
  // here is trusted as a score, it is just "deliver this answer now".
  const syncPendingAttempts = useCallback(async () => {
    if (syncLockRef.current) return;
    const queue = loadSyncQueue(LEARNER_ID);
    if (!queue.length) {
      setPendingSyncCount(0);
      return;
    }
    syncLockRef.current = true;
    const synced = [];
    try {
      for (const item of queue) {
        try {
          const response = await apiFetch(`/attempts`, {
            method: "POST",
            body: JSON.stringify({
              question_id: item.questionId,
              selected_answer: item.answer,
              from_offline_sync: true,
              // Same key on every re-send, so a retry after a lost response
              // can't record the answer twice.
              attempt_key: item.attemptKey,
            }),
          });
          // Delivered (2xx) or permanently rejected (4xx other than 408/429)
          // means resolved; network errors and 5xx/408/429 stay queued.
          const permanent =
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429;
          if (response.ok || permanent) synced.push(item.clientId);
        } catch (err) {
          console.error("Offline sync failed for one item:", err);
        }
      }
      if (synced.length) {
        setPendingSyncCount(removeSyncItems(LEARNER_ID, synced).length);
      }
    } finally {
      syncLockRef.current = false;
    }
  }, []);

  useEffect(() => {
    function handleOnline() {
      setOnline(true);
      syncPendingAttempts();
    }
    function handleOffline() {
      setOnline(false);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    if (navigator.onLine) syncPendingAttempts(); // flush anything left from last time
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [syncPendingAttempts]);

  // ---- Page behaviour -----------------------------------------------------
  // New screen / new question: start at the top. Errors: make sure they're seen.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step, question?.id, offlineIndex]);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  // ---- Quiz clock ---------------------------------------------------------
  // Counts down to a wall-clock deadline rather than decrementing once per
  // tick, so it stays accurate when a phone throttles a background tab.
  const finishSession = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || finishLockRef.current) return;
    finishLockRef.current = true;
    try {
      setProgress(await apiFetchJson(`/sessions/${current.session_id}/progress`));
    } catch (err) {
      console.error("Progress error:", err);
    } finally {
      setStep("summary");
    }
  }, []);

  useEffect(() => {
    if (step !== "quiz") return;
    const tick = () =>
      setTimeLeft(Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)));
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [step]);

  // Time's up. (An effect, not a side effect inside a state updater.)
  useEffect(() => {
    if (step === "quiz" && timeLeft === 0 && sessionRef.current) finishSession();
  }, [step, timeLeft, finishSession]);

  // ---- Online quiz --------------------------------------------------------
  // Pull the whole (already generated and stored) question batch down and keep
  // it locally; that copy is what lets "Practice Offline" work with no network.
  async function cacheSessionForOffline(sessionData) {
    try {
      const questions = await apiFetchJson(`/sessions/${sessionData.session_id}/questions`);
      const saved = saveOfflineBank(LEARNER_ID, {
        bankId: `${sessionData.session_id}-${Date.now()}`,
        subject: sessionData.subject,
        examType: sessionData.exam_type,
        totalQuestions: questions.length,
        createdAt: new Date().toISOString(),
        questions,
      });
      if (saved) setOfflineBanks(loadOfflineBanks(LEARNER_ID));
    } catch (err) {
      // A bonus, never a reason to interrupt the live quiz.
      console.error("Offline caching failed:", err);
    }
  }

  // Shared by startSession and retryQuiz: enter a newly created session.
  function beginSession(data) {
    finishLockRef.current = false;
    nextRef.current = null;
    deadlineRef.current = Date.now() + data.time_limit * 60 * 1000;
    setSession(data);
    setQuestion(data.first_question);
    setAnsweredCount(0);
    setResult(null);
    setProgress([]);
    setError("");
    setTimeLeft(data.time_limit * 60);
    setStep("quiz");
    cacheSessionForOffline(data); // fire-and-forget
  }

  async function startSession(payload) {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      beginSession(await apiFetchJson(`/sessions`, { method: "POST", body: JSON.stringify(payload) }));
    } catch (err) {
      console.error(err);
      setError(describeFetchError(err));
    } finally {
      setLoading(false);
    }
  }

  // The server rebuilds the setup from the finished session and returns a
  // brand-new session, so the previous one is never touched.
  async function retryQuiz() {
    const current = sessionRef.current;
    if (!current || retryLockRef.current) return;
    if (!navigator.onLine) {
      setRetryError(
        "You're offline. Retry needs an internet connection to create a new quiz. " +
          "You can still use Practice Offline from Home."
      );
      return;
    }
    retryLockRef.current = true;
    setRetrying(true);
    setRetryError("");
    try {
      beginSession(await apiFetchJson(`/sessions/${current.session_id}/retry`, { method: "POST" }));
    } catch (err) {
      console.error("Retry error:", err);
      setRetryError(describeFetchError(err));
    } finally {
      retryLockRef.current = false;
      setRetrying(false);
    }
  }

  // Learning-recovery flow: a short quiz on the concept the dashboard found
  // WEAK, through the same /sessions endpoint as any other quiz. Resolves once
  // the attempt to start has finished, so the dashboard can re-enable its button.
  function startTargetedPractice(recommendation) {
    const note = recommendation.suspected_misconception
      ? `The student has a suspected misconception on "${recommendation.concept}": ${recommendation.suspected_misconception}. Write questions that directly test whether this misconception is still present.`
      : `The student is weak on "${recommendation.concept}". Focus every question tightly on this concept.`;
    return startSession({
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

  // The next question depends only on attempts already stored, so fetch it
  // while the student reads the feedback. "Next" is then instant.
  function prefetchNextQuestion() {
    const sid = sessionRef.current?.session_id;
    if (!sid) return;
    const promise = apiFetchJson(`/sessions/${sid}/next-question`);
    promise.catch(() => {}); // a failed prefetch is retried when they tap Next
    nextRef.current = { sid, promise };
  }

  // Returns false on failure so the card releases the selection for a retry.
  async function submitAnswer(questionId, answer) {
    if (!session || submitting) return false;
    setSubmitting(true);
    setError("");
    try {
      const data = await apiFetchJson(`/attempts`, {
        method: "POST",
        body: JSON.stringify({ question_id: questionId, selected_answer: answer }),
      });
      setResult(data);
      setAnsweredCount((n) => n + 1);
      if (data.session_complete) {
        await finishSession();
      } else {
        prefetchNextQuestion();
      }
      return true;
    } catch (err) {
      console.error("Submit answer error:", err);
      setError(describeFetchError(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function loadNextQuestion() {
    if (!session || loading) return;
    setLoading(true);
    try {
      let data = null;
      const prefetched = nextRef.current;
      nextRef.current = null;
      if (prefetched && prefetched.sid === session.session_id) {
        data = await prefetched.promise.catch(() => null);
      }
      if (!data) data = await apiFetchJson(`/sessions/${session.session_id}/next-question`);

      if (data.session_complete) {
        await finishSession();
        return;
      }
      setResult(null);
      setQuestion(data);
    } catch (err) {
      console.error("Next question error:", err);
      setError(describeFetchError(err));
    } finally {
      setLoading(false);
    }
  }

  function resetToHome() {
    setSession(null);
    setQuestion(null);
    setResult(null);
    setProgress([]);
    setAnsweredCount(0);
    setRetryError("");
    go("home");
  }

  // ---- Offline practice: entirely local, no network calls -----------------
  function startOfflineBank(bank) {
    setActiveBank(bank);
    setOfflineIndex(0);
    setOfflineAnswers([]);
    setResult(null);
    go("offlineQuiz");
  }

  function submitOfflineAnswer(questionId, answer) {
    const q = activeBank.questions[offlineIndex];
    const isCorrect = answer.trim() === q.correct_answer.trim();
    setResult({
      is_correct: isCorrect,
      correct_answer: q.correct_answer,
      misconception_analysis: isCorrect
        ? null
        : { targeted_explanation: q.explanation || "Review this concept and try a similar question." },
    });
    setOfflineAnswers((prev) => [...prev, { concept: q.concept, isCorrect }]);

    // Queue for sync: the backend re-grades each one against the stored
    // answer. This local score only drives the on-screen feedback.
    const queue = enqueueSyncItem(LEARNER_ID, { questionId, answer, attemptKey: newAttemptKey() });
    setPendingSyncCount(queue.length);
    return true;
  }

  function nextOfflineQuestion() {
    setResult(null);
    if (offlineIndex + 1 >= activeBank.questions.length) {
      setStep("offlineSummary");
      if (navigator.onLine) syncPendingAttempts(); // best effort; otherwise the "online" listener retries
    } else {
      setOfflineIndex((i) => i + 1);
    }
  }

  const offlineProgress = useMemo(() => {
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
  }, [offlineAnswers]);

  function downloadOnlineReport() {
    downloadReport({
      filename: `quiz-report-${session?.session_id ?? "session"}.txt`,
      title: "AI Learning Platform - Quiz Report",
      meta: {
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
        Subject: activeBank?.subject,
        "Exam type": activeBank?.examType,
        "Questions answered": offlineAnswers.length,
        Date: new Date().toLocaleString(),
        Mode: "Offline (no internet used)",
      },
      progress: offlineProgress,
    });
  }

  const totalQuestions = session?.total_questions ?? 0;
  const quizProgressPct = totalQuestions
    ? Math.min(100, (answeredCount / totalQuestions) * 100)
    : 0;
  const offlineTotal = activeBank?.questions.length ?? 0;
  const offlineProgressPct = offlineTotal
    ? ((offlineIndex + (result ? 1 : 0)) / offlineTotal) * 100
    : 0;

  return (
    <main className="paper-field relative min-h-dvh font-body text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-paper-raised/95">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <button
            type="button"
            onClick={() => go("home")}
            aria-label="Home"
            className="flex items-center gap-2 rounded-full"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line-strong bg-paper font-display text-sm font-semibold text-accent-ink">
              A+
            </span>
            <span className="hidden font-display text-base font-semibold text-ink sm:inline">
              AI Learning Platform
            </span>
          </button>

          <nav
            aria-label="Main"
            className="flex items-center gap-1 rounded-full border border-line bg-paper p-1 text-sm font-medium"
          >
            <button
              type="button"
              onClick={() => go("home")}
              aria-current={step === "home" ? "page" : undefined}
              className={`${NAV_LINK} ${step === "home" ? NAV_ACTIVE : NAV_IDLE}`}
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => go("dashboard")}
              aria-current={step === "dashboard" ? "page" : undefined}
              className={`${NAV_LINK} ${step === "dashboard" ? NAV_ACTIVE : NAV_IDLE}`}
            >
              Dashboard
            </button>
          </nav>

          <div className="flex items-center gap-2">
            {!online && (
              <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-ink">
                📴 Offline
              </span>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-4 py-6 sm:py-12">
        {error && step !== "setup" && (
          <div
            ref={errorRef}
            role="alert"
            className="animate-rise-in mb-6 flex scroll-mt-20 items-start gap-3 rounded-xl border border-error-soft bg-error-soft/70 p-4 text-sm text-error-text"
          >
            <span className="mt-0.5 text-error">✕</span>
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {step === "home" && (
          <div className="animate-rise-in grid gap-4 sm:grid-cols-2">
            <HomeCard icon="✨" title="Start a New Quiz" onClick={() => go("setup")}>
              <p className="mt-1 text-sm text-muted">
                Generate fresh questions on any subject. Needs internet.
              </p>
            </HomeCard>

            <HomeCard
              icon="📴"
              title="Practice Offline"
              disabled={!offlineBanks.length}
              onClick={() => go("offlinePractice")}
            >
              <p className="mt-1 text-sm text-muted">
                {offlineBanks.length
                  ? `${offlineBanks.length} saved question set${offlineBanks.length === 1 ? "" : "s"} ready. No internet needed.`
                  : "Complete a quiz online first. It's saved here automatically for offline replay."}
              </p>
              {pendingSyncCount > 0 && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-ink">
                  ⏳ {pendingSyncCount} answer{pendingSyncCount === 1 ? "" : "s"} pending sync
                </p>
              )}
            </HomeCard>

            <HomeCard
              icon="📈"
              title="Your Progress"
              onClick={() => go("dashboard")}
              className="sm:col-span-2"
            >
              <p className="mt-1 text-sm text-muted">
                See your learning curve and overall impression across every session.
              </p>
            </HomeCard>
          </div>
        )}

        {step === "dashboard" && (
          <Suspense fallback={<PageLoading label="Loading your progress…" />}>
            <Dashboard
              onBack={() => go("home")}
              onStartQuiz={() => go("setup")}
              onStartTargeted={startTargetedPractice}
            />
          </Suspense>
        )}

        {step === "setup" && (
          <div className="animate-rise-in">
            <OnboardingForm onGenerate={startSession} loading={loading} error={error} />
          </div>
        )}

        {step === "quiz" && question && (
          <div className="animate-rise-in">
            <div className="mb-3 flex items-center justify-between gap-3 text-sm font-medium">
              <span className="min-w-0 text-ink-soft">
                Question{" "}
                <span className="font-semibold text-ink tabular-nums">
                  {Math.min(answeredCount + (result ? 0 : 1), totalQuestions) || 1}
                </span>{" "}
                of {totalQuestions}
                {session?.source === "document" && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">
                    from your document
                  </span>
                )}
                {session?.source === "cached" && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-ink">
                    ⚡ instant set
                  </span>
                )}
              </span>
              <span
                role="timer"
                aria-label="Time left"
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold tabular-nums ${
                  timeLeft < 60
                    ? "border-error-soft bg-error-soft text-error-text"
                    : "border-line-strong bg-paper-raised text-ink-soft"
                }`}
              >
                ⏱ {formatTime(timeLeft)}
              </span>
            </div>

            <div
              role="progressbar"
              aria-label="Quiz progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(quizProgressPct)}
              className="mb-5 h-2 w-full overflow-hidden rounded-full border border-line bg-paper-raised"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                style={{ width: `${quizProgressPct}%` }}
              />
            </div>

            <QuestionCard
              key={question.id}
              question={question}
              onSubmitAnswer={submitAnswer}
              submitting={submitting}
              result={result}
            />

            {result && (
              <QuizFeedback
                result={result}
                onNext={loadNextQuestion}
                nextLabel="Next Question →"
                loading={loading}
              />
            )}
          </div>
        )}

        {step === "summary" && (
          <div className="animate-rise-in rounded-2xl border border-line bg-paper-raised p-5 text-center shadow-card sm:p-8">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-2xl">
              🎉
            </span>
            <h2 className="mb-2 font-display text-2xl font-semibold text-ink">Session Complete!</h2>
            <p className="mb-2 text-sm text-muted sm:text-base">
              You answered {answeredCount} questions in {session?.subject}.
            </p>
            <p className="mb-7 text-xs text-faint">
              This question set has been saved for offline practice too.
            </p>

            {progress.length === 0 ? (
              <p className="mb-7 rounded-xl border border-dashed border-line-strong bg-paper p-4 text-sm text-muted">
                No attempts were recorded for this session.
              </p>
            ) : (
              <ConceptBars items={progress} />
            )}

            <div className="mt-8">
              <button
                type="button"
                onClick={retryQuiz}
                disabled={retrying}
                aria-busy={retrying}
                className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-accent bg-accent-soft px-6 py-3 font-semibold text-accent-ink transition-colors duration-150 hover:bg-accent/30 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70 sm:inline-flex sm:w-auto"
              >
                {retrying ? (
                  <>
                    <Spinner /> Creating new quiz…
                  </>
                ) : (
                  <>🔁 Retry</>
                )}
              </button>
              <p className="mt-2 text-xs text-faint">
                Same setup, fresh questions. Your results so far are kept.
              </p>
              {retryError && (
                <p
                  role="alert"
                  className="mt-3 rounded-xl border border-error-soft bg-error-soft/70 p-3 text-left text-sm text-error-text"
                >
                  {retryError}
                </p>
              )}
            </div>

            <SummaryActions
              onReport={downloadOnlineReport}
              onCurve={() => go("dashboard")}
              onHome={resetToHome}
            />
          </div>
        )}

        {step === "offlinePractice" && (
          <div className="animate-rise-in rounded-2xl border border-line bg-paper-raised p-5 shadow-card sm:p-8">
            <h2 className="mb-1 font-display text-xl font-semibold text-ink">Practice Offline</h2>
            <p className="mb-6 text-sm text-muted">
              These question sets were saved on this device. No internet needed to use them.
            </p>
            <div className="space-y-3">
              {offlineBanks.map((bank) => (
                <button
                  key={bank.bankId}
                  type="button"
                  onClick={() => startOfflineBank(bank)}
                  className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-line bg-paper p-4 text-left transition-colors duration-150 hover:border-accent hover:bg-accent-soft/20"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium text-ink">
                      {bank.subject} <span className="text-faint">· {bank.examType}</span>
                    </p>
                    <p className="text-xs text-faint">
                      {bank.totalQuestions} questions · saved{" "}
                      {new Date(bank.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="text-accent-ink">→</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => go("home")}
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
                Question <span className="font-semibold text-ink tabular-nums">{offlineIndex + 1}</span>{" "}
                of {offlineTotal}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-paper-raised px-3 py-1 text-xs font-semibold text-ink-soft">
                📴 Offline
              </span>
            </div>

            <div
              role="progressbar"
              aria-label="Quiz progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(offlineProgressPct)}
              className="mb-5 h-2 w-full overflow-hidden rounded-full border border-line bg-paper-raised"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                style={{ width: `${offlineProgressPct}%` }}
              />
            </div>

            <QuestionCard
              key={activeBank.questions[offlineIndex].id}
              question={activeBank.questions[offlineIndex]}
              onSubmitAnswer={submitOfflineAnswer}
              submitting={false}
              result={result}
            />

            {result && (
              <QuizFeedback
                result={result}
                onNext={nextOfflineQuestion}
                nextLabel={offlineIndex + 1 >= offlineTotal ? "See Results →" : "Next Question →"}
              />
            )}
          </div>
        )}

        {step === "offlineSummary" && activeBank && (
          <div className="animate-rise-in rounded-2xl border border-line bg-paper-raised p-5 text-center shadow-card sm:p-8">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-2xl">
              📴
            </span>
            <h2 className="mb-2 font-display text-2xl font-semibold text-ink">
              Offline Session Complete!
            </h2>
            <p className="mb-2 text-sm text-muted sm:text-base">
              You answered {offlineAnswers.length} questions in {activeBank.subject}. No internet used.
            </p>
            <p className="mb-7 text-xs text-faint">
              {pendingSyncCount > 0
                ? `⏳ ${pendingSyncCount} answer${pendingSyncCount === 1 ? "" : "s"} will sync automatically once you're back online.`
                : "✓ Synced."}
            </p>

            <ConceptBars items={offlineProgress} />

            <SummaryActions
              onReport={downloadOfflineReport}
              onCurve={() => go("dashboard")}
              onHome={() => go("home")}
            />
          </div>
        )}
      </div>
    </main>
  );
}

export default App;
