import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { apiFetchJson } from "../api";
import StudyTodoList from "./StudyTodoList";
import { buildSampleProgress, isSampleOn, setSampleOn } from "../sampleProgress";

// Read from the theme tokens in index.css (@theme static), so the charts
// follow light/dark mode instead of staying stuck on the light palette.
const COLORS = {
  line: "var(--color-line)",
  lineStrong: "var(--color-line-strong)",
  muted: "var(--color-muted)",
  ink: "var(--color-ink)",
  inkSoft: "var(--color-ink-soft)",
  paperRaised: "var(--color-paper-raised)",
  accent: "var(--color-accent)",
  success: "var(--color-success)",
  error: "var(--color-error)",
};
const CHART_ANIMATION_MS = 350;

const TIERS = {
  strong: { min: 70, color: COLORS.success, text: "text-success-text", label: "Strong" },
  building: { min: 40, color: COLORS.accent, text: "text-accent-ink", label: "Building" },
  weak: { min: 0, color: COLORS.error, text: "text-error-text", label: "Needs work" },
};

// Mirrors backend/concept_profile.py's status_for(): NEW/DEVELOPING/WEAK/
// MASTERED, each requiring a minimum amount of evidence before landing on
// WEAK or MASTERED — never assigned off a single question.
const STATUS_LABELS = {
  NEW: "New · not enough data",
  DEVELOPING: "Developing",
  WEAK: "Needs work",
  MASTERED: "Mastered",
};
const STATUS_STYLES = {
  NEW: "bg-paper text-faint border border-line",
  DEVELOPING: "bg-accent-soft text-accent-ink",
  WEAK: "bg-error-soft text-error-text",
  MASTERED: "bg-success-soft text-success-text",
};

function tierFor(accuracy) {
  if (accuracy >= TIERS.strong.min) return TIERS.strong;
  if (accuracy >= TIERS.building.min) return TIERS.building;
  return TIERS.weak;
}

function formatShortDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CurveTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-xl border border-line-strong bg-paper-raised px-3 py-2 text-xs shadow-card">
      <p className="font-semibold text-ink">
        {formatShortDate(point.date)} · {point.subject}
      </p>
      <p className="mt-1 text-ink-soft">
        Session accuracy: <span className="font-semibold">{point.accuracy}%</span>
      </p>
      <p className="text-faint">Trend: {point.trend}%</p>
    </div>
  );
}

function ConceptTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-xl border border-line-strong bg-paper-raised px-3 py-2 text-xs shadow-card">
      <p className="font-semibold text-ink">{point.concept}</p>
      <p className="mt-1 text-ink-soft">
        {point.correct}/{point.attempts} correct · {point.accuracy}%
      </p>
    </div>
  );
}

function ImpressionRing({ accuracy }) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(100, Math.max(0, accuracy)) / 100);
  const tier = tierFor(accuracy);
  return (
    <div className="relative flex h-36 w-36 shrink-0 items-center justify-center">
      <svg viewBox="0 0 128 128" className="h-36 w-36 -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" stroke={COLORS.line} strokeWidth="10" />
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke={tier.color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0.16,1,0.3,1)" }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="font-display text-3xl font-semibold text-ink">{accuracy}%</span>
        <span className={`text-xs font-semibold ${tier.text}`}>{tier.label}</span>
      </div>
    </div>
  );
}

/** Orange "SAMPLE" tag shown next to every section title while example data is on. */
function SampleTag() {
  return (
    <span className="ml-2 inline-block rounded-md bg-accent px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wider text-[#17322c]">
      Sample
    </span>
  );
}

/** Big, unmissable notice at the top of the dashboard while example data is on. */
function SampleBanner({ onStartQuiz, onClear }) {
  return (
    <div
      role="status"
      className="rounded-2xl border-2 border-dashed border-accent bg-accent-soft p-4 shadow-card sm:p-5"
    >
      <p className="text-sm font-bold uppercase tracking-wide text-accent-ink">
        ⚠ Sample data · not your progress
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
        <span className="font-semibold text-ink">You have no real progress yet.</span> Everything
        below is made-up example data, shown only so you can see what this page looks like after a
        few quizzes. Take a quiz to start building your own.
      </p>
      <div className="mt-3 grid gap-2 sm:flex">
        <button type="button" onClick={onStartQuiz} className="btn-primary">
          Start a real quiz →
        </button>
        <button type="button" onClick={onClear} className="btn-secondary">
          ✕ Clear sample data
        </button>
      </div>
    </div>
  );
}

