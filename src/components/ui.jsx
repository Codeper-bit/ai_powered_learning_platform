import { useEffect, useRef } from "react";

export function Spinner({ className = "" }) {
  return (
    <span
      aria-hidden="true"
      className={`animate-spin-slow inline-block h-4 w-4 shrink-0 rounded-full border-2 border-current border-t-transparent opacity-70 ${className}`}
    />
  );
}

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function QuizFeedback({ result, onNext, nextLabel, loading = false }) {
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    panelRef.current?.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    buttonRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={panelRef}
      role="status"
      aria-live="polite"
      className="animate-stamp-in mt-5 rounded-2xl border border-line bg-paper-raised p-5 shadow-card sm:p-6"
    >
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
          {result.misconception_analysis?.targeted_explanation && (
            <p className="mt-3 rounded-xl border-l-4 border-accent bg-accent-soft/50 p-3 text-sm leading-relaxed text-ink-soft">
              {result.misconception_analysis.targeted_explanation}
            </p>
          )}
        </div>
      )}

      <button
        ref={buttonRef}
        type="button"
        onClick={onNext}
        disabled={loading}
        className="btn-primary mt-5 w-full"
      >
        {loading ? (
          <>
            <Spinner /> Loading…
          </>
        ) : (
          nextLabel
        )}
      </button>
    </div>
  );
}

const barTone = (accuracy) =>
  accuracy >= 70
    ? { text: "text-success-text", bar: "bg-success" }
    : accuracy >= 40
      ? { text: "text-accent-ink", bar: "bg-accent" }
      : { text: "text-error-text", bar: "bg-error" };

/** Per-concept accuracy bars shared by the online and offline summaries. */
export function ConceptBars({ items }) {
  return (
    <div className="space-y-4 text-left">
      {items.map((item) => {
        const tone = barTone(item.accuracy);
        return (
          <div key={item.concept}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="min-w-0 break-words font-medium text-ink-soft">{item.concept}</span>
              <span className={`shrink-0 text-sm font-semibold tabular-nums ${tone.text}`}>
                {item.accuracy}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={`${item.concept} accuracy`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={item.accuracy}
              className="h-2.5 overflow-hidden rounded-full border border-line bg-paper"
            >
              <div
                className={`h-full rounded-full transition-[width] duration-500 ease-out ${tone.bar}`}
                style={{ width: `${item.accuracy}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
