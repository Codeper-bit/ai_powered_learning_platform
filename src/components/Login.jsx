import { useState } from "react";

function Login({ apiBase, onAuthenticated }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !password) {
      setError("Please enter both a name and a password.");
      return;
    }
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${apiBase}/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "login"
            ? { name: name.trim(), password }
            : { name: name.trim(), password, email: email.trim() || null }
        ),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || "Something went wrong.");
      }

      onAuthenticated({ user_id: data.user_id, name: data.name, access_token: data.access_token });
    } catch (err) {
      setError(err.message || "Could not sign you in.");
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
            ? "Log in once — you won't need to type your name again."
            : "Just a name and password. Takes a second."}
        </p>

        <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl border border-line bg-paper p-1">
          <button
            type="button"
            onClick={() => {
              setMode("login");
              setError("");
            }}
            className={`rounded-lg py-2 text-sm font-semibold transition ${
              mode === "login"
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
            }}
            className={`rounded-lg py-2 text-sm font-semibold transition ${
              mode === "register"
                ? "bg-paper-raised text-ink shadow-sm ring-1 ring-line-strong"
                : "text-muted hover:text-ink-soft"
            }`}
          >
            Sign up
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={labelClass}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ada"
              className={inputClass}
              autoComplete="username"
            />
          </div>
          {mode === "register" && (
            <div>
              <label className={labelClass}>Email (optional)</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={inputClass}
                autoComplete="email"
              />
            </div>
          )}
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

export default Login;
