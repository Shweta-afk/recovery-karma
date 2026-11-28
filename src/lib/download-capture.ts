// "Email a report": the Reports pages' button arms a capture, and the NEXT file any download
// helper builds is handed to it instead of being saved — so every existing export can be
// emailed without each one being rewired.

type Capture = (file: { filename: string; blob: Blob }) => void;
let pending: Capture | null = null;

export function captureNextDownload(fn: Capture | null): void {
  pending = fn;
}

export function isCapturing(): boolean {
  return pending !== null;
}

/** Save a file, unless "Email a report" is waiting for it. */
export function downloadBlob(filename: string, blob: Blob): void {
  if (deliverOrCapture(filename, blob)) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Returns true when the file was captured (the caller must not download it). */
export function deliverOrCapture(filename: string, blob: Blob): boolean {
  if (!pending) return false;
  const fn = pending;
  pending = null;
  fn({ filename, blob });
  return true;
}
