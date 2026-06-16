// Top-level controller for the Workflow Vault modal: owns state, view
// routing, and the unsaved-changes guard. Views render themselves via
// controller.render() and call back into controller methods for navigation.

import { VaultAPI } from "./vault_api.js";
import { el, clear, confirmDialog, showToast, applyAccentColor } from "./vault_dom.js";
import { renderLoading, renderInitView, renderTopbar, renderGridBody } from "./vault_modal.js";
import { renderDetailView } from "./vault_detail.js";
import { renderWizard } from "./vault_wizard.js";
import { renderGlobalSettings } from "./vault_global_settings.js";

export class VaultApp {
  constructor() {
    this.overlay = null;
    this.state = null;
    this.view = "grid"; // grid | detail | wizard | settings
    this.selectedEntryId = null;
    this.selectedTab = "overview";
    this.settingsSection = "info"; // sub-section within the Settings tab
    this.filters = { search: "", folderId: undefined, status: null, favoritesOnly: false, showArchived: undefined, generationType: null };
    this.isDirty = false;
    this.wizardOptions = null;
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  async open(options = {}) {
    if (!this.overlay) {
      this.overlay = el("div", { className: "wv-overlay wv-overlay-main" });
      this.overlay.addEventListener("mousedown", (e) => {
        if (e.target === this.overlay) this.requestClose();
      });
      document.addEventListener("keydown", this._onKeyDown);
      document.body.appendChild(this.overlay);
    }
    this.render();
    await this.loadState();
    if (options.openWizard) {
      this.wizardOptions = options.wizardOptions || {};
      this.view = "wizard";
    }
    this.render();
  }

  _onKeyDown(e) {
    if (document.querySelector(".wv-overlay-dialog")) return;
    if (e.key === "Escape") {
      this.requestClose();
      return;
    }
  }

  async requestClose() {
    const proceed = await this.checkDirty();
    if (!proceed) return;
    this.close();
  }

  close() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    document.removeEventListener("keydown", this._onKeyDown);
    this.view = "grid";
    this.selectedEntryId = null;
    this.selectedTab = "overview";
    this.settingsSection = "info";
    this.isDirty = false;
    this.wizardOptions = null;
  }

  async loadState() {
    try {
      this.state = await VaultAPI.getState();
      applyAccentColor(this.state.settings?.accent_color);
      if (this.state.initialized && this.filters.showArchived === undefined) {
        this.filters.showArchived = !!this.state.settings?.show_archived;
      }
    } catch (e) {
      showToast(e.message, "error");
      this.state = {
        initialized: false,
        vault_root: null,
        settings: {},
        folders: [],
        entries: [],
        tags: [],
      };
    }
  }

  async refresh() {
    await this.loadState();
    if (this.selectedEntryId && !this.getEntry(this.selectedEntryId)) {
      this.selectedEntryId = null;
      this.view = "grid";
    }
    this.render();
  }

  getEntry(entryId) {
    return (this.state?.entries || []).find((e) => e.id === entryId) || null;
  }

  async checkDirty() {
    if (!this.isDirty) return true;
    const ok = await confirmDialog({
      title: "Discard unsaved changes?",
      message: "You have unsaved changes that will be lost if you continue.",
      confirmText: "Discard changes",
      danger: true,
    });
    if (ok) this.isDirty = false;
    return ok;
  }

  setDirty(value) {
    this.isDirty = value;
  }

  async setView(view) {
    if (this.view === view) return;
    const proceed = await this.checkDirty();
    if (!proceed) return;
    this.view = view;
    this.render();
  }

  async openEntry(entryId, tab = "overview") {
    if (this.view === "detail" && this.selectedEntryId === entryId) {
      this.selectedTab = tab;
      this.render();
      return;
    }
    const proceed = await this.checkDirty();
    if (!proceed) return;
    this.selectedEntryId = entryId;
    this.selectedTab = tab;
    this.settingsSection = "info";
    this.view = "detail";
    this.render();
  }

  async setTab(tab) {
    if (this.selectedTab === tab) return;
    const proceed = await this.checkDirty();
    if (!proceed) return;
    this.selectedTab = tab;
    this.render();
  }

  async backToGrid() {
    const proceed = await this.checkDirty();
    if (!proceed) return;
    this.view = "grid";
    this.selectedEntryId = null;
    this.render();
  }

  async openWizard(options = {}) {
    const proceed = await this.checkDirty();
    if (!proceed) return;
    this.wizardOptions = options;
    this.view = "wizard";
    this.render();
  }

  async openSettings() {
    const proceed = await this.checkDirty();
    if (!proceed) return;
    this.view = "settings";
    this.render();
  }

  render() {
    if (!this.overlay) return;

    const active = document.activeElement;
    let restoreFocus = null;
    if (active && active.classList && active.classList.contains("wv-search") && this.overlay.contains(active)) {
      restoreFocus = { selStart: active.selectionStart, selEnd: active.selectionEnd };
    }

    clear(this.overlay);
    const modal = el("div", { className: "wv-modal" });

    if (!this.state) {
      modal.appendChild(renderLoading());
    } else if (!this.state.initialized) {
      modal.appendChild(renderInitView(this));
    } else if (this.view === "detail" && this.getEntry(this.selectedEntryId)) {
      modal.appendChild(renderDetailView(this));
    } else if (this.view === "wizard") {
      modal.appendChild(renderWizard(this));
    } else if (this.view === "settings") {
      modal.appendChild(renderGlobalSettings(this));
    } else {
      modal.appendChild(renderTopbar(this));
      modal.appendChild(renderGridBody(this));
    }

    this.overlay.appendChild(modal);

    if (restoreFocus) {
      const input = this.overlay.querySelector(".wv-search");
      if (input) {
        input.focus();
        try {
          input.setSelectionRange(restoreFocus.selStart, restoreFocus.selEnd);
        } catch {
          // ignore
        }
      }
    }
  }
}

export const vaultApp = new VaultApp();
