// Vaults: named vault folders (e.g. "Work" and "Personal") the user can switch
// between. Each has its own entries, tags, and settings — switching only
// repoints the app at another folder; nothing is copied, moved, or deleted.
// The UI says "vault"; the code, API routes, and vault_config.json keep the
// original "profile" naming so existing installs need no migration.
// This module owns the sidebar switcher and the Settings → Vaults tab.

import { el, showToast, confirmDialog, promptDialog } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";

export const MAX_PROFILE_NAME_LEN = 60;

export function activeProfile(state) {
  const profiles = state?.profiles || [];
  return profiles.find((p) => p.id === state?.active_profile) || null;
}

// --- Sidebar switcher ------------------------------------------------------

export function renderProfileSwitcher(controller) {
  const { state } = controller;
  const profiles = state.profiles || [];
  const wrap = el("div", { className: "wv-profile-switcher" });

  wrap.appendChild(
    el("div", { className: "wv-sidebar-heading-row" }, [
      el("span", { className: "wv-sidebar-heading", id: "wv-profile-label" }, ["Vault"]),
      el(
        "button",
        {
          className: "wv-icon-btn",
          title: "Manage vaults",
          "aria-label": "Manage vaults",
          onclick: () => controller.openSettings("profiles"),
        },
        [el("i", { className: "pi pi-cog" })]
      ),
    ])
  );

  const select = el(
    "select",
    {
      className: "wv-input wv-profile-select",
      "aria-labelledby": "wv-profile-label",
      title: "Switch vault",
      onchange: (e) => controller.switchProfile(e.target.value),
    },
    profiles.map((p) => el("option", { value: p.id, selected: p.id === state.active_profile, title: p.vault_root }, [p.name]))
  );
  wrap.appendChild(select);
  return wrap;
}

// --- Settings → Profiles tab ----------------------------------------------

function panel(title, icon, hint) {
  const p = el("div", { className: "wv-vs-panel" });
  p.appendChild(el("div", { className: "wv-vs-panel-title" }, [el("i", { className: icon }), el("span", {}, [title])]));
  if (hint) p.appendChild(el("div", { className: "wv-vs-hint" }, [hint]));
  return p;
}

