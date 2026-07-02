// Workflow Vault extension entry point: registers the extension with
// ComfyUI, injects styles, and adds two sidebar tabs (Open Vault / Save
// Workflow) that launch in a single click.

import { app } from "../../scripts/app.js";
import { el, clear, applyAccentColor } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { vaultApp } from "./vault_app.js";
import { VAULT_VERSION } from "./vault_modal.js";

function injectStylesheet() {
  if (document.getElementById("wv-styles")) return;
  const link = document.createElement("link");
  link.id = "wv-styles";
  link.rel = "stylesheet";
  // Version param busts stale browser caches after an update (Edge in
  // particular has served old CSS across extension updates).
  link.href = new URL(`./workflow_vault.css?v=${VAULT_VERSION}`, import.meta.url).href;
  document.head.appendChild(link);
}

function openVault() {
  vaultApp.open();
}

// Save always lands in the wizard, whose Create / Update toggle is the
// "create a new entry vs. save over an existing one" choice — so a save is
// never silent.
function openSaveWizard() {
  vaultApp.open({ openWizard: true, wizardOptions: { mode: "full" } });
}

// Clicking a sidebar icon expands its panel. We don't want a panel — just the
// overlay — so collapse the sidebar again right after launching.
function collapseSidebar() {
  try {
    const sb = app.extensionManager?.sidebarTab;
    if (sb && sb.activeSidebarTabId) sb.toggleSidebarTab(sb.activeSidebarTabId);
  } catch {
    // Store shape varies by version; the fallback panel button still works.
  }
}

// A sidebar tab's render() runs both when the user clicks its icon and when
// ComfyUI restores the active tab on page load. A real click carries
// transient user activation; the page-load restore does not. We use that to
// launch on click only, and otherwise leave a one-click button behind (shown
// e.g. after the overlay is closed while the tab is still expanded).
function makeLauncherRender({ action, icon, label, hint }) {
  return (container) => {
    if (navigator.userActivation ? navigator.userActivation.isActive : true) {
      action();
      setTimeout(collapseSidebar, 0);
    }
    clear(container);
    const panel = el("div", { className: "wv-sidebar-panel" });
    panel.appendChild(
      el("button", { type: "button", className: "wv-sidebar-action", onclick: action }, [
        el("i", { className: icon }),
        el("span", {}, [label]),
      ])
    );
    if (hint) panel.appendChild(el("p", { className: "wv-sidebar-hint" }, [hint]));
    container.appendChild(panel);
  };
}

app.registerExtension({
  name: "Comfy.WorkflowVault",
  setup() {
    injectStylesheet();

    // Tint the rail buttons with the saved accent color on startup, before the
    // vault is ever opened. Best-effort: a missing/unconfigured vault just
    // leaves the default accent in place.
    VaultAPI.getState()
      .then((s) => applyAccentColor(s?.settings?.accent_color))
      .catch(() => {});

    // Registered Save first, then Vault, and with ascending `order` values so
    // they sink to the bottom of the rail: Save above Vault, Vault last.
    app.extensionManager.registerSidebarTab({
      id: "workflow-vault-save",
      icon: "pi pi-save",
      title: "Save",
      tooltip: "Save current workflow to the vault",
      type: "custom",
      order: 1000,
      render: makeLauncherRender({
        action: openSaveWizard,
        icon: "pi pi-save",
        label: "Save Workflow",
        hint: "Choose to update an existing entry or create a new one.",
      }),
    });

    app.extensionManager.registerSidebarTab({
      id: "workflow-vault",
      icon: "pi pi-folder-open",
      title: "Vault",
      tooltip: "Open Workflow Vault",
      type: "custom",
      order: 1001,
      render: makeLauncherRender({
        action: openVault,
        icon: "pi pi-folder-open",
        label: "Open Vault",
        hint: "Browse, organize, and open your saved workflows.",
      }),
    });
  },
});
