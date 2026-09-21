import { useState } from "react";
import { getCurrentTheme, setTheme } from "../theme";

function ThemeToggle({ className = "" }) {
  const [theme, setThemeState] = useState(getCurrentTheme);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className={`flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-paper text-sm text-ink-soft transition hover:bg-paper-raised ${className}`}
    >
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}

export default ThemeToggle;