/** Cross-session dashboard: "impression" snapshot + learning curve +
 * concept mastery + study to-do list. Fetches /users/me/overview once on
 * mount: this browser's own data, selected by its device id. */
function Dashboard({ onBack, onStartQuiz, onStartTargeted }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(null);
  const [startingTargeted, setStartingTargeted] = useState(false);
  const [sample, setSample] = useState(isSampleOn);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    apiFetchJson("/users/me/overview")
      .then((json) => {
        if (cancelled) return;
        setData(json);
        if (json?.total_sessions > 0) {
          setSampleOn(false); // real progress exists: the sample is no longer needed
          setSample(false);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load your progress.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // The learning-recovery recommendation is fetched separately (and
    // failing quietly) since it's optional — the rest of the dashboard is
    // still useful without it, and a brand-new student simply gets null
    // back (no WEAK concept yet) rather than an error.
    apiFetchJson("/users/me/recovery")
      .then((json) => {
        if (!cancelled) setRecovery(json);
      })
      .catch(() => {
        if (!cancelled) setRecovery(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Example data is shown only when switched on AND there is no real progress.
  const hasRealData = Boolean(data && data.total_sessions > 0);
  const showingSample = sample && !hasRealData;
  const sampleView = useMemo(() => (showingSample ? buildSampleProgress() : null), [showingSample]);
  const activeRecovery = showingSample ? sampleView.recovery : recovery;

  function loadSample() {
    setSampleOn(true);
    setSample(true);
    window.scrollTo({ top: 0 });
  }

  function clearSample() {
    setSampleOn(false);
    setSample(false);
    window.scrollTo({ top: 0 });
  }

  function handleStartTargeted() {
    if (!activeRecovery || !onStartTargeted || startingTargeted) return;
    setStartingTargeted(true);
    // On success this screen unmounts; on failure re-enable the button.
    Promise.resolve(onStartTargeted(activeRecovery)).finally(() => setStartingTargeted(false));
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-line bg-paper-raised p-8 text-center shadow-card">
        <span className="animate-spin-slow mx-auto mb-3 block h-6 w-6 rounded-full border-2 border-line-strong border-t-accent" />
        <p className="text-sm text-muted">Loading your progress…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="animate-rise-in rounded-2xl border border-error-soft bg-error-soft/60 p-6 text-center shadow-card">
        <p className="text-sm text-error-text">{error}</p>
        <button type="button" onClick={onBack} className="mt-4 text-sm font-medium text-ink-soft underline">
          ← Back
        </button>
      </div>
    );
  }

  if (!showingSample && !hasRealData) {
    return (
      <div className="animate-rise-in space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold text-ink">Your progress</h2>
          <button onClick={onBack} className="text-sm font-medium text-muted underline hover:text-ink-soft">
            ← Back
          </button>
        </div>
        <div className="rounded-2xl border border-dashed border-line-strong bg-paper-raised p-8 text-center shadow-card">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-2xl">
            📈
          </span>
          <h2 className="mb-2 font-display text-xl font-semibold text-ink">No progress yet</h2>
          <p className="mb-6 text-sm text-muted">
            Complete a quiz and your learning curve will show up here.
          </p>
          <button
            onClick={onStartQuiz}
            className="rounded-xl bg-ink px-6 py-3 font-semibold text-paper-raised transition hover:bg-ink-soft active:scale-[0.99]"
          >
            Start a quiz →
          </button>

          <div className="mt-6 border-t border-dashed border-line-strong pt-5">
            <p className="mb-3 text-sm text-muted">
              Just looking around? Preview this page with{" "}
              <span className="font-semibold text-ink-soft">made-up example data</span>. It is
              clearly labelled as a sample and you can clear it at any time.
            </p>
            <button type="button" onClick={loadSample} className="btn-secondary">
              👀 Load sample data
            </button>
          </div>
        </div>
        <StudyTodoList />
      </div>
    );
  }

  const {
    overall_accuracy,
    total_attempts,
    total_sessions,
    current_streak_days,
    best_concept,
    weakest_concept,
    concept_mastery,
    learning_curve,
  } = showingSample ? sampleView.overview : data;

  // Sample cards get a dashed orange border so they can't be mistaken for real results.
  const cardBorder = showingSample ? "border-2 border-dashed border-accent" : "border border-line";

  const curveData = learning_curve.map((p, i) => ({ ...p, index: i + 1 }));
  const barHeight = Math.max(180, concept_mastery.length * 38 + 20);

  return (
    <div className="animate-rise-in space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-semibold text-ink">
          Your progress{showingSample && <SampleTag />}
        </h2>
        <button onClick={onBack} className="text-sm font-medium text-muted underline hover:text-ink-soft">
          ← Back
        </button>
      </div>

      {showingSample && <SampleBanner onStartQuiz={onStartQuiz} onClear={clearSample} />}

      {/* Impression snapshot */}
      <div className={`rounded-2xl ${cardBorder} bg-paper-raised p-6 shadow-card sm:p-8`}>
        <p className="mb-4 text-sm font-medium text-muted">
          Overall impression{showingSample && <SampleTag />}
        </p>
        <div className="flex flex-col items-center gap-6 sm:flex-row">
          <ImpressionRing accuracy={overall_accuracy} />
          <div className="grid flex-1 grid-cols-2 gap-3">
            <div className="rounded-xl border border-line bg-paper p-3 text-center">
              <p className="font-display text-xl font-semibold text-ink">{total_sessions}</p>
              <p className="text-xs text-faint">Sessions</p>
            </div>
            <div className="rounded-xl border border-line bg-paper p-3 text-center">
              <p className="font-display text-xl font-semibold text-ink">{total_attempts}</p>
              <p className="text-xs text-faint">Questions answered</p>
            </div>
            <div className="rounded-xl border border-line bg-paper p-3 text-center">
              <p className="font-display text-xl font-semibold text-ink">
                {current_streak_days} <span className="text-sm">🔥</span>
              </p>
              <p className="text-xs text-faint">Day streak</p>
            </div>
            <div className="rounded-xl border border-line bg-paper p-3 text-center">
              <p className="font-display text-xl font-semibold text-ink">{concept_mastery.length}</p>
              <p className="text-xs text-faint">Concepts tracked</p>
            </div>
          </div>
        </div>

        {(best_concept || weakest_concept) && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {best_concept && (
              <div className="flex items-center gap-2 rounded-xl border border-success-soft bg-success-soft/50 p-3">
                <span className="text-lg">💪</span>
                <div>
                  <p className="text-xs text-success-text/80">Strongest</p>
                  <p className="text-sm font-semibold text-success-text">
                    {best_concept.concept} · {best_concept.accuracy}%
                  </p>
                </div>
              </div>
            )}
            {weakest_concept && (
              <div className="flex items-center gap-2 rounded-xl border border-error-soft bg-error-soft/50 p-3">
                <span className="text-lg">🎯</span>
                <div>
                  <p className="text-xs text-error-text/80">Focus area</p>
                  <p className="text-sm font-semibold text-error-text">
                    {weakest_concept.concept} · {weakest_concept.accuracy}%
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Learning recovery: "what should I study next, and why" */}
      {activeRecovery && (
        <div className={`rounded-2xl ${showingSample ? "border-2 border-dashed border-accent" : "border border-accent/40"} bg-accent-soft/30 p-6 shadow-card sm:p-8`}>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent-ink">
            Focus next{showingSample && <SampleTag />}
          </p>
          <h3 className="font-display text-xl font-semibold text-ink">{activeRecovery.concept}</h3>

          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">Why we think this</p>
          <p className="text-sm text-ink-soft">{activeRecovery.evidence}.</p>
          {activeRecovery.suspected_misconception && (
            <p className="mt-2 rounded-xl border-l-4 border-accent bg-paper-raised/70 p-3 text-sm text-ink-soft">
              <span className="font-semibold">{activeRecovery.misconception_confidence}:</span>{" "}
              {activeRecovery.suspected_misconception}
            </p>
          )}

          {activeRecovery.accuracy_before != null && activeRecovery.accuracy_after != null && (
            <div className="mt-3 flex items-center gap-4 text-sm">
              <span className="text-muted">
                Before: <span className="font-semibold text-ink">{activeRecovery.accuracy_before}%</span>
              </span>
              <span className="text-faint">→</span>
              <span className="text-muted">
                After: <span className="font-semibold text-ink">{activeRecovery.accuracy_after}%</span>
              </span>
            </div>
          )}

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Recommended</p>
          <p className="mb-4 text-sm text-ink-soft">
            {activeRecovery.recommended_question_count} targeted practice questions on this concept.
          </p>

          <button
            onClick={handleStartTargeted}
            disabled={startingTargeted}
            className="rounded-xl bg-ink px-5 py-2.5 text-sm font-semibold text-paper-raised transition hover:bg-ink-soft active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {startingTargeted ? "Starting…" : "Start targeted practice →"}
          </button>
          {showingSample && (
            <p className="mt-2 text-xs text-muted">
              This recommendation is sample data. The practice quiz it starts is real.
            </p>
          )}
        </div>
      )}

      {/* Learning curve */}
      <div className={`rounded-2xl ${cardBorder} bg-paper-raised p-6 shadow-card sm:p-8`}>
        <p className="mb-1 font-display text-lg font-semibold text-ink">
          Learning curve{showingSample && <SampleTag />}
        </p>
        <p className="mb-4 text-sm text-muted">Accuracy per session, with the overall trend.</p>

        {curveData.length < 2 ? (
          <p className="rounded-xl border border-dashed border-line-strong bg-paper p-4 text-sm text-muted">
            Complete one more session to start seeing a trend.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={curveData} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={COLORS.line} vertical={false} />
              <XAxis
                dataKey="index"
                tickFormatter={(i) => `S${i}`}
                tick={{ fill: COLORS.muted, fontSize: 12 }}
                axisLine={{ stroke: COLORS.lineStrong }}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: COLORS.muted, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={36}
              />
              <ReferenceLine y={70} stroke={COLORS.success} strokeDasharray="4 4" strokeOpacity={0.5} />
              <Tooltip content={<CurveTooltip />} />
              <Line
                type="monotone"
                animationDuration={CHART_ANIMATION_MS}
                dataKey="accuracy"
                stroke={COLORS.lineStrong}
                strokeWidth={1.5}
                dot={{ r: 3, fill: COLORS.paperRaised, stroke: COLORS.inkSoft, strokeWidth: 1.5 }}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                animationDuration={CHART_ANIMATION_MS}
                dataKey="trend"
                stroke={COLORS.accent}
                strokeWidth={2.5}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-faint">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full border border-ink-soft bg-paper-raised" /> Session accuracy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded-full bg-accent" /> Trend
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded-full border-t border-dashed border-success" /> Mastery line (70%)
          </span>
        </div>
      </div>

      {/* Concept mastery */}
      <div className={`rounded-2xl ${cardBorder} bg-paper-raised p-6 shadow-card sm:p-8`}>
        <p className="mb-1 font-display text-lg font-semibold text-ink">
          Concept mastery{showingSample && <SampleTag />}
        </p>
        <p className="mb-4 text-sm text-muted">Accuracy by concept, across every session.</p>

        <ResponsiveContainer width="100%" height={barHeight}>
          <BarChart data={concept_mastery} layout="vertical" margin={{ top: 0, right: 24, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={COLORS.line} horizontal={false} />
            <XAxis
              type="number"
              domain={[0, 100]}
              tick={{ fill: COLORS.muted, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="concept"
              width={110}
              tick={{ fill: COLORS.inkSoft, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<ConceptTooltip />} cursor={{ fill: COLORS.line, opacity: 0.4 }} />
            <Bar dataKey="accuracy" radius={[0, 6, 6, 0]} maxBarSize={18} animationDuration={CHART_ANIMATION_MS}>
              {concept_mastery.map((entry, i) => (
                <Cell key={i} fill={tierFor(entry.accuracy).color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        <div className="mt-5 space-y-2 border-t border-line pt-4">
          {concept_mastery.map((c) => (
            <div key={c.concept} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-ink-soft">{c.concept}</p>
                {c.suspected_misconception && (
                  <p className="mt-0.5 text-xs text-faint">
                    {c.misconception_confidence}: {c.suspected_misconception}
                  </p>
                )}
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[c.status] || STATUS_STYLES.NEW
                  }`}
              >
                {STATUS_LABELS[c.status] || c.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      <StudyTodoList />
    </div>
  );
}

export default Dashboard;
