import { useEffect, useState } from "react";
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

// Mirrors the palette in index.css (@theme). Recharts renders plain SVG, so
// colors are hardcoded here rather than referenced as CSS variables — keeps
// the chart rendering independent of how/where the SVG ends up in the DOM.
const COLORS = {
  line: "#dbe3d5",
  lineStrong: "#c3cec0",
  muted: "#6b7b72",
  ink: "#17322c",
  inkSoft: "#3f5750",
  paperRaised: "#fbfcfa",
  accent: "#e1a73f",
  success: "#2f8f5b",
  error: "#c1473a",
};

const TIERS = {
  strong: { min: 70, color: COLORS.success, text: "text-success-text", label: "Strong" },
  building: { min: 40, color: COLORS.accent, text: "text-accent-ink", label: "Building" },
  weak: { min: 0, color: COLORS.error, text: "text-error-text", label: "Needs work" },
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

/** Cross-session dashboard: "impression" snapshot + learning curve +
 * concept mastery + study to-do list. Fetches /users/me/overview once on
 * mount — the authenticated caller's own data, via the bearer token. */
function Dashboard({ onBack, onStartQuiz }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    apiFetchJson("/users/me/overview")
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load your progress.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="animate-rise-in rounded-2xl border border-line bg-paper-raised p-8 text-center shadow-card">
        <span className="animate-spin-slow mx-auto mb-3 block h-6 w-6 rounded-full border-2 border-line-strong border-t-accent" />
        <p className="text-sm text-muted">Loading your progress…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="animate-rise-in rounded-2xl border border-error-soft bg-error-soft/60 p-6 text-center shadow-card">
        <p className="text-sm text-error-text">{error}</p>
        <button onClick={onBack} className="mt-4 text-sm font-medium text-ink-soft underline">
          ← Back
        </button>
      </div>
    );
  }

  if (!data || data.total_sessions === 0) {
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
  } = data;

  const curveData = learning_curve.map((p, i) => ({ ...p, index: i + 1 }));
  const barHeight = Math.max(180, concept_mastery.length * 38 + 20);

  return (
    <div className="animate-rise-in space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-semibold text-ink">Your progress</h2>
        <button onClick={onBack} className="text-sm font-medium text-muted underline hover:text-ink-soft">
          ← Back
        </button>
      </div>

      {/* Impression snapshot */}
      <div className="rounded-2xl border border-line bg-paper-raised p-6 shadow-card sm:p-8">
        <p className="mb-4 text-sm font-medium text-muted">Overall impression</p>
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

      {/* Learning curve */}
      <div className="rounded-2xl border border-line bg-paper-raised p-6 shadow-card sm:p-8">
        <p className="mb-1 font-display text-lg font-semibold text-ink">Learning curve</p>
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
                dataKey="accuracy"
                stroke={COLORS.lineStrong}
                strokeWidth={1.5}
                dot={{ r: 3, fill: COLORS.paperRaised, stroke: COLORS.inkSoft, strokeWidth: 1.5 }}
                activeDot={{ r: 4 }}
              />
              <Line type="monotone" dataKey="trend" stroke={COLORS.accent} strokeWidth={2.5} dot={false} />
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
      <div className="rounded-2xl border border-line bg-paper-raised p-6 shadow-card sm:p-8">
        <p className="mb-1 font-display text-lg font-semibold text-ink">Concept mastery</p>
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
            <Bar dataKey="accuracy" radius={[0, 6, 6, 0]} maxBarSize={18}>
              {concept_mastery.map((entry, i) => (
                <Cell key={i} fill={tierFor(entry.accuracy).color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <StudyTodoList />
    </div>
  );
}

export default Dashboard;
