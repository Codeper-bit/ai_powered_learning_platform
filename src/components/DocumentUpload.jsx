import { useCallback, useRef, useState } from "react";

const ACCEPTED_EXTENSIONS = [".txt", ".md", ".pdf", ".docx", ".csv", ".rtf"];
const MAX_FILE_MB = 8;

/**
 * Upload button + drag-and-drop zone for study material. On success it
 * reports { document_id, filename, word_count } up to the parent so the
 * quiz can be generated from the document instead of a bare topic.
 */
function DocumentUpload({ apiBase, document, onDocumentReady, onClear, disabled }) {
  const inputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const uploadFile = useCallback(
    async (file) => {
      if (!file) return;

      const ext = "." + file.name.split(".").pop().toLowerCase();
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        setUploadError(`Unsupported file type. Use: ${ACCEPTED_EXTENSIONS.join(", ")}`);
        return;
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        setUploadError(`File is too large — max ${MAX_FILE_MB}MB.`);
        return;
      }

      setUploading(true);
      setUploadError("");

      try {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch(`${apiBase}/documents/upload`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.detail || "Upload failed");
        }

        const data = await response.json();
        onDocumentReady(data);
      } catch (err) {
        setUploadError(err.message || "Could not upload this file.");
      } finally {
        setUploading(false);
      }
    },
    [apiBase, onDocumentReady]
  );

  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    uploadFile(file);
  }

  if (document) {
    return (
      <div className="animate-rise-in flex items-center justify-between gap-3 rounded-xl border border-success-soft bg-success-soft/60 p-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-success-soft text-lg">
            📄
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-success-text">{document.filename}</p>
            <p className="text-xs text-success-text/80">{document.word_count.toLocaleString()} words ready to use</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-success-text transition hover:bg-success-soft disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    );
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => !disabled && !uploading && inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-6 text-center transition ${
          dragActive
            ? "scale-[1.01] border-accent bg-accent-soft/50"
            : "border-line-strong bg-paper hover:border-accent/60 hover:bg-accent-soft/20"
        } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(",")}
          disabled={disabled}
          onChange={(e) => uploadFile(e.target.files?.[0])}
          className="hidden"
        />
        <span className={`flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-xl ${uploading ? "animate-spin-slow" : ""}`}>
          {uploading ? "⏳" : "📤"}
        </span>
        <p className="mt-1 text-sm font-medium text-ink-soft">
          {uploading ? "Extracting text…" : "Upload a document to quiz yourself on it"}
        </p>
        <p className="text-xs text-faint">
          {ACCEPTED_EXTENSIONS.join(" · ")} — up to {MAX_FILE_MB}MB
        </p>
      </div>
      {uploadError && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-error-text">
          <span className="mt-0.5">✕</span>
          <span>{uploadError}</span>
        </p>
      )}
    </div>
  );
}

export default DocumentUpload;
