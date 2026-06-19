// Thumbnail picker: a single themed drag-and-drop box that doubles as the
// live preview (click to browse). The hidden <input type="file"> is exposed
// as `.fileInput` so callers can read `.files[0]` and listen for change.
//
// Images behave as before. A dropped video (MP4/MOV/WebM) prompts for one of
// two outcomes in the same slot:
//   • Animated preview — the raw video is sent to the backend, which converts
//     it to a looping animated WebP (and archives the untouched original).
//   • Pick a frame — a single frame is captured in the browser as a static
//     WebP; the original video is still archived alongside it.
// Callers get the right upload parts via `await field.getUpload()`.

import { el, clear, showToast } from "./vault_dom.js";
import { makeThumbnailFile, captureVideoFrameFile } from "./vault_image.js";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXTS = ["mp4", "mov", "webm"];
const THUMB_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS];
const MAX_THUMB_BYTES = 256 * 1024 * 1024; // matches backend MAX_UPLOAD_BYTES

function extOf(name) {
  const i = (name || "").lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function isVideoFile(file) {
  return file && VIDEO_EXTS.includes(extOf(file.name));
}

export function renderThumbnailField({ currentUrl = null } = {}) {
  let objectUrl = null; // for image/video previews and frame picking
  // mode: "none" | "image" | "video-animated" | "video-frame"
  let mode = currentUrl ? "image" : "none";
  let videoFile = null; // the picked source video (archived as-is)
  let frameFile = null; // captured still frame (for "video-frame")
  let busy = false; // true while the choice / frame-pick UI is showing

  const fileInput = el("input", {
    type: "file",
    accept: "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm",
    className: "wv-visually-hidden",
  });

  const zone = el("div", {
    className: "wv-dropzone wv-thumb-dropzone",
    role: "button",
    tabindex: "0",
    "aria-label": "Choose or drop a thumbnail image or video",
    onclick: () => {
      if (!busy) fileInput.click();
    },
    onkeydown: (e) => {
      if (!busy && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        fileInput.click();
      }
    },
  });

  function freeObjectUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  function showPrompt() {
    busy = false;
    clear(zone);
    zone.classList.remove("wv-thumb-has-image");
    zone.appendChild(el("i", { className: "pi pi-image wv-dropzone-icon" }));
    zone.appendChild(el("div", { className: "wv-dropzone-text" }, ["Drag a file here, or ", el("span", { className: "wv-dropzone-browse" }, ["browse"])]));
    zone.appendChild(el("div", { className: "wv-dropzone-hint" }, ["Image (PNG · JPG · WebP · GIF) or video (MP4 · MOV · WebM)"]));
  }

  function showImage(src) {
    busy = false;
    clear(zone);
    zone.classList.add("wv-thumb-has-image");
    zone.appendChild(el("img", { src, alt: "Thumbnail preview", className: "wv-thumb-img" }));
    zone.appendChild(el("div", { className: "wv-thumb-change" }, ["Change"]));
  }

  function showVideoPreview(src) {
    busy = false;
    clear(zone);
    zone.classList.add("wv-thumb-has-image");
    zone.appendChild(
      el("video", { src, className: "wv-thumb-img", autoplay: true, muted: true, loop: true, playsinline: true })
    );
    zone.appendChild(el("div", { className: "wv-thumb-change" }, ["Change"]));
  }

  // Two-way fork shown right after a video is picked.
  function showVideoChoice(src) {
    busy = true;
    clear(zone);
    zone.classList.remove("wv-thumb-has-image");
    const stop = (fn) => (e) => {
      e.stopPropagation();
      fn();
    };
    zone.appendChild(el("div", { className: "wv-thumb-choice-title" }, ["What should this thumbnail be?"]));
    const row = el("div", { className: "wv-thumb-choice-row" });
    row.appendChild(
      el("button", { type: "button", className: "wv-btn wv-btn-primary wv-thumb-choice-btn", onclick: stop(() => chooseAnimated(src)) }, [
        el("i", { className: "pi pi-play" }),
        el("span", {}, ["Animated"]),
      ])
    );
    row.appendChild(
      el("button", { type: "button", className: "wv-btn wv-thumb-choice-btn", onclick: stop(() => openFramePicker(src)) }, [
        el("i", { className: "pi pi-image" }),
        el("span", {}, ["Static frame"]),
      ])
    );
    zone.appendChild(row);
    zone.appendChild(el("div", { className: "wv-dropzone-hint" }, ["Animated loops the clip; a frame is a single still."]));
  }

  function chooseAnimated(src) {
    mode = "video-animated";
    frameFile = null;
    showVideoPreview(src);
  }

  // In-browser frame scrubber (no ffmpeg), shown as a centered modal overlay so
  // the player isn't crammed into the small thumbnail box. The choice prompt
  // stays underneath, so dismissing the picker returns to it.
  function openFramePicker(src) {
    const overlay = el("div", { className: "wv-overlay wv-overlay-dialog" });

    const cleanup = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup();
    };

    const video = el("video", { src, className: "wv-framepick-video", muted: true, playsinline: true, preload: "auto" });
    const slider = el("input", { type: "range", min: "0", max: "1000", value: "0", className: "wv-framepick-slider", disabled: true });

    const useBtn = el(
      "button",
      {
        type: "button",
        className: "wv-btn wv-btn-primary",
        disabled: true,
        onclick: async () => {
          // Seeking is asynchronous: if the user clicks right after dragging,
          // wait for the seek to settle so we capture the frame they actually
          // chose rather than the previously-painted one.
          if (video.seeking) {
            await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
          }
          const file = await captureVideoFrameFile(video);
          if (!file) {
            showToast("Couldn't capture that frame — try a different position.", "error");
            return;
          }
          frameFile = file;
          mode = "video-frame";
          freeObjectUrl();
          objectUrl = URL.createObjectURL(file);
          showImage(objectUrl);
          cleanup();
        },
      },
      [el("i", { className: "pi pi-check" }), el("span", {}, ["Use this frame"])]
    );
    const backBtn = el("button", { type: "button", className: "wv-btn", onclick: cleanup }, [
      el("i", { className: "pi pi-arrow-left" }),
      el("span", {}, ["Back"]),
    ]);

    // Enable the controls as soon as the video is usable. We don't rely on a
    // single event: depending on the codec/browser, any of loadedmetadata /
    // loadeddata / canplay may be the first to fire (and a missed one would
    // otherwise leave the slider + button disabled forever). A timeout is a
    // last-resort fallback so the picker is never permanently dead.
    let enabled = false;
    const enableControls = () => {
      if (enabled) return;
      enabled = true;
      slider.disabled = false;
      useBtn.disabled = false;
      // Seek a touch past 0 so the first painted frame isn't black.
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) * 0.05);
      } catch {
        /* seeking may throw before data is ready; ignore */
      }
    };
    for (const ev of ["loadedmetadata", "loadeddata", "canplay"]) {
      video.addEventListener(ev, enableControls);
    }
    setTimeout(enableControls, 2500);
    slider.addEventListener("input", () => {
      const dur = video.duration || 0;
      if (dur > 0) video.currentTime = (Number(slider.value) / 1000) * dur;
    });

    const box = el("div", { className: "wv-dialog wv-framepick-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Pick a frame" }, [
      el("div", { className: "wv-dialog-title" }, ["Pick a frame"]),
      el("div", { className: "wv-dialog-body wv-framepick-body" }, [video, slider]),
      el("div", { className: "wv-dialog-footer" }, [backBtn, useBtn]),
    ]);

    overlay.appendChild(box);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) cleanup();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  }

  // Called when a fresh file lands in the input (browse or drop).
  function onFilePicked() {
    const file = fileInput.files[0];
    freeObjectUrl();
    videoFile = null;
    frameFile = null;
    if (!file) {
      mode = currentUrl ? "image" : "none";
      if (currentUrl) showImage(currentUrl);
      else showPrompt();
      return;
    }
    if (isVideoFile(file)) {
      videoFile = file;
      objectUrl = URL.createObjectURL(file);
      showVideoChoice(objectUrl);
    } else {
      mode = "image";
      objectUrl = URL.createObjectURL(file);
      showImage(objectUrl);
    }
  }

  // Initial paint.
  if (currentUrl) showImage(currentUrl);
  else showPrompt();

  function validate(file) {
    if (!file) return false;
    if (!THUMB_EXTS.includes(extOf(file.name))) {
      showToast(`"${file.name}" isn't a supported image or video (PNG, JPG, WebP, GIF, MP4, MOV, WebM).`, "error");
      return false;
    }
    if (file.size > MAX_THUMB_BYTES) {
      showToast(`"${file.name}" exceeds the ${MAX_THUMB_BYTES / (1024 * 1024)} MB limit.`, "error");
      return false;
    }
    return true;
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file && !validate(file)) {
      fileInput.value = "";
    }
    onFilePicked();
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("wv-dropzone-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("wv-dropzone-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("wv-dropzone-over");
    const file = e.dataTransfer?.files?.[0];
    if (!file || !validate(file)) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const wrap = el("div", { className: "wv-thumb-field" }, [zone, fileInput]);
  wrap.fileInput = fileInput;

  // Builds the upload parts for the current selection, or null if unchanged.
  // Returns { thumbnail, thumbnail_source, mtime } where thumbnail is the small
  // display file and thumbnail_source is the archival original (may equal the
  // video, or be null for plain images that are their own source… kept here for
  // parity with the existing flow).
  wrap.getUpload = async () => {
    if (mode === "video-animated" && videoFile) {
      // Raw video → backend converts to animated WebP; original archived.
      return { thumbnail: videoFile, thumbnail_source: videoFile, mtime: videoFile.lastModified };
    }
    if (mode === "video-frame" && frameFile && videoFile) {
      // Browser-captured still; original video still archived alongside it.
      return { thumbnail: frameFile, thumbnail_source: videoFile, mtime: videoFile.lastModified };
    }
    const picked = fileInput.files[0];
    if (picked && !isVideoFile(picked)) {
      // Plain image: downscale for display, keep the original as the source.
      return { thumbnail: await makeThumbnailFile(picked), thumbnail_source: picked, mtime: picked.lastModified };
    }
    return null;
  };

  return wrap;
}
