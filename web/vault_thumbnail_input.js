// Thumbnail picker: a single themed drag-and-drop box that doubles as the
// live preview (click to browse). The hidden <input type="file"> is exposed
// as `.fileInput` so callers can read `.files[0]` and listen for change.

import { el, clear, showToast } from "./vault_dom.js";

const THUMB_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const MAX_THUMB_BYTES = 256 * 1024 * 1024; // matches backend MAX_UPLOAD_BYTES

function extOf(name) {
  const i = (name || "").lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function renderThumbnailField({ currentUrl = null } = {}) {
  let objectUrl = null;

  const fileInput = el("input", {
    type: "file",
    accept: "image/png,image/jpeg,image/webp,image/gif",
    className: "wv-visually-hidden",
  });

  const zone = el("div", {
    className: "wv-dropzone wv-thumb-dropzone",
    role: "button",
    tabindex: "0",
    "aria-label": "Choose or drop a thumbnail image",
    onclick: () => fileInput.click(),
    onkeydown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    },
  });

  function showPrompt() {
    clear(zone);
    zone.classList.remove("wv-thumb-has-image");
    zone.appendChild(el("i", { className: "pi pi-image wv-dropzone-icon" }));
    zone.appendChild(el("div", { className: "wv-dropzone-text" }, ["Drag an image here, or ", el("span", { className: "wv-dropzone-browse" }, ["browse"])]));
    zone.appendChild(el("div", { className: "wv-dropzone-hint" }, ["PNG · JPG · WebP · GIF"]));
  }

  function showImage(src) {
    clear(zone);
    zone.classList.add("wv-thumb-has-image");
    zone.appendChild(el("img", { src, alt: "Thumbnail preview", className: "wv-thumb-img" }));
    zone.appendChild(el("div", { className: "wv-thumb-change" }, ["Change"]));
  }

  function applyPreview() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    const file = fileInput.files[0];
    if (file) {
      objectUrl = URL.createObjectURL(file);
      showImage(objectUrl);
    } else if (currentUrl) {
      showImage(currentUrl);
    } else {
      showPrompt();
    }
  }
  applyPreview();

  function validate(file) {
    if (!file) return false;
    if (!THUMB_EXTS.includes(extOf(file.name))) {
      showToast(`"${file.name}" isn't a supported image (PNG, JPG, WebP, GIF).`, "error");
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
    applyPreview();
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
  return wrap;
}
