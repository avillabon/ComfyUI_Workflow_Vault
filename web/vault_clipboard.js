// Clipboard → File helpers shared by the media pickers.
//
// Two routes in, because they carry different things:
//   • a paste event (Ctrl+V) — screenshots *and* files copied in the OS file
//     manager, which arrive with their real names (so videos come this way);
//   • navigator.clipboard.read() — driven by a button, needs no focus, but
//     only ever yields raw image blobs. Firefox additionally makes the user
//     confirm with its own paste popup; that prompt is the browser's and can't
//     be suppressed, which is why Ctrl+V stays the one-gesture path.
// Raw blobs have no filename, so one is synthesized from the MIME type:
// validation, the image/video fork, and the backend all key off the extension.

import { el, showToast } from "./vault_dom.js";

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
};

// Marks an element as somewhere a paste can land, so zones can tell whether
// *another* zone owns the keyboard focus (see zoneClaimsPaste).
const PASTE_TARGET = "data-wv-paste-target";
const TYPING_SELECTOR = "input:not([type=file]), textarea, [contenteditable=''], [contenteditable='true']";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Named files pass through untouched — their real name is what the user sees in
// any "unsupported file" message. Anonymous blobs get a name from their type;
// an unrecognized type yields null (there is no name to complain about).
function toFile(blob, type) {
  if (!blob) return null;
  if (blob instanceof File && blob.name && blob.name.includes(".")) return blob;
  const mime = String(type || blob.type || "").toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) return null;
  return new File([blob], `pasted-${stamp()}.${ext}`, { type: blob.type || mime });
}

// Every usable file on a paste event. Empty when the clipboard held only text,
// which is the common case — callers stay silent then and let the paste be.
export function filesFromPaste(event) {
  const dt = event?.clipboardData;
  if (!dt) return [];
  const dropped = Array.from(dt.files || []);
  if (dropped.length) return dropped.map((f) => toFile(f)).filter(Boolean);
  return Array.from(dt.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => toFile(item.getAsFile(), item.type))
    .filter(Boolean);
}

export function canReadClipboard() {
  return typeof navigator !== "undefined" && !!navigator.clipboard?.read;
}

// Button-driven read. Throws with a user-facing message on every failure path
// so callers can just toast `e.message`.
export async function readClipboardFiles() {
  if (!canReadClipboard()) {
    throw new Error("This browser can't read the clipboard directly — click the box and press Ctrl+V instead.");
  }
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch (e) {
    // NotAllowedError covers a denied permission, a dismissed paste prompt,
    // and an unfocused document.
    if (e?.name === "NotAllowedError") {
      throw new Error("Clipboard access was blocked — allow it for this page, or click the box and press Ctrl+V.");
    }
    throw new Error(`Couldn't read the clipboard: ${e.message}`);
  }
  const files = [];
  for (const item of items) {
    const type = item.types.find((t) => MIME_EXT[t.toLowerCase()]);
    if (!type) continue;
    const file = toFile(await item.getType(type), type);
    if (file) files.push(file);
  }
  if (!files.length) throw new Error("No image on the clipboard — copy one first.");
  return files;
}

// Decides whether `zone` should handle this paste. Several zones can be on
// screen at once (thumbnail, compare image, example inputs/outputs), so:
// typing fields keep their own paste, focus beats the cursor, and the first
// zone to claim an event is the only one that acts on it.
function zoneClaimsPaste(zone, event) {
  if (event.defaultPrevented) return false;
  if (event.target instanceof Element && event.target.closest(TYPING_SELECTOR)) return false;
  if (zone.contains(document.activeElement)) return true;
  return !document.activeElement?.closest?.(`[${PASTE_TARGET}]`) && zone.matches(":hover");
}

/**
 * Routes Ctrl+V into `zone` — when it holds focus, or when the cursor is over
 * it — calling `onFiles(files)` with everything usable on the clipboard.
 * `isBusy` suspends the zone while it's showing its own prompt.
 */
export function onPasteInto(zone, onFiles, { isBusy = () => false } = {}) {
  zone.setAttribute(PASTE_TARGET, "");
  const onPaste = (event) => {
    // Zones are rebuilt each time a modal opens and never torn down
    // explicitly, so the listener retires itself once its zone is off-DOM
    // instead of accumulating one per open.
    if (!zone.isConnected) {
      document.removeEventListener("paste", onPaste);
      return;
    }
    if (isBusy() || !zoneClaimsPaste(zone, event)) return;
    const files = filesFromPaste(event);
    if (!files.length) return; // text-only clipboard — let the paste go where it would
    event.preventDefault();
    onFiles(files);
  };
  document.addEventListener("paste", onPaste);
}

/**
 * The explicit "Paste from clipboard" affordance, for people who'd rather
 * click than aim a Ctrl+V. Returns null when the browser can't read the
 * clipboard on demand, in which case Ctrl+V is still available.
 */
export function renderPasteButton({ className = "wv-btn-link", title, onFiles }) {
  if (!canReadClipboard()) return null;
  const btn = el("button", { type: "button", className, title }, [
    el("i", { className: "pi pi-clipboard" }),
    el("span", {}, ["Paste from clipboard"]),
  ]);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await onFiles(await readClipboardFiles());
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
