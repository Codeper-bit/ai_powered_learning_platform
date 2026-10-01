import { getDeviceId } from "./identity";

const API_BASE = (import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000").replace(/\/+$/, "");

// Quiz generation can legitimately take a while; plain reads should not.
const WRITE_TIMEOUT_MS = 100_000;
const READ_TIMEOUT_MS = 30_000;

/** Turn a thrown error into something a student can act on. Developer detail
 * (wrong URL, CORS) goes to the console instead of the screen. */
export function describeFetchError(err) {
  if (err?.timeout) return err.message;
  if (err instanceof TypeError) {
    console.error(
      `Could not reach ${API_BASE}. If the backend is running, check that VITE_API_BASE ` +
        `points at it and that CORS_ORIGINS on the backend includes this site's URL.`,
      err
    );
    return navigator.onLine === false
      ? "You're offline. Reconnect to do this, or use Practice Offline."
      : "Can't reach the server right now. Check your connection and try again.";
  }
  return err?.message || "Something went wrong. Please try again.";
}

export async function apiFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const { timeoutMs = method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS, ...init } = options;

  const headers = { "X-Device-Id": getDeviceId(), ...(init.headers || {}) };
  if (init.body && !headers["Content-Type"] && !(init.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, headers, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeout = new Error("The server took too long to respond. Please try again.");
      timeout.timeout = true;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function apiFetchJson(path, options = {}) {
  const response = await apiFetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.detail === "string" ? body.detail : `Request failed (${response.status})`
    );
  }
  return response.json();
}
