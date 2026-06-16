// Vault-wide settings: stats, vault location, defaults, and tag management,
// laid out as a constrained column of panels.

import { el, showToast, confirmDialog, promptDialog } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { STATUS_LABELS, STATUS_ORDER } from "./vault_modal.js";

function panel(title, icon, hint) {
  const p = el("div", { className: "wv-vs-panel" });
  p.appendChild(el("div", { className: "wv-vs-panel-title" }, [el("i", { className: icon }), el("span", {}, [title])]));
  if (hint) p.appendChild(el("div", { className: "wv-vs-hint" }, [hint]));
  return p;
}

function settingRow(label, control) {
  return el("div", { className: "wv-vs-row" }, [el("span", { className: "wv-vs-row-label" }, [label]), control]);
}

function switchEl(checked) {
  const input = el("input", { type: "checkbox", className: "wv-switch-input", checked });
  const label = el("label", { className: "wv-switch" }, [input, el("span", { className: "wv-switch-slider" })]);
  label.input = input;
  return label;
}

export function renderGlobalSettings(controller) {
  const { state } = controller;
  const wrap = el("div", { className: "wv-settings-view" });

  const header = el("div", { className: "wv-detail-header" });
  header.appendChild(
    el("button", { className: "wv-icon-btn wv-icon-btn-lg", title: "Back to vault", "aria-label": "Back to vault", onclick: () => controller.setView("grid") }, [el("i", { className: "pi pi-arrow-left" })])
  );
  header.appendChild(el("div", { className: "wv-detail-title-area" }, [el("div", { className: "wv-detail-title" }, ["Vault Settings"])]));
  header.appendChild(el("div", { className: "wv-topbar-spacer" }));
  header.appendChild(el("button", { className: "wv-icon-btn wv-icon-btn-lg", title: "Close", "aria-label": "Close", onclick: () => controller.requestClose() }, [el("i", { className: "pi pi-times" })]));
  wrap.appendChild(header);

  const body = el("div", { className: "wv-settings-body wv-settings-body-narrow" });

  // --- Stats chips ---
  const statGrid = el("div", { className: "wv-vs-stats" });
  const stat = (label, value) =>
    el("div", { className: "wv-vs-stat" }, [el("div", { className: "wv-vs-stat-label" }, [label]), el("div", { className: "wv-vs-stat-value" }, [value])]);
  statGrid.appendChild(stat("Entries", String((state.entries || []).length)));
  statGrid.appendChild(stat("Folders", String((state.folders || []).length)));
  statGrid.appendChild(stat("Tags", String((state.tags || []).length)));
  body.appendChild(statGrid);

  // --- Vault location ---
  const locationInput = el("input", { className: "wv-input wv-mono", type: "text", placeholder: "New vault folder path", value: state.vault_root || "" });
  const locationStatus = el("div", { className: "wv-init-status" });
  const changeBtn = el("button", { className: "wv-btn", onclick: () => changeVaultRoot(locationInput.value, false) }, ["Change…"]);

  async function changeVaultRoot(path, confirm) {
    const trimmed = (path || "").trim();
    if (!trimmed) {
      locationStatus.textContent = "Please enter a folder path.";
      return;
    }
    changeBtn.disabled = true;
    locationStatus.textContent = "";
    try {
      await VaultAPI.postSettings({ vault_root: trimmed, confirm });
      await controller.refresh();
      showToast("Vault location updated.", "success");
    } catch (e) {
      if (e.status === 409 && e.data?.needs_confirmation) {
        changeBtn.disabled = false;
        const ok = await confirmDialog({ title: "Change Vault Location?", message: e.data.message, confirmText: "Continue" });
        if (ok) await changeVaultRoot(trimmed, true);
        return;
      }
      locationStatus.textContent = e.message;
    } finally {
      changeBtn.disabled = false;
    }
  }

  const locPanel = panel("Vault location", "pi pi-folder", "Where entries and media are stored on disk.");
  locPanel.appendChild(el("div", { className: "wv-vs-location-row" }, [locationInput, changeBtn]));
  locPanel.appendChild(locationStatus);
  body.appendChild(locPanel);

  // --- Defaults ---
  const showArchivedSwitch = switchEl(!!state.settings?.show_archived);
  const defaultStatusSelect = el(
    "select",
    { className: "wv-input wv-vs-select" },
    STATUS_ORDER.filter((s) => s !== "archived").map((s) => el("option", { value: s, selected: state.settings?.default_status === s }, [STATUS_LABELS[s]]))
  );
  const thumbBehaviorSelect = el(
    "select",
    { className: "wv-input wv-vs-select" },
    [
      { value: "placeholder", label: "Show placeholder icon" },
      { value: "blank", label: "Leave blank" },
    ].map((o) => el("option", { value: o.value, selected: state.settings?.default_thumbnail_behavior === o.value }, [o.label]))
  );

  const defPanel = panel("Defaults", "pi pi-sliders-h", null);
  defPanel.appendChild(settingRow("Show archived entries by default", showArchivedSwitch));
  defPanel.appendChild(settingRow("Default status for new entries", defaultStatusSelect));
  defPanel.appendChild(settingRow("When an entry has no thumbnail", thumbBehaviorSelect));
  body.appendChild(defPanel);

  // --- Tags ---
  const tags = state.tags || [];
  const tagPanel = panel("Tags", "pi pi-tags", "Rename, merge (rename to an existing tag), or delete tags across all entries.");
  if (!tags.length) {
    tagPanel.appendChild(el("p", { className: "wv-muted" }, ["No tags yet."]));
  } else {
    const counts = {};
    for (const e of state.entries || []) {
      for (const t of e.tags || []) counts[t] = (counts[t] || 0) + 1;
    }
    const listEl = el("div", { className: "wv-tag-manager" });
    for (const tag of tags) {
      listEl.appendChild(
        el("div", { className: "wv-tag-manager-row" }, [
          el("span", { className: "wv-tag-manager-name" }, [tag]),
          el("span", { className: "wv-tag-manager-count" }, [`${counts[tag] || 0}`]),
          el("button", { className: "wv-icon-btn", title: "Rename or merge", "aria-label": `Rename or merge tag ${tag}`, onclick: () => renameTagAction(controller, tag) }, [el("i", { className: "pi pi-pencil" })]),
          el("button", { className: "wv-icon-btn wv-icon-btn-danger", title: "Delete", "aria-label": `Delete tag ${tag}`, onclick: () => deleteTagAction(controller, tag) }, [el("i", { className: "pi pi-trash" })]),
        ])
      );
    }
    tagPanel.appendChild(listEl);
  }
  body.appendChild(tagPanel);

  // --- Footer: save defaults ---
  const settingsStatus = el("span", { className: "wv-vs-footer-status" });
  const saveBtn = el(
    "button",
    {
      className: "wv-btn wv-btn-primary",
      onclick: async () => {
        saveBtn.disabled = true;
        settingsStatus.textContent = "";
        try {
          await VaultAPI.postSettings({
            show_archived: showArchivedSwitch.input.checked,
            default_status: defaultStatusSelect.value,
            default_thumbnail_behavior: thumbBehaviorSelect.value,
          });
          controller.filters.showArchived = showArchivedSwitch.input.checked;
          await controller.refresh();
          showToast("Settings saved.", "success");
        } catch (e) {
          settingsStatus.textContent = e.message;
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    [el("i", { className: "pi pi-save" }), "Save settings"]
  );
  body.appendChild(el("div", { className: "wv-vs-footer" }, [settingsStatus, saveBtn]));

  wrap.appendChild(body);
  return wrap;
}

async function renameTagAction(controller, tag) {
  const next = await promptDialog({
    title: "Rename or merge tag",
    message: `Rename "${tag}". Enter an existing tag name to merge them.`,
    defaultValue: tag,
    confirmText: "Apply",
  });
  if (next == null) return;
  const to = next.trim().toLowerCase();
  if (!to || to === tag) return;
  try {
    const res = await VaultAPI.renameTag(tag, to);
    await controller.refresh();
    showToast(`Updated ${res.updated} ${res.updated === 1 ? "entry" : "entries"}.`, "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function deleteTagAction(controller, tag) {
  const ok = await confirmDialog({
    title: `Delete tag "${tag}"?`,
    message: "This removes the tag from every entry. The entries themselves are not deleted.",
    confirmText: "Delete tag",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await VaultAPI.deleteTag(tag);
    await controller.refresh();
    showToast(`Removed from ${res.updated} ${res.updated === 1 ? "entry" : "entries"}.`, "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}
