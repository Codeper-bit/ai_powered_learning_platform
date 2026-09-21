import { useState } from "react";
import { supabase } from "../supabaseClient";

/**
 * Shown when the app is opened from a Supabase "reset password" email link.
 * By the time this renders, supabase-js has already parsed the recovery
 * token out of the URL and holds a temporary session for this user (that's
 * what the PASSWORD_RECOVERY event in App.jsx is reacting to) — so all this
 * form has to do is call updateUser() with the new password.
 */

const inputClass =
  "w-full rounded-xl border border-line bg-paper p-3 text-ink placeholder:text-faint transition focus:border-accent focus:bg-paper-raised focus:outline-none focus:ring-2 focus:ring-accent-soft";
const labelClass = "mb-1.5 block text-sm font-medium text-ink-soft";

function ResetPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setDone(true);
    } catch (err) {
      setError(err?.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-card">
      <div className="h-1.5 w-full bg-accent" />
      <div className="p-5 sm:p-7">
        <h2 className="mb-1 font-display text-2xl font-semibold text-ink">
          Choose a new password
        </h2>
        <p className="mb-6 text-sm text-muted">
          You're signed in from the reset link — set a new password below.
        </p>

        {done ? (
          <div>
            <p
              role="status"
              className="rounded-lg bg-accent-soft p-3 text-sm text-ink-soft"
            >
              Password updated. You're all set.
            </p>
            <button
              type="button"
              onClick={onDone}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-ink p-3 font-semibold text-paper-raised transition hover:bg-ink-soft active:scale-[0.99]"
            >
              Continue
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <div className="space-y-4">
              <div>
                <label htmlFor="new-password" className={labelClass}>
                  New password
                </label>
                <input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className={inputClass}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label htmlFor="confirm-password" className={labelClass}>
                  Confirm password
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Type it again"
                  className={inputClass}
                  autoComplete="new-password"
                />
              </div>
            </div>

            {error && (
              <p role="alert" className="mt-4 flex items-start gap-2 text-sm text-error-text">
                <span className="mt-0.5">✕</span>
                <span>{error}</span>
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-ink p-3 font-semibold text-paper-raised transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:bg-faint active:scale-[0.99]"
            >
              {loading ? "Updating…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default ResetPassword;
