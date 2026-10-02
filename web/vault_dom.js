// Small DOM helpers, toasts, and a reusable confirm dialog used throughout
// the Workflow Vault UI.

import { app } from "../../scripts/app.js";
import { VaultAPI } from "./vault_api.js";

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "className") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child
    );
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// --- Video that fails visibly ---------------------------------------------
// A <video> can fail to play for two quite different reasons, and they need
// different answers:
//
// "codec" — the browser decoded nothing because it doesn't support the format.
//   Firefox is the usual case: it plays H.265/HEVC only via a hardware decoder
//   and has no software fallback, so ComfyUI's HEVC outputs play in Chrome and
//   show nothing in Firefox. The element fires `error` with
//   MEDIA_ERR_SRC_NOT_SUPPORTED. This one is fixable — we offer to re-encode a
//   browser-safe H.264 copy alongside the original.
//
// "stall" — the bytes arrive and the format is fine, but decoding never starts.
//   Typically Firefox on a box with a virtual display adapter (Parsec,
//   Sunshine, RDP, a VM), where hardware decoding lands on an adapter with no
//   decoder and software decoding doesn't take over. The tell is that NO event
//   fires at all: the element sits at readyState 0 forever showing empty
//   controls. Converting wouldn't help; the pref does.
//
// Either way every <video> on the page fails at once, so each element degrades
// on its own but the explanation is only shown once per session.

const VIDEO_STALL_MS = 10000; // vault media comes off localhost; 10s is generous
export const VIDEO_DECODE_HINT =
  "Videos aren't playing in this browser. If it's Firefox, open about:config, set " +
  "media.hardware-video-decoding.enabled to false, and restart it. This usually happens " +
  "on machines with a virtual display adapter (Parsec, Sunshine, RDP, or a VM).";
export const VIDEO_CODEC_HINT =
  "This browser can't decode this video's format — usually H.265/HEVC, which Firefox " +
  "plays only with a hardware decoder. Save an H.264 copy to get a browser-safe version; " +
  "the original file is left untouched alongside it.";

const hintShown = { codec: false, stall: false };

export function noteVideoDecodeFailure(reason = "stall") {
  if (hintShown[reason]) return;
  hintShown[reason] = true;
  showToast(reason === "codec" ? VIDEO_CODEC_HINT : VIDEO_DECODE_HINT, "error", 15000);
}

// The browser is the authority on what it can decode, so the failure event
// itself decides which of the two cases we're in — no server-side probing.
function failureReason(video) {
  return video.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? "codec" : "stall";
}

// "copy" is load-bearing: this adds a file rather than replacing one, and the
// button is the only thing guaranteed to be on screen when the user decides.
const CONVERT_LABEL = "Save an H.264 copy";

function convertButton(convert) {
  const label = el("span", {}, [CONVERT_LABEL]);
  const icon = el("i", { className: "pi pi-sync" });
  const btn = el("button", {
    type: "button",
    className: "wv-video-convert-btn",
    title: "Re-encode a browser-safe H.264 copy. The original file is kept, untouched, alongside it.",
  }, [icon, label]);

  btn.addEventListener("click", async (e) => {
    // These boxes sit inside clickable carousel/filmstrip cells.
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    icon.className = "pi pi-spin pi-spinner";
    label.textContent = "Converting…";
    try {
      const res = await VaultAPI.convertMedia(convert.entryId, convert.file);
      const saved = res.bytes_before && res.bytes_after
        ? ` (${formatBytes(res.bytes_before)} → ${formatBytes(res.bytes_after)})`
        : "";
      showToast(`Converted ${(res.codec || "video").toUpperCase()} to H.264${saved}. The original was kept.`, "success", 8000);
      await convert.onConverted?.(res.path);
    } catch (err) {
      showToast(err.message, "error", 10000);
      btn.disabled = false;
      icon.className = "pi pi-sync";
      label.textContent = CONVERT_LABEL;
    }
  });
  return btn;
}

function replaceWithFallback(video, compact, roomy, reason, convert) {
  if (!video.parentNode) return;
  const hint = reason === "codec" ? VIDEO_CODEC_HINT : VIDEO_DECODE_HINT;
  const children = [el("i", { className: "pi pi-exclamation-triangle" })];
  if (!compact) children.push(el("span", {}, ["Can't play this video"]));
  // Keep the original classes so the surrounding layout still sizes the box.
  const box = el("div", { className: `wv-video-failed ${video.className}`.trim(), title: hint }, children);
  // Only where there's room to render it, and only when converting would help.
  if (!compact && reason === "codec" && convert?.entryId && convert?.file) {
    box.appendChild(convertButton(convert));
    // These boxes inherit the size of the <video> they replace, anywhere from a
    // full-width carousel down to a 136px grid square, so only the caller knows
    // whether a second line fits. Everywhere else the button's own "copy"
    // carries the meaning, with the full wording in its tooltip.
    if (roomy) {
      box.appendChild(el("span", { className: "wv-video-failed-note" }, ["Your original file is kept"]));
    }
  }
  video.replaceWith(box);
}

