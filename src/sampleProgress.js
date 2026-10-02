// Example data for the dashboard's "Load sample data" button.
//
// It exists only so someone with no history can see what the dashboard looks
// like. Nothing here is sent to, or stored on, the server: the numbers live in
// this file and a single on/off flag lives in localStorage. Clearing the sample
// therefore can never touch real quizzes, attempts or tasks, and real data
// always wins (see Dashboard.jsx).

const FLAG_KEY = "aptly.sampleProgress";
let memoryFlag = false; // fallback when localStorage is blocked (private mode)

export function isSampleOn() {
  try {
    const saved = localStorage.getItem(FLAG_KEY);
    if (saved !== null) return saved === "1";
  } catch {
    // storage unavailable: use the in-memory flag
  }
  return memoryFlag;
}

export function setSampleOn(on) {
  memoryFlag = Boolean(on);
  try {
    if (on) localStorage.setItem(FLAG_KEY, "1");
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    // not persisted; still works until the page is reloaded
  }
}

// ---- The example numbers ----------------------------------------------------
// Chosen so everything adds up: the concept totals equal the session totals
// (50 answers, 31 correct), and statuses follow the same rules as the backend
// (backend/concept_profile.py): 3+ attempts needed, <=50% is WEAK, >=80% is
// MASTERED, anything between is DEVELOPING.

const SESSIONS = [
  { daysAgo: 9, subject: "Mathematics", attempts: 8, correct: 3 },
  { daysAgo: 7, subject: "Mathematics", attempts: 10, correct: 5 },
  { daysAgo: 4, subject: "Physics", attempts: 8, correct: 5 },
  { daysAgo: 3, subject: "Mathematics", attempts: 9, correct: 6 },
  { daysAgo: 2, subject: "Physics", attempts: 7, correct: 5 },
  { daysAgo: 1, subject: "Mathematics", attempts: 8, correct: 7 },
];

const CONCEPTS = [
  {
    concept: "Quadratic Equations",
    attempts: 12,
    correct: 4,
    misconception: "Tries to factor before moving every term to one side of the equation.",
    confidence: "Likely weakness",
  },
  {
    concept: "Linear Equations",
    attempts: 10,
    correct: 8,
    misconception: "Forgets to change the sign when moving a term across the equals sign.",
    confidence: "Needs more evidence",
  },
  {
    concept: "Kinematics",
    attempts: 9,
    correct: 6,
    misconception: "Treats speed and velocity as the same quantity.",
    confidence: "Possible misconception",
  },
  {
    concept: "Newton's Laws",
    attempts: 8,
    correct: 7,
    misconception: "Thinks a moving object needs a constant force to keep moving.",
    confidence: "Needs more evidence",
  },
  {
    concept: "Trigonometric Ratios",
    attempts: 7,
    correct: 3,
    misconception: "Mixes up which side is opposite and which is adjacent.",
    confidence: "Possible misconception",
  },
  {
    concept: "Probability",
    attempts: 4,
    correct: 3,
    misconception: "Adds the probabilities of independent events instead of multiplying them.",
    confidence: "Needs more evidence",
  },
];

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function statusFor(attempts, accuracy) {
  if (attempts < 3) return "NEW";
  if (accuracy >= 80) return "MASTERED";
  if (accuracy <= 50) return "WEAK";
  return "DEVELOPING";
}

// Local calendar date (YYYY-MM-DD), `n` days before today.
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The same shapes the real API returns, so the dashboard renders it with no
 * special cases: { overview: GET /users/me/overview, recovery: GET /users/me/recovery }.
 * Dates are relative to today so the sample never looks stale. */
export function buildSampleProgress() {
  const conceptMastery = CONCEPTS.map((c) => {
    const accuracy = round1((c.correct / c.attempts) * 100);
    return {
      concept: c.concept,
      attempts: c.attempts,
      correct: c.correct,
      accuracy,
      status: statusFor(c.attempts, accuracy),
      suspected_misconception: c.misconception,
      misconception_confidence: c.confidence,
    };
  }).sort((a, b) => a.accuracy - b.accuracy); // worst first, like the backend

  const accuracies = SESSIONS.map((s) => round1((s.correct / s.attempts) * 100));
  const learningCurve = SESSIONS.map((s, i) => {
    const window = accuracies.slice(Math.max(0, i - 2), i + 1); // trailing 3-session average
    return {
      session_id: i + 1,
      date: isoDaysAgo(s.daysAgo),
      subject: s.subject,
      attempts: s.attempts,
      accuracy: accuracies[i],
      trend: round2(window.reduce((sum, v) => sum + v, 0) / window.length),
    };
  });

  const totalAttempts = conceptMastery.reduce((sum, c) => sum + c.attempts, 0);
  const totalCorrect = conceptMastery.reduce((sum, c) => sum + c.correct, 0);
  const best = conceptMastery.reduce((a, b) => (b.accuracy > a.accuracy ? b : a));
  const weakest = conceptMastery[0];

  // Focus-next card: built from the weakest concept's own numbers
  // (4 of 12 correct: 1 of the first 6, 3 of the last 6).
  const recovery = {
    concept: weakest.concept,
    status: weakest.status,
    evidence: "3 of your last 6 attempts on this concept were incorrect",
    recent_incorrect: 3,
    recent_total: 6,
    suspected_misconception: weakest.suspected_misconception,
    misconception_confidence: weakest.misconception_confidence,
    recommended_question_count: 5,
    accuracy_before: 16.7,
    accuracy_after: 50.0,
  };

  return {
    overview: {
      overall_accuracy: round1((totalCorrect / totalAttempts) * 100),
      total_attempts: totalAttempts,
      total_sessions: SESSIONS.length,
      current_streak_days: 4, // sessions fall on each of the last 4 days
      best_concept: best,
      weakest_concept: weakest,
      concept_mastery: conceptMastery,
      learning_curve: learningCurve,
    },
    recovery,
  };
}
