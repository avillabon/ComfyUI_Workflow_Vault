// Vault-wide settings: stats, vault location, defaults, and tag management,
// laid out as a constrained column of panels.

import { el, showToast, confirmDialog, promptDialog, applyAccentColor } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { buildFolderTree, countEntriesInFolder, createFolder, renameFolder, moveFolder, deleteFolder } from "./vault_folders.js";

// Optional grid-card fields the user can hide for a more minimal look.
const CARD_FIELD_DEFS = [
  ["description", "Description"],
  ["tags", "Tags"],
  ["versions", "Version count"],
  ["examples", "Example count"],
  ["date", "Updated date"],
];

// Curated accent presets shown as swatches alongside the custom color picker.
const PRESET_ACCENTS = ["#4d9fff", "#22c55e", "#a855f7", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6"];
const DEFAULT_ACCENT = "#4d9fff";

function formatBytes(n) {
  n = Math.max(0, n || 0);
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

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
    el(
      "button",
      {
        className: "wv-icon-btn wv-icon-btn-lg",
        title: "Back to vault",
        "aria-label": "Back to vault",
        onclick: () => controller.setView("grid"),
      },
      [el("i", { className: "pi pi-arrow-left" })]
    )
  );
  header.appendChild(el("div", { className: "wv-detail-title-area" }, [el("div", { className: "wv-detail-title" }, ["Vault Settings"])]));
  header.appendChild(el("div", { className: "wv-topbar-spacer" }));
  // Save lives in the header so it stays reachable no matter how far the
  // (now two-column) settings body is scrolled. Its handler reads the control
  // values below at click time, so the forward references are safe.
  const collectSettingsPayload = () => {
    const payload = {
      show_archived: showArchivedSwitch.input.checked,
      default_thumbnail_behavior: thumbBehaviorSelect.value,
      accent_color: selectedAccent,
      card_fields: Object.fromEntries(CARD_FIELD_DEFS.map(([k]) => [k, cardSwitches[k].input.checked])),
      compress_examples_on_upload: compressSwitch.input.checked,
      example_compress_format: compressFormat,
      compress_thumbnail_source: sourceSwitch.input.checked,
    };
    const nextRoot = (locationInput.value || "").trim();
    if (nextRoot && nextRoot !== (state.vault_root || "")) payload.vault_root = nextRoot;
    return payload;
  };
  const saveSettings = async () => {
    const payload = collectSettingsPayload();
    try {
      await VaultAPI.postSettings(payload);
    } catch (e) {
      if (!(e.status === 409 && e.data?.needs_confirmation && payload.vault_root)) throw e;
      const ok = await confirmDialog({ title: "Change Vault Location?", message: e.data.message, confirmText: "Continue" });
      if (!ok) return false;
      await VaultAPI.postSettings({ ...payload, confirm: true });
    }
    controller.filters.showArchived = showArchivedSwitch.input.checked;
    controller.setDirty(false);
    await controller.refresh();
    showToast("Settings saved.", "success");
    return true;
  };
  const markDirty = () => controller.setDirty(true, {
    saveHandler: saveSettings,
    discardHandler: () => applyAccentColor(state.settings?.accent_color),
    dialog: {
      title: "Save settings before leaving?",
      message: "You have unsaved settings changes.",
      saveText: "Save settings",
      discardText: "Discard",
    },
  });
  const saveBtn = el(
    "button",
    {
      className: "wv-btn wv-btn-primary wv-vs-header-save",
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          await saveSettings();
        } catch (e) {
          showToast(e.message, "error");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    [el("i", { className: "pi pi-save" }), "Save settings"]
  );
  header.appendChild(saveBtn);
  header.appendChild(el("button", { className: "wv-icon-btn wv-icon-btn-lg", title: "Close", "aria-label": "Close", onclick: () => controller.requestClose() }, [el("i", { className: "pi pi-times" })]));
  wrap.appendChild(header);

  const body = el("div", { className: "wv-settings-body wv-settings-body-tabbed" });

  // Tabbed layout: panels are grouped into sections shown one at a time, so the
  // page stays short and never overflows horizontally (the old 2-column masonry
  // spilled panels outside the modal at narrow widths).
  const SETTINGS_TABS = [
    { id: "general", label: "General" },
    { id: "organize", label: "Organization" },
    { id: "storage", label: "Storage" },
  ];
  const sections = {
    general: el("div", { className: "wv-settings-section" }),
    storage: el("div", { className: "wv-settings-section" }),
    // Organize holds two list panels (Tags, Folders) that read better side by
    // side on wide screens than stacked in a narrow centered column.
    organize: el("div", { className: "wv-settings-section wv-settings-section-wide" }),
  };
  const tabBar = el("div", { className: "wv-tab-bar" });
  const tabButtons = {};
  const showTab = (id) => {
    controller.settingsSection = id;
    for (const t of SETTINGS_TABS) {
      sections[t.id].style.display = t.id === id ? "" : "none";
      tabButtons[t.id].classList.toggle("wv-tab-active", t.id === id);
    }
  };
  for (const t of SETTINGS_TABS) {
    const btn = el(
      "button",
      {
        className: "wv-tab",
        onclick: async () => {
          if (controller.settingsSection === t.id) return;
          const proceed = await controller.checkDirty();
          if (!proceed) return;
          controller.settingsSection = t.id;
          controller.render();
        },
      },
      [t.label]
    );
    tabButtons[t.id] = btn;
    tabBar.appendChild(btn);
  }

  // --- Footprint (Storage tab; sizes loaded asynchronously) ---
  const footprintPanel = panel("Footprint", "pi pi-chart-pie", "How much disk space the vault uses on disk, and where it goes.");
  const footprintBody = el("div", { className: "wv-vs-footprint" }, [el("div", { className: "wv-muted" }, ["Calculating…"])]);
  footprintPanel.appendChild(footprintBody);
  sections.storage.appendChild(footprintPanel);
  VaultAPI.getFootprint()
    .then((fp) => renderFootprint(footprintBody, fp))
    .catch(() => footprintBody.replaceChildren(el("div", { className: "wv-muted" }, ["Couldn't calculate the vault footprint."])));

  // --- Vault location ---
  const locationInput = el("input", { className: "wv-input wv-mono", type: "text", placeholder: "New vault folder path", value: state.vault_root || "" });
  const locationStatus = el("div", { className: "wv-init-status" });
  const locationBrowseBtn = el(
    "button",
    {
      className: "wv-btn",
      title: "Browse for a folder",
      onclick: async () => {
        locationBrowseBtn.disabled = true;
        try {
          const res = await VaultAPI.browseFolder();
          if (res.path) {
            locationInput.value = res.path;
            markDirty();
          }
        } catch {
          // silently ignore
        } finally {
          locationBrowseBtn.disabled = false;
        }
      },
    },
    [el("i", { className: "pi pi-folder-open" }), " Browse…"]
  );
  const changeBtn = el("button", { className: "wv-btn", onclick: () => changeVaultRoot(locationInput.value, false) }, ["Change…"]);
  locationInput.addEventListener("input", markDirty);
  locationInput.addEventListener("change", markDirty);

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
      controller.setDirty(false);
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
  locPanel.appendChild(el("div", { className: "wv-vs-location-row" }, [locationInput, locationBrowseBtn, changeBtn]));
  locPanel.appendChild(locationStatus);
  sections.general.appendChild(locPanel);

  // --- Defaults ---
  const showArchivedSwitch = switchEl(!!state.settings?.show_archived);
  const thumbBehaviorSelect = el(
    "select",
    { className: "wv-input wv-vs-select" },
    [
      { value: "placeholder", label: "Show placeholder icon" },
      { value: "blank", label: "Leave blank" },
    ].map((o) => el("option", { value: o.value, selected: state.settings?.default_thumbnail_behavior === o.value }, [o.label]))
  );
  showArchivedSwitch.input.addEventListener("change", markDirty);
  thumbBehaviorSelect.addEventListener("change", markDirty);

  const defPanel = panel("Defaults", "pi pi-sliders-h", null);
  defPanel.appendChild(settingRow("Show archived entries by default", showArchivedSwitch));
  defPanel.appendChild(settingRow("When an entry has no thumbnail", thumbBehaviorSelect));
  sections.general.appendChild(defPanel);

  // --- Card display (cosmetic field toggles) ---
  const cardFields = state.settings?.card_fields || {};
  const cardSwitches = {};
  const cardPanel = panel(
    "Card display",
    "pi pi-id-card",
    "Choose which fields appear on cards in the main grid. This only hides them — nothing is deleted."
  );
  for (const [key, label] of CARD_FIELD_DEFS) {
    const sw = switchEl(cardFields[key] !== false);
    cardSwitches[key] = sw;
    sw.input.addEventListener("change", markDirty);
    cardPanel.appendChild(settingRow(label, sw));
  }
  sections.general.appendChild(cardPanel);

  // --- Appearance (accent color) ---
  let selectedAccent = state.settings?.accent_color || DEFAULT_ACCENT;
  const colorInput = el("input", { type: "color", className: "wv-color-input", value: selectedAccent, title: "Custom color" });
  const swatchRow = el("div", { className: "wv-accent-swatches" });

  function syncAccent() {
    applyAccentColor(selectedAccent); // live preview; persisted on Save
    colorInput.value = selectedAccent;
    for (const sw of swatchRow.children) {
      sw.classList.toggle("wv-swatch-active", (sw.dataset.color || "").toLowerCase() === selectedAccent.toLowerCase());
    }
  }

  for (const c of PRESET_ACCENTS) {
    swatchRow.appendChild(
      el("button", {
        className: "wv-swatch",
        dataset: { color: c },
        style: { background: c },
        title: c,
        "aria-label": `Accent color ${c}`,
        onclick: () => {
          selectedAccent = c;
          syncAccent();
          markDirty();
        },
      })
    );
  }
  colorInput.addEventListener("input", () => {
    selectedAccent = colorInput.value;
    syncAccent();
    markDirty();
  });

  const accentPanel = panel("Appearance", "pi pi-palette", "Accent color used for icons, the logo, and highlights throughout the vault.");
  accentPanel.appendChild(
    settingRow("Accent color", el("div", { className: "wv-accent-controls" }, [swatchRow, colorInput]))
  );
  sections.general.appendChild(accentPanel);
  syncAccent();

  // --- Storage (example image compression) ---
  const pillowOk = state.pillow_available !== false;
  let compressFormat = state.settings?.example_compress_format === "jpeg" ? "jpeg" : "webp";
  const compressSwitch = switchEl(!!state.settings?.compress_examples_on_upload && pillowOk);
  compressSwitch.input.disabled = !pillowOk;

  // Thumbnail source compression (always WebP — keeps the embedded workflow).
  const sourceSwitch = switchEl(state.settings?.compress_thumbnail_source !== false && pillowOk);
  sourceSwitch.input.disabled = !pillowOk;
  sourceSwitch.input.addEventListener("change", markDirty);

  const formatRow = el("div", { className: "wv-vs-format" });
  const FORMATS = [
    ["webp", "WebP", "Smaller, keeps transparency, and the workflow stays drag-droppable into ComfyUI."],
    ["jpeg", "JPEG", "Maximum compatibility, no transparency, and ComfyUI can't reload the workflow from a JPEG."],
  ];
  for (const [value, label, desc] of FORMATS) {
    const radio = el("input", {
      type: "radio",
      name: "wv-compress-format",
      className: "wv-radio-input",
      value,
      checked: compressFormat === value,
      onchange: () => {
        if (radio.checked) compressFormat = value;
        markDirty();
      },
    });
    formatRow.appendChild(
      el("label", { className: "wv-radio-field" }, [
        radio,
        el("div", { className: "wv-radio-text" }, [
          el("div", { className: "wv-radio-label" }, [label]),
          el("div", { className: "wv-radio-desc" }, [desc]),
        ]),
      ])
    );
  }

  function syncCompressUi() {
    formatRow.style.display = compressSwitch.input.checked ? "" : "none";
  }
  compressSwitch.input.addEventListener("change", () => {
    syncCompressUi();
    markDirty();
  });

  const storagePanel = panel(
    "Storage",
    "pi pi-database",
    "Large PNG example media is converted to smaller files as you add it — typically 5–15× smaller — so your vault stays portable and quick to back up. The embedded ComfyUI workflow is preserved (WebP), so nothing is lost. Recommended."
  );
  storagePanel.appendChild(settingRow("Compress example images on upload", compressSwitch));
  storagePanel.appendChild(formatRow);
  storagePanel.appendChild(settingRow("Compress thumbnail source on upload", sourceSwitch));
  storagePanel.appendChild(
    el("p", { className: "wv-radio-desc wv-vs-hint" }, [
      "The full-resolution original is saved as a smaller WebP that keeps transparency and the same resolution, with the ComfyUI workflow still embedded — so it stays drag-droppable into ComfyUI.",
    ])
  );

  const batchStatus = el("span", { className: "wv-vs-footer-status" });
  const batchBtn = el(
    "button",
    {
      className: "wv-btn",
      disabled: !pillowOk,
      onclick: async () => {
        const ok = await confirmDialog({
          title: "Compress existing images?",
          message:
            "Re-encodes every example image (to the selected format) and every thumbnail source (to WebP) already in your vault. Images that wouldn't get smaller are left untouched. This can take a moment.",
          confirmText: "Compress",
        });
        if (!ok) return;
        batchBtn.disabled = true;
        batchStatus.textContent = "Compressing…";
        try {
          // Persist the chosen format first so the batch uses what's selected.
          await VaultAPI.postSettings({ example_compress_format: compressFormat });
          const res = await VaultAPI.compressExamples();
          batchStatus.textContent = "";

          const saved = Math.max(0, (res.bytes_before || 0) - (res.bytes_after || 0));
          const pct = res.bytes_before ? Math.round((saved / res.bytes_before) * 100) : 0;
          let message;
          if (!res.examined) {
            message = "No images were found to compress.";
          } else if (!res.converted) {
            message = `All ${res.examined} image${res.examined === 1 ? "" : "s"} are already optimized — nothing to compress.`;
          } else {
            const lines = [`Compressed ${res.converted} of ${res.examined} image${res.examined === 1 ? "" : "s"}.`];
            if (res.skipped) lines.push(`${res.skipped} already optimized — left untouched.`);
            lines.push("");
            lines.push(`Before:  ${formatBytes(res.bytes_before)}`);
            lines.push(`After:   ${formatBytes(res.bytes_after)}`);
            lines.push(`Saved:   ${formatBytes(saved)}  (${pct}%)`);
            message = lines.join("\n");
          }
          await confirmDialog({ title: "Compression complete", message, confirmText: "Done", cancelText: null });
          await controller.refresh();
        } catch (e) {
          batchStatus.textContent = "";
          showToast(e.message, "error");
        } finally {
          batchBtn.disabled = false;
        }
      },
    },
    [el("i", { className: "pi pi-bolt" }), "Compress existing images"]
  );
  storagePanel.appendChild(
    el("div", { className: "wv-vs-batch-row" }, [
      el("div", { className: "wv-vs-batch-text" }, [
        el("div", {}, ["Compress existing images"]),
        el("div", { className: "wv-radio-desc" }, ["Apply this to all example images and thumbnail sources already in your vault."]),
      ]),
      el("div", { className: "wv-vs-batch-action" }, [batchStatus, batchBtn]),
    ])
  );

  if (!pillowOk) {
    storagePanel.appendChild(
      el("p", { className: "wv-muted wv-vs-hint" }, ["Compression is unavailable because Pillow isn't installed in this Python environment."])
    );
  }
  sections.storage.appendChild(storagePanel);
  syncCompressUi();

  // --- Backup (full-vault export) ---
  const exportPanel = panel("Backup", "pi pi-download", "Download the entire vault — entries, media, versions, and settings — as a single .zip.");
  exportPanel.appendChild(
    el("a", { className: "wv-btn", href: VaultAPI.exportVaultUrl(), download: "", title: "Download the whole vault as a .zip" }, [
      el("i", { className: "pi pi-download" }),
      " Export vault (.zip)",
    ])
  );
  sections.storage.appendChild(exportPanel);

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
  sections.organize.appendChild(tagPanel);

  // --- Folders ---
  const folders = state.folders || [];
  const foldersPanel = panel(
    "Folders",
    "pi pi-folder",
    "Create, rename, move, or delete folders. Deleting a folder moves its entries to Uncategorized — it never deletes entries."
  );
  foldersPanel.appendChild(
    el("div", { className: "wv-folder-manager-actions" }, [
      el("button", { className: "wv-btn", onclick: () => createFolder(controller, null) }, [el("i", { className: "pi pi-plus" }), " New folder"]),
    ])
  );
  if (!folders.length) {
    foldersPanel.appendChild(el("p", { className: "wv-muted" }, ["No folders yet."]));
  } else {
    const listEl = el("div", { className: "wv-folder-manager" });
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        const count = countEntriesInFolder(state, node.id);
        listEl.appendChild(
          el("div", { className: "wv-folder-manager-row", style: { paddingLeft: `${10 + depth * 16}px` } }, [
            el("span", { className: "wv-folder-manager-name" }, [el("i", { className: "pi pi-folder" }), node.name]),
            el("span", { className: "wv-folder-manager-count" }, [`${count}`]),
            el("button", { className: "wv-icon-btn", title: "New subfolder", "aria-label": `New subfolder in ${node.name}`, onclick: () => createFolder(controller, node.id) }, [el("i", { className: "pi pi-plus" })]),
            el("button", { className: "wv-icon-btn", title: "Rename", "aria-label": `Rename folder ${node.name}`, onclick: () => renameFolder(controller, node) }, [el("i", { className: "pi pi-pencil" })]),
            el("button", { className: "wv-icon-btn", title: "Move", "aria-label": `Move folder ${node.name}`, onclick: () => moveFolder(controller, node) }, [el("i", { className: "pi pi-arrows-h" })]),
            el("button", { className: "wv-icon-btn wv-icon-btn-danger", title: "Delete", "aria-label": `Delete folder ${node.name}`, onclick: () => deleteFolder(controller, node) }, [el("i", { className: "pi pi-trash" })]),
          ])
        );
        walk(node.children, depth + 1);
      }
    };
    walk(buildFolderTree(folders), 0);
    foldersPanel.appendChild(listEl);
  }
  sections.organize.appendChild(foldersPanel);

  // --- Health / recovery ---
  sections.storage.appendChild(renderHealthPanel(controller));

  // Assemble: tab bar + sections; show the remembered (or first) tab.
  body.appendChild(tabBar);
  body.appendChild(sections.general);
  body.appendChild(sections.organize);
  body.appendChild(sections.storage);
  showTab(SETTINGS_TABS.some((t) => t.id === controller.settingsSection) ? controller.settingsSection : "general");

  wrap.appendChild(body);
  return wrap;
}