export function renderProfilesSection(controller, { activePanels = [] } = {}) {
  const { state } = controller;
  const profiles = state.profiles || [];
  const section = el("div", { className: "wv-profiles" });

  // --- Existing profiles ---
  const listPanel = panel(
    "Your vaults",
    "pi pi-users",
    "Each vault is its own folder with separate entries, tags, and settings — for example one for work and one for personal projects. These changes apply immediately."
  );
  const list = el("div", { className: "wv-profile-list" });
  for (const p of profiles) {
    const isActive = p.id === state.active_profile;
    const row = el("div", { className: `wv-profile-row${isActive ? " wv-profile-row-active" : ""}` });
    row.appendChild(
      el("div", { className: "wv-profile-info" }, [
        el("div", { className: "wv-profile-name" }, [p.name, ...(isActive ? [el("span", { className: "wv-profile-badge" }, ["Active"])] : [])]),
        el("div", { className: "wv-profile-path wv-mono", title: p.vault_root }, [p.vault_root]),
      ])
    );
    const actions = el("div", { className: "wv-profile-actions" });
    if (!isActive) {
      actions.appendChild(el("button", { className: "wv-btn", onclick: () => controller.switchProfile(p.id) }, ["Switch to"]));
    }
    actions.appendChild(
      el(
        "button",
        {
          className: "wv-icon-btn",
          title: "Rename",
          "aria-label": `Rename vault ${p.name}`,
          onclick: () => renameProfileAction(controller, p),
        },
        [el("i", { className: "pi pi-pencil" })]
      )
    );
    actions.appendChild(
      el(
        "button",
        {
          className: "wv-icon-btn wv-icon-btn-danger",
          title: isActive ? "Switch to another vault to remove this one" : "Remove vault",
          "aria-label": `Remove vault ${p.name}`,
          disabled: isActive,
          onclick: () => removeProfileAction(controller, p),
        },
        [el("i", { className: "pi pi-trash" })]
      )
    );
    row.appendChild(actions);
    list.appendChild(row);
  }
  listPanel.appendChild(list);
  section.appendChild(listPanel);

  // Per-profile settings (folder, accent color) sit right under the list they
  // describe; the settings view builds them because they share its Save flow.
  for (const p of activePanels) section.appendChild(p);

  // --- Add a profile ---
  const addPanel = panel(
    "Add a vault",
    "pi pi-plus",
    "Pick an empty folder to start a fresh vault, or an existing vault folder to reuse it. The new vault becomes active right away."
  );
  const nameInput = el("input", {
    className: "wv-input",
    type: "text",
    placeholder: "Vault name, e.g. Work",
    maxlength: String(MAX_PROFILE_NAME_LEN),
    "aria-label": "Vault name",
  });
  const pathInput = el("input", {
    className: "wv-input wv-mono",
    type: "text",
    placeholder: "Vault folder path, e.g. C:\\Users\\you\\Documents\\Work Vault",
    "aria-label": "Vault folder path",
  });
  const status = el("div", { className: "wv-init-status" });
  const browseBtn = el(
    "button",
    {
      className: "wv-btn",
      title: "Browse for a folder",
      onclick: async () => {
        browseBtn.disabled = true;
        status.textContent = "";
        try {
          const res = await VaultAPI.browseFolder();
          if (res.path) pathInput.value = res.path;
          // res.path === null → the user cancelled the dialog; leave the field.
        } catch {
          // Same fallback as the vault-location picker: the native dialog is
          // absent on some installs (e.g. ComfyUI's portable Windows build).
          status.textContent = "Folder picker isn't available on this ComfyUI install — type or paste the full folder path.";
        } finally {
          browseBtn.disabled = false;
        }
      },
    },
    [el("i", { className: "pi pi-folder-open" }), " Browse…"]
  );
  const addBtn = el("button", { className: "wv-btn wv-btn-primary", onclick: () => submit(false) }, [el("i", { className: "pi pi-plus" }), "Create vault"]);

  async function submit(confirm) {
    const name = nameInput.value.trim();
    const vaultRoot = pathInput.value.trim();
    if (!name) {
      status.textContent = "Give the vault a name.";
      nameInput.focus();
      return;
    }
    if (!vaultRoot) {
      status.textContent = "Choose a folder for the vault.";
      pathInput.focus();
      return;
    }
    if (!(await controller.checkDirty())) return;
    addBtn.disabled = true;
    status.textContent = "";
    try {
      await VaultAPI.createProfile({ name, vault_root: vaultRoot, confirm });
      controller.resetForNewVault();
      await controller.refresh();
      showToast(`Vault “${name}” created and activated.`, "success");
    } catch (e) {
      if (e.status === 409 && e.data?.needs_confirmation) {
        addBtn.disabled = false;
        const ok = await confirmDialog({ title: "Use this folder?", message: e.data.message, confirmText: "Continue" });
        if (ok) await submit(true);
        return;
      }
      status.textContent = e.message;
    } finally {
      addBtn.disabled = false;
    }
  }
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") pathInput.focus();
  });
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit(false);
  });

  addPanel.appendChild(el("div", { className: "wv-profile-add-name" }, [nameInput]));
  addPanel.appendChild(el("div", { className: "wv-vs-location-row" }, [pathInput, browseBtn]));
  addPanel.appendChild(el("div", { className: "wv-profile-add-actions" }, [addBtn]));
  addPanel.appendChild(status);
  section.appendChild(addPanel);

  return section;
}

async function renameProfileAction(controller, profile) {
  const next = await promptDialog({
    title: "Rename vault",
    defaultValue: profile.name,
    placeholder: "Vault name",
    confirmText: "Rename",
  });
  if (next == null) return;
  const name = next.trim();
  if (!name || name === profile.name) return;
  try {
    await VaultAPI.renameProfile(profile.id, name);
    await controller.refresh();
    showToast("Vault renamed.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function removeProfileAction(controller, profile) {
  const ok = await confirmDialog({
    title: `Remove “${profile.name}”?`,
    message:
      "This only removes the vault from the list. Its folder and everything in it stay on disk, " +
      "and you can add the folder back later as a new vault.\n\n" +
      profile.vault_root,
    confirmText: "Remove vault",
    danger: true,
  });
  if (!ok) return;
  try {
    await VaultAPI.deleteProfile(profile.id);
    await controller.refresh();
    showToast(`Vault “${profile.name}” removed.`, "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}
