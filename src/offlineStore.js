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

// ---- Offline sync queue -----------------------------------------------
// Answers submitted while offline are recorded locally here, then replayed
// against POST /attempts (the same endpoint used for live answers) as soon
// as the client is back online. The backend re-grades and re-validates
// every one of them itself — nothing about the score is ever trusted from
// this queue — and the existing UNIQUE(user_id, question_id) constraint on
// `attempts` makes re-sending an already-synced item a harmless no-op
// instead of a duplicate.

const SYNC_QUEUE_KEY_PREFIX = "aiTutorSyncQueue:";

function syncQueueKey(userId) {
  return `${SYNC_QUEUE_KEY_PREFIX}${userId}`;
}

export function loadSyncQueue(userId) {
  try {
    const raw = localStorage.getItem(syncQueueKey(userId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSyncQueue(userId, queue) {
  try {
    localStorage.setItem(syncQueueKey(userId), JSON.stringify(queue));
    return true;
  } catch {
    return false; // storage unavailable/full — item stays only in memory
  }
}

/** Queue one offline answer for later sync. `clientId` de-dupes entries
 * within the local queue itself (in case the same question is queued
 * twice before a sync ever runs); the server-side UNIQUE constraint is the
 * backstop against duplicates once it reaches the backend. */
export function enqueueSyncItem(userId, item) {
  const existing = loadSyncQueue(userId);
  const clientId = `${item.questionId}`;
  if (existing.some((q) => q.clientId === clientId)) return existing;
  const updated = [...existing, { ...item, clientId, queuedAt: new Date().toISOString() }];
  saveSyncQueue(userId, updated);
  return updated;
}

export function removeSyncItems(userId, clientIds) {
  const existing = loadSyncQueue(userId);
  const toRemove = new Set(clientIds);
  const updated = existing.filter((q) => !toRemove.has(q.clientId));
  saveSyncQueue(userId, updated);
  return updated;
}

export function countPendingSync(userId) {
  return loadSyncQueue(userId).length;
}
