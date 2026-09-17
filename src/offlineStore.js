const USER_KEY = "aiTutorUser";
const BANKS_KEY_PREFIX = "aiTutorOfflineBanks:";
const MAX_BANKS_PER_USER = 8;

export function loadUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveUser(user) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // localStorage can be unavailable (private browsing, storage full) —
    // the app still works, it just won't remember the login next visit.
  }
}

export function clearUser() {
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

function banksKey(userId) {
  return `${BANKS_KEY_PREFIX}${userId}`;
}

export function loadOfflineBanks(userId) {
  try {
    const raw = localStorage.getItem(banksKey(userId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Save a freshly-generated question batch for later offline replay. Keeps
 * only the most recent MAX_BANKS_PER_USER banks so localStorage doesn't
 * grow unbounded. */
export function saveOfflineBank(userId, bank) {
  try {
    const existing = loadOfflineBanks(userId);
    const updated = [bank, ...existing].slice(0, MAX_BANKS_PER_USER);
    localStorage.setItem(banksKey(userId), JSON.stringify(updated));
    return true;
  } catch {
    return false; // e.g. storage quota exceeded — quiz still works online
  }
}

export function deleteOfflineBank(userId, bankId) {
  const existing = loadOfflineBanks(userId);
  const updated = existing.filter((b) => b.bankId !== bankId);
  try {
    localStorage.setItem(banksKey(userId), JSON.stringify(updated));
  } catch {
    // ignore
  }
  return updated;
}