function renderHealthPanel(controller) {
  const healthPanel = panel(
    "Vault health",
    "pi pi-heart",
    "Checks for interrupted saves, missing referenced files, and stale folder references. Checking is read-only."
  );
  const summary = el("div", { className: "wv-health-summary" }, [el("div", { className: "wv-muted" }, ["Run a check to inspect this vault."])]);
  const issueList = el("div", { className: "wv-health-issues" });
  const actions = el("div", { className: "wv-vs-batch-row" });
  const status = el("span", { className: "wv-vs-footer-status" });
  const checkBtn = el("button", { className: "wv-btn wv-btn-primary" }, [el("i", { className: "pi pi-search" }), "Check vault"]);
  const cleanupBtn = el("button", { className: "wv-btn", disabled: true }, [el("i", { className: "pi pi-trash" }), "Clean interrupted saves"]);

  function renderReport(report) {
    const s = report?.summary || {};
    summary.replaceChildren(
      el("div", { className: `wv-health-state${report?.ok ? " wv-health-state-ok" : ""}` }, [
        el("i", { className: report?.ok ? "pi pi-check-circle" : "pi pi-exclamation-triangle" }),
        report?.ok ? "No issues found." : `${(report?.issues || []).length} issue${(report?.issues || []).length === 1 ? "" : "s"} found.`,
      ]),
      el("div", { className: "wv-vs-stats wv-health-stats" }, [
        statTile("Entries", s.entries || 0),
        statTile("Versions", s.versions || 0),
        statTile("Examples", s.examples || 0),
        statTile("Missing files", s.missing_files || 0),
      ])
    );
    cleanupBtn.disabled = !(s.staging_entries > 0);
    issueList.replaceChildren();
    for (const issue of report?.issues || []) {
      issueList.appendChild(
        el("div", { className: `wv-health-issue wv-health-${issue.severity || "warning"}` }, [
          el("i", { className: issue.severity === "error" ? "pi pi-times-circle" : "pi pi-exclamation-circle" }),
          el("div", { className: "wv-health-issue-body" }, [
            el("div", { className: "wv-health-issue-title" }, [issueTitle(issue)]),
            el("div", { className: "wv-health-issue-meta" }, [issue.message || issue.type || "Vault issue"]),
            ...(issue.path ? [el("div", { className: "wv-mono wv-health-path" }, [issue.path])] : []),
          ]),
        ])
      );
    }
  }

  async function runCheck() {
    checkBtn.disabled = true;
    status.textContent = "Checking…";
    try {
      renderReport(await VaultAPI.getHealth());
      status.textContent = "";
    } catch (e) {
      status.textContent = e.message;
    } finally {
      checkBtn.disabled = false;
    }
  }

  checkBtn.onclick = runCheck;
  cleanupBtn.onclick = async () => {
    const ok = await confirmDialog({
      title: "Clean interrupted saves?",
      message: "Staging folders from interrupted entry saves will be moved to your system Trash/Recycle Bin where supported. Complete entries are not touched.",
      confirmText: "Clean up",
      danger: true,
    });
    if (!ok) return;
    cleanupBtn.disabled = true;
    status.textContent = "Cleaning…";
    try {
      const res = await VaultAPI.cleanupStaging();
      renderReport(res.health);
      const moved = res.removed?.length || 0;
      showToast(`Cleaned ${moved} interrupted save${moved === 1 ? "" : "s"}.`, "success");
      await controller.refresh();
    } catch (e) {
      status.textContent = e.message;
    }
  };

  actions.appendChild(el("div", { className: "wv-vs-batch-text" }, [
    el("div", {}, ["Inspect and recover"]),
    el("div", { className: "wv-radio-desc" }, ["Use cleanup only for .wv_staging_* folders left by interrupted saves."]),
  ]));
  actions.appendChild(el("div", { className: "wv-vs-batch-action" }, [status, checkBtn, cleanupBtn]));
  healthPanel.appendChild(summary);
  healthPanel.appendChild(issueList);
  healthPanel.appendChild(actions);
  return healthPanel;
}

