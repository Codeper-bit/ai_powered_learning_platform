import { useState } from "react";
import { supabase } from "../supabaseClient";

/**
 * Login + registration with email and password (Supabase Auth).
 * Sign-up also collects a name, stored in the user's auth metadata and
 * shown in the dashboard header (see applySession in App.jsx).
 */

const inputClass =
  "w-full rounded-xl border border-line bg-paper p-3 text-ink placeholder:text-faint transition focus:border-accent focus:bg-paper-raised focus:outline-none focus:ring-2 focus:ring-accent-soft";
const labelClass = "mb-1.5 block text-sm font-medium text-ink-soft";

function Login() {
  const [mode, setMode] = useState("login"); // "login" | "register" | "forgot"
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false); // email/password in flight
  const [error, setError] = useState("");
  const [confirmationSent, setConfirmationSent] = useState(false);

  // Forgot-password mode has its own in-flight/result state so switching
  // back to login doesn't leave a stale "email sent" message behind.
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState("");
  const [resetSent, setResetSent] = useState(false);

  const isLogin = mode === "login";
  const isForgot = mode === "forgot";

  function switchMode(next) {
    setMode(next);
    setError("");
    setConfirmationSent(false);
    setResetError("");
    setResetSent(false);
  }

  async function handleResetSubmit(e) {
    e.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setResetError("Please enter your email.");
      return;
    }
    setResetLoading(true);
    setResetError("");
    try {
      // redirectTo must be listed under Authentication > URL Configuration
      // > Redirect URLs in the Supabase dashboard, or Supabase silently
      // falls back to the project's Site URL and the link lands somewhere
      // that isn't this app.
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(
        cleanEmail,
        { redirectTo: window.location.origin }
      );
      if (resetErr) throw resetErr;
      setResetSent(true);
    } catch (err) {
      setResetError(err?.message || "Something went wrong. Please try again.");
    } finally {
      setResetLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const cleanEmail = email.trim();
    if (!isLogin && !name.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (!cleanEmail || !password) {
      setError("Please enter both an email and a password.");
      return;
    }
    setLoading(true);
    setError("");
    setConfirmationSent(false);

    try {
      if (isLogin) {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (signInError) throw signInError;
        // Success: onAuthStateChange in App.jsx takes it from here.
      } else {
        const cleanName = name.trim();
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          // Read by the handle_new_user trigger to fill profiles.name.
          options: { data: { name: cleanName } },
        });
        if (signUpError) throw signUpError;
        // With email confirmation on, Supabase returns no session. (An
        // already-confirmed email also comes back this way, with no error,
        // as an anti-enumeration measure — the message covers both.)
        if (!data.session) setConfirmationSent(true);
      }
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-card">
      <div className="h-1.5 w-full bg-accent" />

      <div className="p-5 sm:p-7">
        <h2 className="mb-1 font-display text-2xl font-semibold text-ink">
          {isForgot ? "Reset your password" : isLogin ? "Welcome back" : "Create your account"}
        </h2>
        <p className="mb-6 text-sm text-muted">
          {isForgot
            ? "Enter your email and we'll send you a reset link."
            : isLogin
              ? "Log in with your email and password."
              : "Sign up with your email — takes a second."}
        </p>

        {isForgot ? (
          <form onSubmit={handleResetSubmit} noValidate>
            <div>
              <label htmlFor="forgot-email" className={labelClass}>
                Email
              </label>
              <input
                id="forgot-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={inputClass}
                autoComplete="email"
              />
            </div>

            {resetSent && (
              <p
                role="status"
                className="mt-4 rounded-lg bg-accent-soft p-3 text-sm text-ink-soft"
              >
                If that email has an account, a reset link is on its way. Check your inbox.
              </p>
            )}

            {resetError && (
              <p role="alert" className="mt-4 flex items-start gap-2 text-sm text-error-text">
                <span className="mt-0.5">✕</span>
                <span>{resetError}</span>
              </p>
            )}

            <button
              type="submit"
              disabled={resetLoading}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-ink p-3 font-semibold text-paper-raised transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:bg-faint active:scale-[0.99]"
            >
              {resetLoading && <Spinner />}
              {resetLoading ? "Sending…" : "Send reset link"}
            </button>

            <p className="mt-6 text-center text-sm text-muted">
              <button
                type="button"
                onClick={() => switchMode("login")}
                className="font-semibold text-ink underline decoration-accent decoration-2 underline-offset-4 transition hover:text-ink-soft"
              >
                ← Back to log in
              </button>
            </p>
          </form>
        ) : (
        <>
        <form onSubmit={handleSubmit} noValidate>
          <div className="space-y-4">
            {!isLogin && (
              <div>
                <label htmlFor="auth-name" className={labelClass}>
                  Name
                </label>
                <input
                  id="auth-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className={inputClass}
                  autoComplete="name"
                />
              </div>
            )}

            <div>
              <label htmlFor="auth-email" className={labelClass}>
                Email
              </label>
              <input
                id="auth-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={inputClass}
                autoComplete="email"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="auth-password" className={labelClass + " mb-0"}>
                  Password
                </label>
                {isLogin && (
                  <button
                    type="button"
                    onClick={() => switchMode("forgot")}
                    className="text-xs font-semibold text-muted underline underline-offset-2 transition hover:text-ink-soft"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isLogin ? "Your password" : "At least 6 characters"}
                  className={`${inputClass} pr-16`}
                  autoComplete={isLogin ? "current-password" : "new-password"}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 px-4 text-xs font-semibold text-muted transition hover:text-ink"
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>
          </div>

          {confirmationSent && (
            <p
              role="status"
              className="mt-4 rounded-lg bg-accent-soft p-3 text-sm text-ink-soft"
            >
              Check your email for a confirmation link, then log in.
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 text-sm text-error-text"
            >
              <span className="mt-0.5">✕</span>
              <span>{error}</span>
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-ink p-3 font-semibold text-paper-raised transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:bg-faint active:scale-[0.99]"
          >
            {loading && <Spinner />}
            {loading
              ? isLogin
                ? "Logging in…"
                : "Creating account…"
              : isLogin
                ? "Log in"
                : "Create account"}
          </button>
        </form>

        {/* Mode switch */}
        <p className="mt-6 text-center text-sm text-muted">
          {isLogin ? "New here?" : "Already have an account?"}{" "}
          <button
            type="button"
            onClick={() => switchMode(isLogin ? "register" : "login")}
            className="font-semibold text-ink underline decoration-accent decoration-2 underline-offset-4 transition hover:text-ink-soft"
          >
            {isLogin ? "Create an account" : "Log in"}
          </button>
        </p>
        </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Supabase's error.message strings are written for developers, not
 * students — remap the common ones and fall back to the raw message. */
function describeAuthError(err) {
  const msg = err?.message || "";

  if (/invalid login credentials/i.test(msg)) {
    return "Incorrect email or password.";
  }
  if (/user already registered/i.test(msg)) {
    return "That email is already registered. Try logging in instead.";
  }
  if (/email not confirmed/i.test(msg)) {
    return "Please confirm your email first — check your inbox for the link.";
  }
  if (/password should be at least/i.test(msg)) {
    return msg;
  }
  if (err instanceof TypeError) {
    return "Could not reach the authentication server. Check your connection and try again.";
  }
  return msg || "Something went wrong. Please try again.";
}

export default Login;
