// Detects media sitting on the live ComfyUI canvas — input files loaded into
// loader nodes and output files produced by preview/save nodes — so the Save
// wizard can import them instead of making the user re-pick the same files by
// hand. Fetched refs come back as File objects that flow through the exact same
// FormData upload path the drag-and-drop pickers already use.
//
// Best-effort by design. It recognizes the common shapes:
//   • core image nodes (LoadImage, PreviewImage, SaveImage)
//   • audio (core LoadAudio + audio result arrays)
//   • Video Helper Suite loaders/savers (VHS_LoadVideo, VHS_LoadAudio,
//     VHS_VideoCombine, …) via their preview-widget params
// Unknown custom nodes that don't expose media in a recognizable shape are just
// skipped — the caller surfaces a "no media found" toast when nothing turns up.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXTS = ["mp4", "mov", "webm", "mkv", "avi", "m4v"];
const AUDIO_EXTS = ["wav", "mp3", "m4a", "flac", "ogg"];
const MEDIA_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS];

// Loader nodes that stash their picked file as a plain string widget value.
const LOADER_WIDGET_NAMES = ["audio", "video", "image", "images", "file", "media"];

function arrayify(x) {
  return Array.isArray(x) ? x : [];
}

function extOf(name) {
  const clean = String(name || "").split(/[?#]/)[0];
  const i = clean.lastIndexOf(".");
  return i >= 0 ? clean.slice(i + 1).toLowerCase() : "";
}

// image | video | audio | null. Prefer the VHS `format` hint (e.g.
// "video/h264-mp4", "audio/mp3", "image/gif") and fall back to the extension.
function mediaKindOf(name, format) {
  const fmt = String(format || "");
  if (fmt.startsWith("image/")) return "image";
  if (fmt.startsWith("video/")) return "video";
  if (fmt.startsWith("audio/")) return "audio";
  const ext = extOf(name);
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  return null;
}

// ComfyUI serves the input folder under type=input and results under
// type=output (saved) or type=temp (previews). Everything non-input is a result.
function roleOf(type) {
  return type === "input" ? "input" : "output";
}

// Pull filename/subfolder/type out of a /view?... URL (node.imgs[].src).
function parseViewUrl(src) {
  if (!src) return null;
  try {
    const u = new URL(src, window.location.href);
    const filename = u.searchParams.get("filename");
    if (!filename) return null;
    return {
      filename,
      subfolder: u.searchParams.get("subfolder") || "",
      type: u.searchParams.get("type") || "output",
    };
  } catch {
    return null;
  }
}

function isLoaderWidgetName(name) {
  return LOADER_WIDGET_NAMES.includes(String(name || "").toLowerCase());
}

// Scan the live graph. Returns a de-duped list of:
//   { filename, subfolder, type, role, mediaType, url }
// role: "input" | "output"; mediaType: "image" | "video" | "audio".
export function detectCanvasMedia() {
  const nodes = app.graph?._nodes || app.graph?.nodes || [];
  const byKey = new Map();

  const add = (filename, subfolder, type, format) => {
    if (!filename || typeof filename !== "string") return;
    const kind = mediaKindOf(filename, format);
    if (!kind) return;
    const t = type || "output";
    const sub = subfolder || "";
    const key = `${t}|${sub}|${filename}`;
    if (byKey.has(key)) return;
    const params = new URLSearchParams({ filename, type: t });
    if (sub) params.set("subfolder", sub);
    byKey.set(key, {
      filename: filename.split(/[\\/]/).pop(),
      subfolder: sub,
      type: t,
      role: roleOf(t),
      mediaType: kind,
      url: api.apiURL(`/view?${params.toString()}`),
    });
  };

  for (const node of nodes) {
    if (!node) continue;
    if (node.mode === 2 || node.mode === 4) continue; // skip muted / bypassed

    // Image output specs set on preview/save nodes after a run.
    for (const spec of arrayify(node.images)) {
      if (spec?.filename) add(spec.filename, spec.subfolder, spec.type, spec.format);
    }
    // Generic result arrays some savers set (audio-only, animated, …).
    for (const bucket of ["audio", "gifs", "video", "videos"]) {
      for (const spec of arrayify(node[bucket])) {
        if (spec?.filename) add(spec.filename, spec.subfolder, spec.type, spec.format);
      }
    }
    // Rendered <img> elements — LoadImage inputs and image outputs.
    for (const img of arrayify(node.imgs)) {
      const ref = parseViewUrl(img?.src);
      if (ref) add(ref.filename, ref.subfolder, ref.type);
    }
    // Widgets: VHS preview params (loaders + VideoCombine), and plain-string
    // filename widgets on simple loaders (core LoadAudio, etc.).
    for (const w of arrayify(node.widgets)) {
      const p = w?.value?.params;
      if (p?.filename) add(p.filename, p.subfolder, p.type, p.format);
      if (
        typeof w?.value === "string" &&
        isLoaderWidgetName(w.name) &&
        MEDIA_EXTS.includes(extOf(w.value))
      ) {
        add(w.value, "", "input");
      }
    }
  }

  return [...byKey.values()];
}

// Fetch a detected item and wrap it as a File named after the original, ready
// to hand to the upload pipeline. Throws on a failed fetch.
export async function fetchCanvasFile(item) {
  const resp = await fetch(item.url);
  if (!resp.ok) throw new Error(`Couldn't fetch "${item.filename}" (HTTP ${resp.status}).`);
  const blob = await resp.blob();
  return new File([blob], item.filename, blob.type ? { type: blob.type } : undefined);
}
