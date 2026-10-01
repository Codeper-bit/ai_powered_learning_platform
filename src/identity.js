// There is no login. Each browser gets a random id, created once and kept in
// localStorage, and sends it with every request (see api.js). The backend
// uses it to keep one person's quizzes, documents and tasks apart from
// everyone else's. It separates data; it is not a password.

const KEY = "aptly.deviceId";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cached = null;

function newUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // randomUUID needs a secure context (https/localhost); build a v4 otherwise.
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The previous (login) version kept its session under "sb-<ref>-auth-token".
 * If one is still here, reuse that account's id so a returning user keeps
 * their history, then delete the stale tokens so no old credential lingers in
 * the browser. */
function adoptLegacyAccountId() {
  try {
    let found = null;
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.+-auth-token(-code-verifier)?$/.test(key)) continue;
      stale.push(key);
      if (!found && key.endsWith("-auth-token")) {
        try {
          const id = JSON.parse(localStorage.getItem(key))?.user?.id;
          if (typeof id === "string" && UUID_RE.test(id)) found = id.toLowerCase();
        } catch {
          // unreadable token: just discard it
        }
      }
    }
    stale.forEach((key) => localStorage.removeItem(key));
    return found;
  } catch {
    return null;
  }
}

export function getDeviceId() {
  if (cached) return cached;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && UUID_RE.test(saved)) return (cached = saved.toLowerCase());
  } catch {
    // storage blocked: fall through and keep an in-memory id for this page load
  }
  cached = adoptLegacyAccountId() || newUuid();
  try {
    localStorage.setItem(KEY, cached);
  } catch {
    // not persisted (private mode); the id still works for this session
  }
  return cached;
}
