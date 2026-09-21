import { useState } from "react";
import { supabase } from "../supabaseClient";

function Login() {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [confirmationSent, setConfirmationSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      setError("Please enter both an email and a password.");
      return;
    }
    setLoading(true);
    setError("");
    setConfirmationSent(false);

    try {
      if (mode === "login") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (signInError) throw signInError;
        // Success: onAuthStateChange in App.jsx takes it from here.
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
        });
        if (signUpError) throw signUpError;
        // If email confirmation is required, Supabase creates the user but
        // returns no active session — data.session is null in that case.
        // (A signUp for an email that already exists and is already
        // confirmed also comes back this way, with no error, as an
        // anti-enumeration measure — the message below covers both.)
        if (!data.session) {
          setConfirmationSent(true);
        }
        // Otherwise: session came back active immediately, and
        // onAuthStateChange in App.jsx takes it from here.
      }
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-xl border border-line bg-paper p-3 text-ink placeholder:text-faint transition focus:border-accent focus:bg-paper-raised focus:outline-none focus:ring-2 focus:ring-accent-soft";
  const labelClass = "mb-1.5 block text-sm font-medium text-ink-soft";

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-card"
    >
      <div className="h-1.5 w-full bg-accent" />
      <div className="p-5 sm:p-6">
        <h2 className="mb-1 font-display text-xl font-semibold text-ink">
          {mode === "login" ? "Welcome back" : "Create your account"}
        </h2>
        <p className="mb-6 text-sm text-muted">
          {mode === "login"
            ? "Log in with your email and password."
            : "Sign up with your email — takes a second."}
        </p>

        <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl border border-line bg-paper p-1">
          <button
            type="button"
            onClick={() => {
              setMode("login");
              setError("");
              setConfirmationSent(false);
            }}
            className={`rounded-lg py-2 text-sm font-semibold transition ${mode === "login"
                ? "bg-paper-raised text-ink shadow-sm ring-1 ring-line-strong"
                : "text-muted hover:text-ink-soft"
              }`}
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("register");
              setError("");
              setConfirmationSent(false);
            }}
            className={`rounded-lg py-2 text-sm font-semibold transition ${mode === "register"
                ? "bg-paper-raised text-ink shadow-sm ring-1 ring-line-strong"
                : "text-muted hover:text-ink-soft"
              }`}
          >
            Sign up
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={labelClass}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={inputClass}
              autoComplete="email"
            />
          </div>
          <div>
            <label className={labelClass}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className={inputClass}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
        </div>

        {confirmationSent && (
          <p className="mt-4 rounded-lg bg-accent-soft p-3 text-sm text-ink-soft">
            Check your email for a confirmation link, then log in.
          </p>
        )}

        {error && (
          <p className="mt-4 flex items-start gap-2 text-sm text-error-text">
            <span className="mt-0.5">✕</span>
            <span>{error}</span>
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-ink p-3 font-semibold text-paper-raised transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:bg-faint active:scale-[0.99]"
        >
          {loading
            ? mode === "login"
              ? "Logging in…"
              : "Creating account…"
            : mode === "login"
              ? "Log in"
              : "Create account"}
        </button>
      </div>
    </form>
  );
}

/** Supabase's error.message strings are written for developers, not
 * students — remap the common ones the way the old backend's HTTPException
 * details used to read, and fall back to the raw message otherwise. */
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
    return msg; // already student-readable as-is
  }
  if (err instanceof TypeError) {
    return "Could not reach the authentication server. Check your connection and try again.";
  }
  return msg || "Something went wrong. Please try again.";
}

export default Login;
