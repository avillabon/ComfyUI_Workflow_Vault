// Small DOM helpers, toasts, and a reusable confirm dialog used throughout
// the Workflow Vault UI.

import { app } from "../../scripts/app.js";

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
