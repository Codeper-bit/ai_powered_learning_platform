import { useState } from "react";

const DIFFICULTY_STYLE = {
  Easy: "bg-success-soft text-success-text",
  Medium: "bg-accent-soft text-accent-ink",
  Hard: "bg-error-soft text-error-text",
};

/**
 * One multiple-choice question (mount it with key={question.id} so each
 * question starts with a clean selection). `onSubmitAnswer` may be async; if it resolves
 * to `false` (the request failed) the selection is released so the student can
 * tap again instead of being stuck. Once `result` arrives the correct option
 * turns green and a wrong pick turns red, so the outcome reads at a glance.
 */
function QuestionCard({ question, onSubmitAnswer, submitting, result }) {
  const [selected, setSelected] = useState(null);

  async function handleSelect(option) {
    if (selected || submitting) return; // no double submission
    setSelected(option);
    const ok = await onSubmitAnswer(question.id, option);
    if (ok === false) setSelected(null);
  }

  const correct = result?.correct_answer?.trim();
  const difficultyStyle =
    DIFFICULTY_STYLE[question.difficulty] || "border border-line bg-paper text-ink-soft";

  return (
    <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-card">
      <div className="h-1.5 w-full bg-accent" />
      <div className="p-5 sm:p-6">
        <div className="mb-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <span className="rounded-full border border-line-strong bg-paper px-3 py-1 text-sm font-medium text-ink-soft">
              {question.concept}
            </span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${difficultyStyle}`}>
              {question.difficulty}
            </span>
          </div>

          <h2 className="font-display text-lg font-medium leading-snug text-ink sm:text-xl">
            {question.question}
          </h2>
        </div>

        <div className="space-y-2.5" role="group" aria-label="Answer options">
          {question.options.map((option, index) => {
            const isSelected = selected === option;
            const isCorrectOption = Boolean(result) && option.trim() === correct;
            const isWrongPick = Boolean(result) && isSelected && !isCorrectOption;

            const tone = isCorrectOption
              ? "border-success bg-success-soft/70 ring-1 ring-success"
              : isWrongPick
                ? "border-error bg-error-soft/70 ring-1 ring-error"
                : isSelected
                  ? "border-accent bg-accent-soft/60 ring-1 ring-accent"
                  : "border-line bg-paper hover:border-accent hover:bg-accent-soft/30 disabled:hover:border-line disabled:hover:bg-paper";
            const badge = isCorrectOption
              ? "border-success bg-success text-paper-raised"
              : isWrongPick
                ? "border-error bg-error text-paper-raised"
                : isSelected
                  ? "border-accent bg-accent text-ink"
                  : "border-line-strong bg-paper-raised text-ink-soft";

            return (
              <button
                key={`${question.id}-${index}`}
                type="button"
                onClick={() => handleSelect(option)}
                disabled={Boolean(selected) || submitting}
                aria-pressed={isSelected}
                className={`flex min-h-14 w-full items-start gap-3 rounded-xl border p-4 text-left text-ink-soft transition-colors duration-150 disabled:cursor-not-allowed ${tone}`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${badge}`}
                >
                  {isCorrectOption ? "✓" : isWrongPick ? "✕" : String.fromCharCode(65 + index)}
                </span>
                <span className="min-w-0 break-words pt-0.5 text-ink">{option}</span>
                {isSelected && submitting && (
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 pt-0.5 text-xs text-accent-ink">
                    <span className="animate-spin-slow h-3 w-3 rounded-full border-2 border-accent-ink/30 border-t-accent-ink" />
                    checking…
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default QuestionCard;
