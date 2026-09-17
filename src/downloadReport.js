/** Build a plain-text results report and trigger a browser download for it.
 * Runs entirely client-side (Blob + object URL) — no backend call, so it
 * works for offline sessions too. */
export function downloadReport({ filename, title, meta, progress }) {
  const lines = [title, "=".repeat(title.length), ""];

  for (const [label, value] of Object.entries(meta)) {
    if (value !== null && value !== undefined && value !== "") {
      lines.push(`${label}: ${value}`);
    }
  }

  lines.push("", "Results by concept:");
  if (progress.length === 0) {
    lines.push("(no attempts recorded)");
  } else {
    for (const item of progress) {
      lines.push(`- ${item.concept}: ${item.correct}/${item.attempts} correct (${item.accuracy}%)`);
    }
  }

  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