function statTile(label, value) {
  return el("div", { className: "wv-vs-stat" }, [
    el("div", { className: "wv-vs-stat-label" }, [label]),
    el("div", { className: "wv-vs-stat-value" }, [String(value)]),
  ]);
}

function issueTitle(issue) {
  const names = {
    staging_entry: "Interrupted save",
    orphan_entry_dir: "Orphan entry folder",
    missing_folder: "Missing folder",
    missing_media: "Missing media",
    missing_workflow: "Missing workflow",
    missing_example_media: "Missing example media",
    stale_folder_entry: "Stale folder entry",
  };
  return names[issue?.type] || "Vault issue";
}

// Fills the footprint panel once sizes come back from the backend: a stacked
// proportion bar over the size buckets, a labelled legend, and count tiles.
function renderFootprint(container, fp) {
  const BUCKETS = [
    ["examples", "Example media", "wv-fp-examples"],
    ["thumbnails", "Thumbnails", "wv-fp-thumbnails"],
    ["workflows", "Workflows", "wv-fp-workflows"],
  ];
  const total = Math.max(0, fp.total || 0);
  // The bar shows how the media splits across the buckets above, so it's
  // normalized to their sum and fills completely (vault metadata is excluded).
  const shownTotal = BUCKETS.reduce((s, [k]) => s + Math.max(0, fp[k] || 0), 0) || 1;

  const head = el("div", { className: "wv-fp-head" }, [
    el("span", { className: "wv-fp-total-label" }, ["Total on disk"]),
    el("span", { className: "wv-fp-total-value" }, [formatBytes(total)]),
  ]);

  const bar = el("div", { className: "wv-fp-bar" });
  for (const [key, , cls] of BUCKETS) {
    const bytes = Math.max(0, fp[key] || 0);
    if (bytes > 0) {
      bar.appendChild(el("div", { className: `wv-fp-seg ${cls}`, style: { width: `${(bytes / shownTotal) * 100}%` }, title: `${formatBytes(bytes)}` }));
    }
  }

  const legend = el("div", { className: "wv-fp-legend" });
  for (const [key, label, cls] of BUCKETS) {
    legend.appendChild(
      el("div", { className: "wv-fp-legend-item" }, [
        el("span", { className: `wv-fp-dot ${cls}` }),
        el("span", { className: "wv-fp-legend-label" }, [label]),
        el("span", { className: "wv-fp-legend-value" }, [formatBytes(fp[key] || 0)]),
      ])
    );
  }

  const counts = el("div", { className: "wv-vs-stats wv-fp-counts" });
  const tile = (label, value) =>
    el("div", { className: "wv-vs-stat" }, [el("div", { className: "wv-vs-stat-label" }, [label]), el("div", { className: "wv-vs-stat-value" }, [String(value)])]);
  counts.appendChild(tile("Workflows", fp.entries || 0));
  counts.appendChild(tile("Versions", fp.versions || 0));
  counts.appendChild(tile("Examples", fp.examples_count || 0));
  counts.appendChild(tile("Tags", fp.tags || 0));

  container.replaceChildren(head, bar, legend, counts);
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
