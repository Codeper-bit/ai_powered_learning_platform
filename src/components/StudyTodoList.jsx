import { useEffect, useState } from "react";
import { apiFetchJson } from "../api";

const PRIORITY = {
  high: { label: "High", dot: "bg-error", ring: "ring-error-soft" },
  medium: { label: "Medium", dot: "bg-accent", ring: "ring-accent-soft" },
  low: { label: "Low", dot: "bg-success", ring: "ring-success-soft" },
};

function daysUntil(iso) {
  if (!iso) return null;
  const due = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

function dueLabel(iso) {
  const days = daysUntil(iso);
  if (days === null) return null;
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, urgent: true };
  if (days === 0) return { text: "Due today", urgent: true };
  if (days === 1) return { text: "Due tomorrow", urgent: false };
  return { text: `Due in ${days}d`, urgent: false };
}

/** Academic to-do list: assignments, revision, deadlines. Lives on the
 * dashboard next to the learning-curve data — same visual language
 * (paper/ink/accent tokens, rounded-2xl cards) as the rest of the app. */
function StudyTodoList() {
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("medium");
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetchJson("/todos")
      .then((data) => {
        if (!cancelled) setTodos(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load your tasks.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function addTask(e) {
    e.preventDefault();
    if (!title.trim() || adding) return;
    setAdding(true);
    setError("");
    try {
      const created = await apiFetchJson("/todos", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          subject: subject.trim() || null,
          due_date: dueDate || null,
          priority,
        }),
      });
      setTodos((prev) => [...prev, created]);
      setTitle("");
      setSubject("");
      setDueDate("");
      setPriority("medium");
      setShowForm(false);
    } catch (err) {
      setError(err.message || "Could not add that task.");
    } finally {
      setAdding(false);
    }
  }

  async function toggleComplete(todo) {
    const optimistic = { ...todo, is_complete: !todo.is_complete };
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? optimistic : t)));
    try {
      await apiFetchJson(`/todos/${todo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_complete: optimistic.is_complete }),
      });
    } catch (err) {
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? todo : t))); // revert
      setError(err.message || "Could not update that task.");
    }
  }

  async function removeTask(id) {
    const prevTodos = todos;
    setTodos((prev) => prev.filter((t) => t.id !== id));
    try {
      await apiFetchJson(`/todos/${id}`, { method: "DELETE" });
    } catch (err) {
      setTodos(prevTodos); // revert
      setError(err.message || "Could not remove that task.");
    }
  }

  const pending = todos.filter((t) => !t.is_complete);
  const done = todos.filter((t) => t.is_complete);

  return (
    <div className="rounded-2xl border border-line bg-paper-raised p-6 shadow-card sm:p-8">
      <div className="mb-1 flex items-center justify-between">
        <p className="font-display text-lg font-semibold text-ink">Study tasks</p>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-lg border border-line-strong bg-paper px-3 py-1.5 text-sm font-semibold text-ink-soft transition hover:bg-paper-raised active:scale-[0.99]"
        >
          {showForm ? "Cancel" : "+ Add task"}
        </button>
      </div>
      <p className="mb-4 text-sm text-muted">
        Assignments, revision, and deadlines — kept separate from your quiz sessions.
      </p>

      {showForm && (
        <form onSubmit={addTask} className="mb-5 space-y-3 rounded-xl border border-line bg-paper p-4">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Finish chemistry problem set"
            className="w-full rounded-lg border border-line bg-paper-raised p-2.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
            autoFocus
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject (optional)"
              className="col-span-2 rounded-lg border border-line bg-paper-raised p-2.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft sm:col-span-1"
            />
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="rounded-lg border border-line bg-paper-raised p-2.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
            />
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="field-select rounded-lg border border-line bg-paper-raised p-2.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
            >
              <option value="low">Low priority</option>
              <option value="medium">Medium priority</option>
              <option value="high">High priority</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={adding || !title.trim()}
            className="w-full rounded-lg bg-ink py-2.5 text-sm font-semibold text-paper-raised transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:bg-faint"
          >
            {adding ? "Adding…" : "Add task"}
          </button>
        </form>
      )}

      {error && <p className="mb-3 text-sm text-error-text">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted">Loading your tasks…</p>
      ) : todos.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong bg-paper p-4 text-sm text-muted">
          No tasks yet — add revision, homework, or deadlines to track them here.
        </p>
      ) : (
        <div className="space-y-2">
          {pending.map((todo) => {
            const due = dueLabel(todo.due_date);
            const pri = PRIORITY[todo.priority] || PRIORITY.medium;
            return (
              <div
                key={todo.id}
                className="flex items-center gap-3 rounded-xl border border-line bg-paper p-3"
              >
                <button
                  onClick={() => toggleComplete(todo)}
                  aria-label="Mark complete"
                  className="h-5 w-5 shrink-0 rounded-full border-2 border-line-strong transition hover:border-accent"
                />
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${pri.dot}`} title={`${pri.label} priority`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{todo.title}</p>
                  {todo.subject && <p className="truncate text-xs text-faint">{todo.subject}</p>}
                </div>
                {due && (
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      due.urgent ? "bg-error-soft text-error-text" : "bg-paper-raised text-muted"
                    }`}
                  >
                    {due.text}
                  </span>
                )}
                <button
                  onClick={() => removeTask(todo.id)}
                  aria-label="Delete task"
                  className="shrink-0 text-faint transition hover:text-error-text"
                >
                  ✕
                </button>
              </div>
            );
          })}

          {done.length > 0 && (
            <details className="pt-1">
              <summary className="cursor-pointer text-xs font-medium text-faint">
                {done.length} completed
              </summary>
              <div className="mt-2 space-y-2">
                {done.map((todo) => (
                  <div
                    key={todo.id}
                    className="flex items-center gap-3 rounded-xl border border-line bg-paper/60 p-3"
                  >
                    <button
                      onClick={() => toggleComplete(todo)}
                      aria-label="Mark incomplete"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-paper-raised"
                    >
                      ✓
                    </button>
                    <p className="flex-1 truncate text-sm text-faint line-through">{todo.title}</p>
                    <button
                      onClick={() => removeTask(todo.id)}
                      aria-label="Delete task"
                      className="shrink-0 text-faint transition hover:text-error-text"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default StudyTodoList;
