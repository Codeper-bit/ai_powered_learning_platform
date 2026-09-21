import { supabase } from "./supabaseClient";

export const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

export function describeFetchError(err) {
  if (err instanceof TypeError) {
    return (
      `Could not reach the server at ${API_BASE}. The backend may be stopped ` +
      `or restarting — check its terminal for an error first. Otherwise this is ` +
      `usually a CORS or wrong-backend-URL problem: check that VITE_API_BASE ` +
      `(frontend) points at this backend, and that CORS_ORIGINS (backend) ` +
      `includes this site's URL.`
    );
  }
  return err.message || "Something went wrong. Please try again.";
}


export async function apiFetch(path, options = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers = { ...(options.headers || {}) };

  if (options.body && !headers["Content-Type"] && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (response.status === 401) {

    const body = await response.json().catch(() => ({}));
    const err = new Error(body.detail || "Your session expired. Please log in again.");
    err.sessionExpired = true;
    throw err;
  }

  return response;
}

export async function apiFetchJson(path, options = {}) {
  const response = await apiFetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${response.status})`);
  }
  return response.json();
}