/**
 * Creates a <video> that degrades visibly instead of silently. On a decode
 * error — or a load that never yields any data — the element is swapped for a
 * small "can't play" box and the fix is explained once per session.
 * Options: `onFail(video, reason)` takes over the failure handling (nothing is
 * swapped); `compact` drops the caption and convert button, for thumbnail-sized
 * boxes; `convert` is {entryId, file, onConverted} enabling the H.264 offer;
 * `roomy` says the box is big enough for the "original is kept" line under the
 * convert button.
 */
export function videoEl(props = {}, { onFail = null, compact = false, roomy = false, convert = null } = {}) {
  const video = el("video", props);
  let settled = false;
  let timer = null;
  const settle = (failed) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!failed) return;
    const reason = failureReason(video);
    noteVideoDecodeFailure(reason);
    if (onFail) onFail(video, reason);
    else replaceWithFallback(video, compact, roomy, reason, convert);
  };
  video.addEventListener("error", () => settle(true));
  // Any of these may be the first to fire depending on codec and browser.
  for (const ev of ["loadedmetadata", "loadeddata", "canplay"]) {
    video.addEventListener(ev, () => settle(false));
  }
  // Nothing fired either way: nothing decoded by now means it never will.
  timer = setTimeout(() => settle(video.readyState === 0), VIDEO_STALL_MS);
  return video;
}

// Apply the user's accent color globally (on <html>) so it reaches both the
// vault modal AND the sidebar rail buttons, which render outside the modal in
// ComfyUI's own sidebar. Invalid/empty values are ignored, leaving the default.
export function applyAccentColor(color) {
  const c = String(color || "").trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) {
    document.documentElement.style.setProperty("--wv-accent", c);
  }
}

// A labeled toggle switch. Returns the <label> element with `.input` exposed.
export function toggleField(labelText, checked, onChange) {
  const input = el("input", { type: "checkbox", className: "wv-switch-input", checked });
  input.addEventListener("change", () => onChange(input.checked));
  const field = el("label", { className: "wv-toggle-field" }, [
    el("span", { className: "wv-toggle-label" }, [labelText]),
    el("span", { className: "wv-switch" }, [input, el("span", { className: "wv-switch-slider" })]),
  ]);
  field.input = input;
  return field;
}

// Keydown handler that activates a non-button element (role="button") on
// Enter/Space, ignoring events that bubbled up from focusable children.
export function onActivate(handler) {
  return (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      handler(e);
    }
  };
}

