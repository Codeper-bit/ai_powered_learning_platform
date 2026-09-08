import { useEffect, useState } from "react";

function QuestionCard({ question, onSubmitAnswer, submitting }) {
  const [selected, setSelected] = useState(null);

  // Reset local selection whenever a new question comes in
  useEffect(() => {
    setSelected(null);
  }, [question.id]);

  function handleSelect(option) {
    if (selected || submitting) return; // guards against double submission
    setSelected(option);
    onSubmitAnswer(question.id, option);
  }

  const difficultyStyle =
    {
      Easy: "bg-success-soft text-success-text",
      Medium: "bg-accent-soft text-accent-ink",
      Hard: "bg-error-soft text-error-text",
    }[question.difficulty] || "bg-paper text-ink-soft border border-line";

  return (
    <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-card transition sm:p-0">
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

        <div className="space-y-2.5">
          {question.options.map((option, index) => {
            const isSelected = selected === option;
            return (
              <button
                key={`${question.id}-${index}`}
                type="button"
                onClick={() => handleSelect(option)}
                disabled={Boolean(selected) || submitting}
                className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left text-ink-soft transition disabled:cursor-not-allowed ${
                  isSelected
                    ? "border-accent bg-accent-soft/60 ring-1 ring-accent"
                    : "border-line bg-paper hover:border-accent hover:bg-accent-soft/30 disabled:hover:border-line disabled:hover:bg-paper"
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                    isSelected
                      ? "border-accent bg-accent text-ink"
                      : "border-line-strong bg-paper-raised text-ink-soft"
                  }`}
                >
                  {String.fromCharCode(65 + index)}
                </span>
                <span className="pt-0.5 text-ink">{option}</span>
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
