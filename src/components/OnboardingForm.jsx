import { useState } from "react";
import DocumentUpload from "./DocumentUpload";

const DIFFICULTY_LEVELS = ["Easy", "Medium", "Hard"];
const EXAM_TYPES = ["General", "WAEC", "NECO", "JAMB"];
const MAX_QUESTIONS = 50;

function OnboardingForm({ apiBase, onGenerate, loading, error }) {
  const [mode, setMode] = useState("topic"); // "topic" | "document"
  const [uploadedDocument, setUploadedDocument] = useState(null);

  const [form, setForm] = useState({
    name: "",
    subject: "",
    examType: "General",
    customInstructions: "",
    totalQuestions: 10,
    difficultyMin: "Easy",
    difficultyMax: "Hard",
    timeLimitMinutes: 30,
  });

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    if (nextMode === "topic") {
      setUploadedDocument(null);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();

    if (mode === "document" && !uploadedDocument) {
      return; // upload zone already shows its own guidance; nothing to submit yet
    }

    onGenerate({
      name: form.name.trim() || "Student",
      subject: mode === "document" ? (form.subject.trim() || "") : (form.subject.trim() || "Mathematics"),
      exam_type: form.examType,
      // The free-text box is where "WAEC style", "NECO past questions",
      // "standard JAMB questions" etc. actually get typed in.
      custom_request: form.customInstructions.trim() || null,
      total_questions: Math.min(
        MAX_QUESTIONS,
        Math.max(1, Number(form.totalQuestions) || 10)
      ),
      min_difficulty: form.difficultyMin,
      max_difficulty: form.difficultyMax,
      time_limit: Math.max(1, Number(form.timeLimitMinutes) || 30),
      document_id: mode === "document" ? uploadedDocument?.document_id ?? null : null,
    });
  }

  const canSubmit =
    !loading && (mode === "topic" ? true : Boolean(uploadedDocument));

  const inputClass =
    "w-full rounded-xl border border-line bg-paper p-3 text-ink placeholder:text-faint transition focus:border-accent focus:bg-paper-raised focus:outline-none focus:ring-2 focus:ring-accent-soft";
  const labelClass = "mb-1.5 block text-sm font-medium text-ink-soft";
  const selectWrapClass = "relative";
  const selectClass = `field-select ${inputClass} pr-9`;
  const chevron = (
    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-faint">▾</span>
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-card"
    >
      <div className="h-1.5 w-full bg-accent" />
      <div className="p-5 sm:p-6">
        <h2 className="mb-1 font-display text-xl font-semibold text-ink">Set up your quiz</h2>
        <p className="mb-6 text-sm text-muted">
          Tell us what you want, and we&apos;ll generate the whole set of
          questions in one go before you start.
        </p>

        {/* Mode toggle */}
        <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl border border-line bg-paper p-1">
          <button
            type="button"
            onClick={() => switchMode("topic")}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-semibold transition ${
              mode === "topic"
                ? "bg-paper-raised text-ink shadow-sm ring-1 ring-line-strong"
                : "text-muted hover:text-ink-soft"
            }`}
          >
            <span aria-hidden="true">✏️</span> By topic
          </button>
          <button
            type="button"
            onClick={() => switchMode("document")}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-semibold transition ${
              mode === "document"
                ? "bg-paper-raised text-ink shadow-sm ring-1 ring-line-strong"
                : "text-muted hover:text-ink-soft"
            }`}
          >
            <span aria-hidden="true">📄</span> From a document
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <label className={labelClass}>Your name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="e.g. Ada"
              className={inputClass}
            />
          </div>

          {mode === "document" && (
            <div>
              <label className={labelClass}>Study material</label>
              <DocumentUpload
                apiBase={apiBase}
                document={uploadedDocument}
                onDocumentReady={setUploadedDocument}
                onClear={() => setUploadedDocument(null)}
                disabled={loading}
              />
              <p className="mt-1.5 text-xs text-faint">
                We only keep the extracted text — the file itself isn&apos;t stored.
              </p>
            </div>
          )}

          <div>
            <label className={labelClass}>
              Subject{" "}
              {mode === "document" && (
                <span className="font-normal text-faint">(optional — we can infer it)</span>
              )}
            </label>
            <input
              type="text"
              value={form.subject}
              onChange={(e) => update("subject", e.target.value)}
              placeholder="e.g. Mathematics, Physics, English"
              required={mode === "topic"}
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass}>Exam type</label>
            <div className={selectWrapClass}>
              <select
                value={form.examType}
                onChange={(e) => update("examType", e.target.value)}
                className={selectClass}
              >
                {EXAM_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              {chevron}
            </div>
          </div>

          <div>
            <label className={labelClass}>Want a specific style? (optional)</label>
            <textarea
              value={form.customInstructions}
              onChange={(e) => update("customInstructions", e.target.value)}
              placeholder={`e.g. "WAEC 2023 past-question style" or "standard JAMB questions, no calculator"`}
              rows={2}
              className={`${inputClass} resize-none`}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Questions (max {MAX_QUESTIONS})</label>
              <input
                type="number"
                min={1}
                max={MAX_QUESTIONS}
                value={form.totalQuestions}
                onChange={(e) => update("totalQuestions", e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className={labelClass}>Time limit (min)</label>
              <div className="relative">
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={form.timeLimitMinutes}
                  onChange={(e) => update("timeLimitMinutes", e.target.value)}
                  className={`${inputClass} pr-11`}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs text-faint">
                  min
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Difficulty from</label>
              <div className={selectWrapClass}>
                <select
                  value={form.difficultyMin}
                  onChange={(e) => update("difficultyMin", e.target.value)}
                  className={selectClass}
                >
                  {DIFFICULTY_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
                {chevron}
              </div>
            </div>

            <div>
              <label className={labelClass}>up to</label>
              <div className={selectWrapClass}>
                <select
                  value={form.difficultyMax}
                  onChange={(e) => update("difficultyMax", e.target.value)}
                  className={selectClass}
                >
                  {DIFFICULTY_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
                {chevron}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <p className="mt-5 flex items-start gap-2 text-sm text-error-text">
            <span className="mt-0.5">✕</span>
            <span>{error}</span>
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-7 flex w-full items-center justify-center gap-2 rounded-xl bg-ink p-3 font-semibold text-paper-raised transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:bg-faint active:scale-[0.99]"
        >
          {loading && (
            <span className="animate-spin-slow h-4 w-4 rounded-full border-2 border-paper-raised/40 border-t-paper-raised" />
          )}
          {loading
            ? "Generating your questions…"
            : mode === "document" && !uploadedDocument
            ? "Upload a document to continue"
            : "Get Questions"}
        </button>
      </div>
    </form>
  );
}

export default OnboardingForm;