export function formatBytes(n) {
  n = Math.max(0, n || 0);
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

export function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function formatDateOnly(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function severityTitle(severity) {
  return { success: "Success", error: "Error", warn: "Warning", info: "Info" }[severity] || "Notice";
}

export function showToast(message, severity = "info", life = 4000) {
  try {
    if (app?.extensionManager?.toast?.add) {
      app.extensionManager.toast.add({ severity, summary: severityTitle(severity), detail: message, life });
      return;
    }
  } catch {
    // fall through to DOM toast
  }
  const toast = el("div", { className: `wv-toast wv-toast-${severity}` }, [message]);
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("wv-toast-show"));
  setTimeout(() => {
    toast.classList.remove("wv-toast-show");
    setTimeout(() => toast.remove(), 300);
  }, life);
}

export function createProgressStatus() {
  const label = el("span", { className: "wv-progress-label" });
  const fill = el("span", { className: "wv-progress-fill" });
  const bar = el("span", { className: "wv-progress-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, [fill]);
  const root = el("div", { className: "wv-progress", style: { display: "none" } }, [label, bar]);

  function set(percent, text) {
    root.style.display = "";
    root.classList.remove("wv-progress-indeterminate");
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    fill.style.transform = `scaleX(${value / 100})`;
    bar.setAttribute("aria-valuenow", String(Math.round(value)));
    label.textContent = text;
  }

  return {
    element: root,
    update(event) {
      if (event?.phase === "processing") {
        root.style.display = "";
        root.classList.add("wv-progress-indeterminate");
        fill.style.transform = "scaleX(0.45)";
        bar.removeAttribute("aria-valuenow");
        label.textContent = "Processing media…";
      } else {
        set(event?.percent ?? 0, event?.phase === "starting" ? "Preparing upload…" : `Uploading… ${event?.percent ?? 0}%`);
      }
    },
    reset() {
      root.style.display = "none";
      root.classList.remove("wv-progress-indeterminate");
      fill.style.transform = "scaleX(0)";
      label.textContent = "";
      bar.removeAttribute("aria-valuenow");
    },
  };
}

/**
 * Shows a confirm dialog and resolves true/false depending on the user's
 * choice. Always resolves false if dismissed (Escape, backdrop click).
 */
export function confirmDialog({ title = "Confirm", message = "", confirmText = "Continue", cancelText = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { className: "wv-overlay wv-overlay-dialog" });
    const body = el("div", { className: "wv-dialog-body" });
    String(message).split("\n").forEach((line) => {
      body.appendChild(el("p", {}, [line || " "]));
    });

    const cleanup = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
    };

    const confirmBtn = el(
      "button",
      { className: danger ? "wv-btn wv-btn-danger" : "wv-btn wv-btn-primary", onclick: () => cleanup(true) },
      [confirmText]
    );
    const footerChildren = [];
    if (cancelText) {
      footerChildren.push(el("button", { className: "wv-btn", onclick: () => cleanup(false) }, [cancelText]));
    }
    footerChildren.push(confirmBtn);

    const box = el("div", { className: "wv-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("div", { className: "wv-dialog-title" }, [title]),
      body,
      el("div", { className: "wv-dialog-footer" }, footerChildren),
    ]);

    overlay.appendChild(box);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) cleanup(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}

export function saveDiscardCancelDialog({ title = "Save changes?", message = "", saveText = "Save", discardText = "Discard changes" } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { className: "wv-overlay wv-overlay-dialog" });
    const body = el("div", { className: "wv-dialog-body" });
    String(message).split("\n").forEach((line) => {
      body.appendChild(el("p", {}, [line || " "]));
    });

    const cleanup = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup("cancel");
    };

    const saveBtn = el("button", { className: "wv-btn wv-btn-primary", onclick: () => cleanup("save") }, [saveText]);
    const box = el("div", { className: "wv-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("div", { className: "wv-dialog-title" }, [title]),
      body,
      el("div", { className: "wv-dialog-footer" }, [
        el("button", { className: "wv-btn", onclick: () => cleanup("cancel") }, ["Cancel"]),
        el("button", { className: "wv-btn wv-btn-danger", onclick: () => cleanup("discard") }, [discardText]),
        saveBtn,
      ]),
    ]);

    overlay.appendChild(box);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) cleanup("cancel");
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    saveBtn.focus();
  });
}

/** Shows a full-size image in a dismissible overlay (click backdrop, ×, or Escape to close). */
export function openImageLightbox(src, alt = "") {
  const overlay = el("div", { className: "wv-overlay wv-overlay-dialog wv-lightbox-overlay" });
  const img = el("img", { src, alt, className: "wv-lightbox-img" });

  const cleanup = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") cleanup();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) cleanup();
  });

  overlay.appendChild(img);
  overlay.appendChild(el("button", { className: "wv-icon-btn wv-icon-btn-lg wv-lightbox-close", title: "Close", onclick: cleanup }, [el("i", { className: "pi pi-times" })]));

  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

/** Single text-input dialog. Resolves the entered string, or null if cancelled. */
export function promptDialog({ title = "Enter a value", message = "", defaultValue = "", placeholder = "", confirmText = "OK" } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { className: "wv-overlay wv-overlay-dialog" });
    const input = el("input", { className: "wv-input", type: "text", value: defaultValue, placeholder });

    const cleanup = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(null);
      if (e.key === "Enter") cleanup(input.value);
    };

    const body = el("div", { className: "wv-dialog-body" }, [
      ...(message ? [el("p", {}, [message])] : []),
      input,
    ]);
    const box = el("div", { className: "wv-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("div", { className: "wv-dialog-title" }, [title]),
      body,
      el("div", { className: "wv-dialog-footer" }, [
        el("button", { className: "wv-btn", onclick: () => cleanup(null) }, ["Cancel"]),
        el("button", { className: "wv-btn wv-btn-primary", onclick: () => cleanup(input.value) }, [confirmText]),
      ]),
    ]);

    overlay.appendChild(box);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

/**
 * Renders a small form dialog. fields: [{name, label, type, value, options,
 * placeholder}] where type is "text" | "textarea" | "select" | "checkbox".
 * Resolves an object of values keyed by field name, or null if cancelled.
 */
