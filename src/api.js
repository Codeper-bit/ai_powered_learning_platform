import { loadUser, clearUser } from "./offlineStore";

export const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

// A bare "Failed to fetch" from the browser's fetch() is almost always
// either (a) the backend is unreachable at API_BASE, or (b) the backend
// responded but CORS_ORIGINS on the backend doesn't include this site's
// origin, so the browser threw the response away. Surface that instead of
// a generic message so it's actionable without opening devtools.
export function describeFetchError(err) {
  if (err instanceof TypeError) {
    return (
      `Could not reach the server at ${API_BASE}. This is usually a CORS ` +
      `or wrong-backend-URL problem — check that VITE_API_BASE (frontend) ` +
      `points at this backend, and that CORS_ORIGINS (backend) includes ` +
      `this site's URL.`
    );
  }
  return err.message || "Something went wrong. Please try again.";
}

/** Fetch wrapper that attaches the logged-in user's bearer token to every
 * call. Centralizing this means no request can accidentally be sent
 * without auth, and a 401 (expired/invalid session) is handled in one
 * place instead of at every call site. */
export async function apiFetch(path, options = {}) {
  const user = loadUser();
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (user?.access_token) {
    headers["Authorization"] = `Bearer ${user.access_token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (response.status === 401) {
    // Session expired or token invalid — the stored login is no longer
    // usable, so clear it rather than let the app keep silently failing.
    clearUser();
    const body = await response.json().catch(() => ({}));
    const err = new Error(body.detail || "Your session expired. Please log in again.");
    err.sessionExpired = true;
    throw err;
  }

  return response;
}

/** Same as apiFetch, but parses JSON and throws with the server's error
 * detail on a non-OK response — the common case at most call sites. */
export async function apiFetchJson(path, options = {}) {
  const response = await apiFetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${response.status})`);
  }
  return response.json();
}
