const BANKS_KEY_PREFIX = "aiTutorOfflineBanks:";
const MAX_BANKS_PER_USER = 8;

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
// this queue. Each queued answer carries its own `attemptKey`, minted when
// the student answers: re-sending an already-synced item re-sends the same
// key, which the server recognises as a duplicate (a harmless no-op), while
// answering the same question again later — e.g. replaying a saved bank —
// mints a new key and is stored as a separate, additional attempt.

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

/** A fresh idempotency key for ONE answer. Call once per answer the student
 * gives, never per network attempt. */
export function newAttemptKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // randomUUID needs a secure context (https/localhost); fall back otherwise.
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand()}-${rand()}-${rand()}`;
}

/** Queue one offline answer for later sync. `clientId` de-dupes entries
 * within the local queue itself: the same answer queued twice is one item,
 * but the same QUESTION answered again (a bank replay) has a different
 * attemptKey and is queued as its own item — it must not be dropped. The
 * server's attempt_key check is the backstop once it reaches the backend.
 * Items queued by older versions have no attemptKey and keep the old
 * per-question id. */
export function enqueueSyncItem(userId, item) {
  const existing = loadSyncQueue(userId);
  const clientId = item.attemptKey || `${item.questionId}`;
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