export function formDialog({ title = "Edit", message = "", fields = [], confirmText = "Save" } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { className: "wv-overlay wv-overlay-dialog" });
    const body = el("div", { className: "wv-dialog-body" });
    if (message) body.appendChild(el("p", {}, [message]));

    const inputs = {};
    for (const f of fields) {
      const row = el("div", { className: "wv-form-row" });
      if (f.label) row.appendChild(el("label", {}, [f.label]));
      let input;
      if (f.type === "select") {
        input = el(
          "select",
          { className: "wv-input" },
          (f.options || []).map((o) => el("option", { value: o.value, selected: o.value === f.value }, [o.label]))
        );
      } else if (f.type === "textarea") {
        input = el("textarea", { className: "wv-input wv-textarea", placeholder: f.placeholder || "" });
        input.value = f.value || "";
      } else if (f.type === "checkbox") {
        input = el("input", { type: "checkbox", checked: !!f.value });
      } else {
        input = el("input", { className: "wv-input", type: "text", value: f.value || "", placeholder: f.placeholder || "" });
      }
      inputs[f.name] = input;
      row.appendChild(input);
      body.appendChild(row);
    }

    const cleanup = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(null);
    };

    const okBtn = el(
      "button",
      {
        className: "wv-btn wv-btn-primary",
        onclick: () => {
          const values = {};
          for (const f of fields) {
            const input = inputs[f.name];
            values[f.name] = f.type === "checkbox" ? input.checked : input.value;
          }
          cleanup(values);
        },
      },
      [confirmText]
    );

    const box = el("div", { className: "wv-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("div", { className: "wv-dialog-title" }, [title]),
      body,
      el("div", { className: "wv-dialog-footer" }, [
        el("button", { className: "wv-btn", onclick: () => cleanup(null) }, ["Cancel"]),
        okBtn,
      ]),
    ]);

    overlay.appendChild(box);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    const first = fields[0] && inputs[fields[0].name];
    if (first && first.focus) setTimeout(() => first.focus(), 0);
  });
}

/**
 * A small popover menu anchored under a button. items: [{label, icon, danger,
 * onSelect}] (or {divider: true}). Closes on outside click, Escape (without
 * closing the vault behind it), Tab, or after an item is chosen. Arrow keys,
 * Home and End move between items. `container` is where the menu is mounted;
 * mounting inside the vault overlay keeps it within the focus trap.
 */
export function openMenu(anchor, items, { container = document.body, align = "right" } = {}) {
  closeMenu();
  const menu = el("div", { className: "wv-menu", role: "menu" });
  const buttons = [];
  for (const item of items) {
    if (item.divider) {
      menu.appendChild(el("div", { className: "wv-menu-divider", role: "separator" }));
      continue;
    }
    const btn = el(
      "button",
      {
        type: "button",
        role: "menuitem",
        className: `wv-menu-item${item.danger ? " wv-menu-item-danger" : ""}`,
        onclick: () => {
          closeMenu();
          item.onSelect?.();
        },
      },
      [item.icon ? el("i", { className: item.icon }) : null, el("span", {}, [item.label])]
    );
    buttons.push(btn);
    menu.appendChild(btn);
  }
  container.appendChild(menu);

  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const left = align === "right" ? a.right - m.width : a.left;
  menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - m.width - 8))}px`;
  menu.style.top = `${Math.min(a.bottom + 6, window.innerHeight - m.height - 8)}px`;
  anchor.setAttribute("aria-expanded", "true");

  const onKey = (e) => {
    if (e.key === "Escape" || e.key === "Tab") {
      // Capture phase + stopPropagation: Escape must close only the menu, not
      // the vault (whose own handler listens on the same document).
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
      closeMenu();
      anchor.focus?.();
      return;
    }
    const at = buttons.indexOf(document.activeElement);
    let next = null;
    if (e.key === "ArrowDown") next = buttons[(at + 1) % buttons.length];
    else if (e.key === "ArrowUp") next = buttons[(at - 1 + buttons.length) % buttons.length];
    else if (e.key === "Home") next = buttons[0];
    else if (e.key === "End") next = buttons[buttons.length - 1];
    if (next) {
      e.preventDefault();
      e.stopPropagation();
      next.focus();
    }
  };
  const onDown = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  openMenuState = {
    close() {
      menu.remove();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      anchor.setAttribute("aria-expanded", "false");
    },
  };
  buttons[0]?.focus();
  return menu;
}

let openMenuState = null;

export function closeMenu() {
  if (openMenuState) {
    openMenuState.close();
    openMenuState = null;
  }
}
