import { useCallback, useEffect, useRef, useState } from "react";
import QuestionCard from "./components/QuestionCard";
import OnboardingForm from "./components/OnboardingForm";

const API_BASE="https://ai-powered-learning-platform-qenu.onrender.com";

// A bare "Failed to fetch" from the browser's fetch() is almost always
// either (a) the backend is unreachable at API_BASE, or (b) the backend
// responded but CORS_ORIGINS on the backend doesn't include this site's
// origin, so the browser threw the response away. Surface that instead of
// a generic message so it's actionable without opening devtools.
function describeFetchError(err) {
  if (err instanceof TypeError) {
    return (
      `Could not reach the server at ${API_BASE}. This is usually a CORS ` +
      `or wrong-backend-URL problem — check that VITE_API_BASE (frontend) ` +
      `points at this backend, and that CORS_ORIGINS (backend) includes ` +
      `this site's URL.`
    );
  }
  return err.message || "Could not start the quiz. Check the backend is running.";
}

function App() {
  const [step, setStep] = useState("setup"); // setup | quiz | summary

  const [session, setSession] = useState(null); // { session_id, user_id, total_questions, time_limit, source }
  const [question, setQuestion] = useState(null);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState([]);
  const [timeLeft, setTimeLeft] = useState(0);

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Keep the latest session in a ref so the single long-lived timer
  // interval below never has to be torn down and rebuilt every second.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const finishSession = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const response = await fetch(
        `${API_BASE}/sessions/${current.session_id}/progress?user_id=${current.user_id}`
      );
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

  async function startSession(payload) {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    } catch (err) {
      console.error(err);
      setError(describeFetchError(err));
    } finally {
      setLoading(false);
    }
  }

  async function submitAnswer(questionId, answer) {
    if (!session || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch(`${API_BASE}/attempts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: session.user_id,
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
      const response = await fetch(
        `${API_BASE}/sessions/${session.session_id}/next-question?user_id=${session.user_id}`
      );
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

  function resetToSetup() {
    setStep("setup");
    setSession(null);
    setQuestion(null);
    setResult(null);
    setProgress([]);
    setAnsweredCount(0);
    setError("");
  }

  const totalQuestions = session?.total_questions ?? 0;
  const quizProgressPct = totalQuestions
    ? Math.min(100, (answeredCount / totalQuestions) * 100)
    : 0;

  return (
    <main className="paper-field min-h-screen px-4 py-10 font-body text-ink sm:py-14">
      <div className="mx-auto max-w-2xl">
        <div className="animate-rise-in mb-8 text-center sm:mb-10">
          <div className="mb-3 flex items-center justify-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-paper-raised font-display text-sm font-semibold text-accent-ink">
              A+
            </span>
          </div>
          <h1 className="font-display text-[1.75rem] font-semibold tracking-tight text-ink sm:text-3xl">
            AI Learning Platform
          </h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted sm:text-base">
            Learn from your mistakes, not just your answers.
          </p>
        </div>

        {error && step !== "setup" && (
          <div className="animate-rise-in mb-6 flex items-start gap-3 rounded-xl border border-error-soft bg-error-soft/70 p-4 text-sm text-error-text">
            <span className="mt-0.5 text-error">✕</span>
            <span>{error}</span>
          </div>
        )}

        {step === "setup" && (
          <div className="animate-rise-in">
            <OnboardingForm apiBase={API_BASE} onGenerate={startSession} loading={loading} error={error} />
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
              </span>
              <span
                className={`tabular-nums inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
                  timeLeft < 60
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
                      className={`text-sm font-semibold ${
                        item.accuracy >= 70
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
                      className={`h-full rounded-full transition-all duration-700 ease-out ${
                        item.accuracy >= 70
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
              onClick={resetToSetup}
              className="mt-8 rounded-xl bg-ink px-6 py-3 font-semibold text-paper-raised transition hover:bg-ink-soft active:scale-[0.99]"
            >
              Start New Session
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default App;
