// Keyboard shortcuts: the list shown in the help dialog, plus the small helpers
// the app's key handler uses. The actual key handling lives in VaultApp.

import { el } from "./vault_dom.js";

// [keys, what it does, where it applies]. Keys are shown as separate keycaps.
export const SHORTCUTS = [
  { group: "Anywhere", items: [
    [["?"], "Show this list"],
    [["Esc"], "Close the vault (or a dialog or menu)"],
  ] },
  { group: "Browsing the grid", items: [
    [["/"], "Search"],
    [["←", "→", "↑", "↓"], "Move between workflows"],
    [["Home", "End"], "First / last workflow"],
    [["Enter"], "Open the focused workflow's details"],
    [["O"], "Open the focused workflow in ComfyUI"],
    [["N"], "New entry from the current canvas"],
  ] },
  { group: "Inside a workflow", items: [
    [["←", "→"], "Switch tabs (with a tab focused)"],
  ] },
];

// True when the event came from somewhere the user is typing, where single-key
// shortcuts must be left alone.
export function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function showShortcutsDialog() {
  return new Promise((resolve) => {
    const overlay = el("div", { className: "wv-overlay wv-overlay-dialog" });
    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve();
    };
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        close();
      }
    };

    const body = el("div", { className: "wv-dialog-body wv-shortcuts" });
    for (const { group, items } of SHORTCUTS) {
      body.appendChild(el("div", { className: "wv-shortcuts-group" }, [group]));
      for (const [keys, description] of items) {
        body.appendChild(
          el("div", { className: "wv-shortcuts-row" }, [
            el("span", { className: "wv-shortcuts-keys" }, keys.map((k) => el("kbd", { className: "wv-kbd" }, [k]))),
            el("span", {}, [description]),
          ])
        );
      }
    }
    body.appendChild(
      el("p", { className: "wv-muted wv-shortcuts-note" }, ["Single-key shortcuts are ignored while you're typing in a field."])
    );

    const box = el("div", { className: "wv-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Keyboard shortcuts" }, [
      el("div", { className: "wv-dialog-title" }, ["Keyboard shortcuts"]),
      body,
      el("div", { className: "wv-dialog-footer" }, [el("button", { className: "wv-btn wv-btn-primary", onclick: close }, ["Done"])]),
    ]);
    overlay.appendChild(box);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    setTimeout(() => box.querySelector(".wv-btn")?.focus(), 0);
  });
}
