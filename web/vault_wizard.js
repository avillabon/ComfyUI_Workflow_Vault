// "Save Current Workflow to Vault" flow: create a brand-new entry, or save
// the current canvas as a new/overwritten version of an existing entry.

import { el, clear, showToast, confirmDialog } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { STATUS_LABELS, STATUS_ORDER, GENERATION_TYPES } from "./vault_modal.js";
import { renderFolderSelect } from "./vault_folders.js";
import { renderTagInput, tagCountsFrom } from "./vault_tag_input.js";
import { renderThumbnailField } from "./vault_thumbnail_input.js";
import { renderMediaPicker } from "./vault_media_picker.js";
import { renderNotesEditor } from "./vault_notes_editor.js";
import { getCurrentWorkflowJSON, getWorkflowVaultOrigin } from "./vault_workflow.js";

export function renderWizard(controller) {
  const wrap = el("div", { className: "wv-wizard" });

  const header = el("div", { className: "wv-detail-header" });
  header.appendChild(
    el("button", { className: "wv-icon-btn wv-icon-btn-lg", title: "Back to vault", "aria-label": "Back to vault", onclick: () => controller.setView("grid") }, [el("i", { className: "pi pi-arrow-left" })])
  );
  header.appendChild(el("div", { className: "wv-detail-title-area" }, [el("div", { className: "wv-detail-title" }, ["Save Current Workflow"])]));
  header.appendChild(el("div", { className: "wv-topbar-spacer" }));
  header.appendChild(el("button", { className: "wv-icon-btn wv-icon-btn-lg", title: "Close", "aria-label": "Close", onclick: () => controller.requestClose() }, [el("i", { className: "pi pi-times" })]));
  wrap.appendChild(header);

  const entries = controller.state.entries || [];
  const hasEntries = entries.length > 0;

  // If the current canvas was opened from a vault entry, default to updating
  // that entry (overwrite / new version) rather than creating a new one.
  const origin = getWorkflowVaultOrigin();
  const originEntry = origin?.entry_id ? entries.find((e) => e.id === origin.entry_id) : null;
  controller.wizardOptions = controller.wizardOptions || {};
  if (originEntry) controller.wizardOptions.updateEntryId = originEntry.id;

  let mode;
  if (originEntry) mode = "update";
  else if (controller.wizardOptions?.mode === "update" && hasEntries) mode = "update";
  else mode = "create";

  const body = el("div", { className: "wv-wizard-body" });

  const createBtn = el("button", { className: "wv-segmented-btn", onclick: () => switchMode("create") }, ["Create new entry"]);
  const updateBtn = el("button", { className: "wv-segmented-btn", disabled: !hasEntries, title: hasEntries ? "" : "No entries to update yet", onclick: () => switchMode("update") }, ["Update existing"]);
  const seg = el("div", { className: "wv-segmented" }, [createBtn, updateBtn]);

  // Canvas banner lives in the toggle row (create mode only).
  const banner = buildCanvasBanner(countNodes(getCurrentWorkflowJSON()));

  const paintSeg = () => {
    createBtn.classList.toggle("wv-segmented-btn-active", mode === "create");
    updateBtn.classList.toggle("wv-segmented-btn-active", mode === "update");
    banner.style.display = mode === "create" ? "" : "none";
  };
  const paintBody = () => {
    clear(body);
    body.appendChild(mode === "update" ? renderUpdateForm(controller) : renderCreateForm(controller));
  };
  async function switchMode(next) {
    if (mode === next) return;
    const proceed = await controller.checkDirty();
    if (!proceed) return;
    controller.setDirty(false);
    mode = next;
    paintSeg();
    paintBody();
  }

  wrap.appendChild(el("div", { className: "wv-wizard-mode-row" }, [seg, banner]));
  wrap.appendChild(body);
  paintSeg();
  paintBody();

  return wrap;
}

function formRow(label, input) {
  return el("div", { className: "wv-form-row" }, [el("label", {}, [label]), input]);
}

function requiredRow(label, input) {
  return el("div", { className: "wv-form-row" }, [
    el("label", {}, [label, el("span", { className: "wv-required" }, [" *"])]),
    input,
  ]);
}

function countNodes(workflow) {
  return Array.isArray(workflow?.nodes) ? workflow.nodes.length : 0;
}

function buildCanvasBanner(nodeCount) {
  const banner = el("div", { className: `wv-wizard-banner${nodeCount === 0 ? " wv-wizard-banner-warn" : ""}` });
  if (nodeCount === 0) {
    banner.appendChild(el("i", { className: "pi pi-exclamation-triangle" }));
    banner.appendChild(document.createTextNode("The canvas is empty — add nodes before saving."));
  } else {
    banner.appendChild(el("i", { className: "pi pi-sitemap" }));
    banner.appendChild(el("span", {}, ["Saving the current canvas · ", el("b", {}, [`${nodeCount} node${nodeCount === 1 ? "" : "s"}`])]));
  }
  return banner;
}

// ---------------------------------------------------------------------------
// Create new entry (two-pane: metadata + tabbed Examples/Docs/Version panel)
// ---------------------------------------------------------------------------

function renderCreateForm(controller) {
  const wrap = el("div", { className: "wv-wizard-create" });
  const markDirty = () => controller.setDirty(true);

  // --- Left column: entry metadata ---
  const nameInput = el("input", { className: "wv-input", type: "text", placeholder: "Workflow name" });
  const descInput = el("textarea", { className: "wv-input wv-textarea", placeholder: "What does this workflow do?" });
  const tagInput = renderTagInput({
    tags: [],
    allTags: controller.state.tags || [],
    tagCounts: tagCountsFrom(controller.state.entries),
  });
  const defaultStatus = controller.state.settings?.default_status || "draft";
  const statusSelect = el(
    "select",
    { className: "wv-input" },
    STATUS_ORDER.filter((s) => s !== "archived").map((s) => el("option", { value: s, selected: s === defaultStatus }, [STATUS_LABELS[s]]))
  );
  const defaultFolderId = controller.wizardOptions?.defaultFolderId || "";
  controller.state.folders = controller.state.folders || [];
  const folderSelect = renderFolderSelect({ folders: controller.state.folders, selectedId: defaultFolderId });
  const genTypeSelect = el(
    "select",
    { className: "wv-input" },
    [el("option", { value: "" }, ["— None —"]), ...GENERATION_TYPES.map((t) => el("option", { value: t.id }, [t.label]))]
  );
  const favCheckbox = el("input", { type: "checkbox" });
  const thumbField = renderThumbnailField({ currentUrl: null });

  // --- Right column inputs: version + notes ---
  const customLabelInput = el("input", { className: "wv-input", type: "text", placeholder: "e.g. Initial version" });
  const versionNotesInput = el("textarea", { className: "wv-input wv-textarea", placeholder: "Notes for this version (Markdown supported)" });

  for (const input of [nameInput, descInput, statusSelect, genTypeSelect, folderSelect, favCheckbox, thumbField.fileInput, customLabelInput, versionNotesInput]) {
    input.addEventListener("input", markDirty);
    input.addEventListener("change", markDirty);
  }
  tagInput.addEventListener("change", markDirty);

  const notesEditor = renderNotesEditor({ notes: [], onChange: markDirty });

  const left = el("div", { className: "wv-wizard-left" });
  left.appendChild(requiredRow("Name", nameInput));
  left.appendChild(formRow("Description", descInput));
  left.appendChild(formRow("Tags", tagInput));
  left.appendChild(el("div", { className: "wv-form-row-pair" }, [formRow("Status", statusSelect), formRow("Generation type", genTypeSelect)]));
  left.appendChild(formRow("Folder", folderSelect));
  left.appendChild(el("div", { className: "wv-form-row" }, [el("label", { className: "wv-checkbox-label" }, [favCheckbox, "Favorite"])]));
  left.appendChild(formRow("Thumbnail (optional)", thumbField));

  // --- Right column: tabbed panel ---
  const examplesPanel = el("div", { className: "wv-wizard-tab-content" });
  const examplesContainer = el("div", { className: "wv-examples-list" });
  const exampleBlocks = [];

  function renumberExamples() {
    exampleBlocks.forEach((ref, i) => {
      ref.heading.textContent = `Example ${i + 1}`;
      ref.removeBtn.style.display = exampleBlocks.length > 1 ? "" : "none";
    });
  }

  function removeExampleBlock(ref) {
    examplesContainer.removeChild(ref.block);
    exampleBlocks.splice(exampleBlocks.indexOf(ref), 1);
    renumberExamples();
    markDirty();
  }

  function addExampleBlock() {
    const block = el("div", { className: "wv-wizard-example-block" });
    const exampleNotesInput = el("textarea", { className: "wv-input wv-textarea", placeholder: "Notes about this example" });
    const notesRow = formRow("Notes", exampleNotesInput);
    notesRow.style.display = "none";

    const picker = renderMediaPicker({
      preview: true,
      onChange: () => {
        markDirty();
        notesRow.style.display = picker.isEmpty() ? "none" : "";
      },
    });
    exampleNotesInput.addEventListener("input", markDirty);

    const heading = el("h5", {}, ["Example"]);
    const removeBtn = el(
      "button",
      { type: "button", className: "wv-icon-btn", title: "Remove example", "aria-label": "Remove example", onclick: () => removeExampleBlock(ref) },
      [el("i", { className: "pi pi-trash" })]
    );
    const ref = { block, picker, notesInput: exampleNotesInput, heading, removeBtn };

    block.appendChild(el("div", { className: "wv-wizard-example-header" }, [heading, removeBtn]));
    block.appendChild(picker.element);
    block.appendChild(notesRow);

    exampleBlocks.push(ref);
    examplesContainer.appendChild(block);
    renumberExamples();
  }

  addExampleBlock();
  examplesPanel.appendChild(examplesContainer);
  examplesPanel.appendChild(
    el("button", { type: "button", className: "wv-btn-link", onclick: () => addExampleBlock() }, [el("i", { className: "pi pi-plus" }), "Add another example"])
  );

  const notesPanel = el("div", { className: "wv-wizard-tab-content" }, [notesEditor]);

  const versionPanel = el("div", { className: "wv-wizard-tab-content" }, [
    formRow("Custom label (optional)", customLabelInput),
    formRow("Version notes (optional)", versionNotesInput),
  ]);

  const TABS = [
    { id: "examples", label: "Examples", panel: examplesPanel },
    { id: "notes", label: "Notes", panel: notesPanel },
    { id: "version", label: "Version details", panel: versionPanel },
  ];
  let activeTab = "examples";
  const tabBtns = {};
  const paintTabs = () => {
    for (const t of TABS) {
      tabBtns[t.id].classList.toggle("wv-segmented-btn-active", t.id === activeTab);
      t.panel.style.display = t.id === activeTab ? "" : "none";
    }
  };

  const tabStrip = el("div", { className: "wv-segmented wv-wizard-subtabs" });
  const tabPanel = el("div", { className: "wv-wizard-tabpanel" });
  for (const t of TABS) {
    tabBtns[t.id] = el("button", { type: "button", className: "wv-segmented-btn", onclick: () => { activeTab = t.id; paintTabs(); } }, [t.label]);
    tabStrip.appendChild(tabBtns[t.id]);
    tabPanel.appendChild(t.panel);
  }
  const right = el("div", { className: "wv-wizard-right" }, [el("div", { className: "wv-wizard-tabbar" }, [tabStrip]), tabPanel]);
  paintTabs();

  wrap.appendChild(el("div", { className: "wv-wizard-grid" }, [left, right]));

  // --- Sticky footer: status + save ---
  const status = el("div", { className: "wv-init-status wv-wizard-footer-status", role: "alert" });
  const saveBtn = el("button", { className: "wv-btn wv-btn-primary" }, [el("i", { className: "pi pi-save" }), "Save to Vault"]);
  const setSaving = (saving) => {
    saveBtn.disabled = saving;
    saveBtn.replaceChildren(
      ...(saving ? [document.createTextNode("Saving…")] : [el("i", { className: "pi pi-save" }), document.createTextNode("Save to Vault")])
    );
  };
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = "Name is required.";
      nameInput.focus();
      return;
    }
    const workflow = getCurrentWorkflowJSON();
    if (countNodes(workflow) === 0) {
      status.textContent = "The canvas is empty — add nodes before saving.";
      return;
    }
    setSaving(true);
    status.textContent = "";
    try {
      const data = {
        name,
        description: descInput.value,
        tags: tagInput.getTags(),
        status: statusSelect.value,
        generation_type: genTypeSelect.value || null,
        favorite: favCheckbox.checked,
        folder_id: folderSelect.value === "__new__" ? null : folderSelect.value || null,
        custom_label: customLabelInput.value.trim() || null,
        version_notes: versionNotesInput.value,
        notes: notesEditor.getNotes(),
        workflow,
      };

      const formData = new FormData();
      if (thumbField.fileInput.files[0]) formData.append("thumbnail", thumbField.fileInput.files[0]);

      const examplesData = [];
      let exampleIdx = 0;
      for (const blk of exampleBlocks) {
        if (blk.picker.isEmpty()) continue;
        examplesData.push({ notes: blk.notesInput.value });
        blk.picker.getByRole("input").forEach((f, i) => formData.append(`example_${exampleIdx}_input_${i}`, f));
        blk.picker.getByRole("output").forEach((f, i) => formData.append(`example_${exampleIdx}_output_${i}`, f));
        exampleIdx++;
      }
      data.examples = examplesData;
      formData.append("data", JSON.stringify(data));

      const entry = await VaultAPI.createEntry(formData);
      controller.setDirty(false);
      await controller.refresh();
      await controller.openEntry(entry.id);
      showToast(`"${entry.name}" saved to vault.`, "success");
      if (entry.skipped_files?.length) {
        showToast(`Skipped unsupported file(s): ${entry.skipped_files.join(", ")}`, "warn");
      }
    } catch (e) {
      status.textContent = e.message;
    } finally {
      setSaving(false);
    }
  });

  const footer = el("div", { className: "wv-wizard-footer" }, [
    el("span", { className: "wv-wizard-footer-hint" }, [el("i", { className: "pi pi-info-circle" }), " Name is required"]),
    status,
    saveBtn,
  ]);
  wrap.appendChild(footer);

  return wrap;
}

// ---------------------------------------------------------------------------
// Update existing entry
// ---------------------------------------------------------------------------

function renderUpdateForm(controller) {
  const form = el("div", { className: "wv-form" });
  const markDirty = () => controller.setDirty(true);

  const entries = [...(controller.state.entries || [])].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));

  // Pre-select the entry this canvas was opened from, if known.
  const preselectId = controller.wizardOptions?.updateEntryId;
  const preselectEntry = preselectId ? entries.find((e) => e.id === preselectId) : null;

  const entrySelect = el(
    "select",
    { className: "wv-input" },
    entries.map((e) => el("option", { value: e.id, selected: e.id === preselectId }, [e.name]))
  );
  entrySelect.addEventListener("change", markDirty);

  if (preselectEntry) {
    form.appendChild(
      el("p", { className: "wv-muted" }, [
        el("i", { className: "pi pi-link" }),
        ` This canvas was opened from "${preselectEntry.name}".`,
      ])
    );
  }
  form.appendChild(formRow("Entry", entrySelect));

  const detailContainer = el("div", { className: "wv-wizard-update-detail" });
  form.appendChild(detailContainer);

  const renderEntryDetail = () => {
    clear(detailContainer);
    const entry = entries.find((e) => e.id === entrySelect.value);
    if (!entry) return;

    const currentVersion = (entry.versions || []).find((v) => v.id === entry.current_version_id);

    detailContainer.appendChild(
      el("p", { className: "wv-muted" }, [
        currentVersion
          ? `Current version: ${currentVersion.custom_label || currentVersion.label}`
          : "This entry has no versions yet.",
      ])
    );

    const saveAsRadio = el("input", { type: "radio", name: "wv-update-action", checked: true });
    const overwriteRadio = el("input", { type: "radio", name: "wv-update-action", disabled: !currentVersion });

    const newVersionFields = el("div", { className: "wv-wizard-section-body" });
    const customLabelInput = el("input", { className: "wv-input", type: "text", placeholder: "e.g. Latest, Stable cut" });
    const notesInput = el("textarea", { className: "wv-input wv-textarea", placeholder: "Notes for this version (Markdown supported)" });
    newVersionFields.appendChild(formRow("Custom label (optional)", customLabelInput));
    newVersionFields.appendChild(formRow("Notes (optional)", notesInput));

    const overwriteWarning = el("div", { className: "wv-wizard-section-body" });
    overwriteWarning.style.display = "none";
    overwriteWarning.appendChild(
      el("p", { className: "wv-muted" }, [
        `This replaces the saved workflow for "${currentVersion ? currentVersion.custom_label || currentVersion.label : ""}" with the current canvas. This cannot be undone.`,
      ])
    );

    saveAsRadio.addEventListener("change", () => {
      if (!saveAsRadio.checked) return;
      newVersionFields.style.display = "";
      overwriteWarning.style.display = "none";
    });
    overwriteRadio.addEventListener("change", () => {
      if (!overwriteRadio.checked) return;
      newVersionFields.style.display = "none";
      overwriteWarning.style.display = "";
    });

    detailContainer.appendChild(el("label", { className: "wv-radio-label" }, [saveAsRadio, "Save as a new version"]));
    detailContainer.appendChild(newVersionFields);
    detailContainer.appendChild(el("label", { className: "wv-radio-label" }, [overwriteRadio, "Overwrite the current version"]));
    detailContainer.appendChild(overwriteWarning);

    for (const input of [customLabelInput, notesInput]) {
      input.addEventListener("input", markDirty);
      input.addEventListener("change", markDirty);
    }

    const status = el("div", { className: "wv-init-status" });
    detailContainer.appendChild(status);

    const actions = el("div", { className: "wv-form-actions" });
    const saveBtn = el(
      "button",
      {
        className: "wv-btn wv-btn-primary",
        onclick: async () => {
          saveBtn.disabled = true;
          status.textContent = "";
          try {
            const workflow = getCurrentWorkflowJSON();
            if (overwriteRadio.checked && currentVersion) {
              const ok = await confirmDialog({
                title: "Overwrite current version?",
                message: "This replaces the saved workflow for the current version with the current canvas. This cannot be undone.",
                confirmText: "Overwrite",
                danger: true,
              });
              if (!ok) {
                saveBtn.disabled = false;
                return;
              }
              await VaultAPI.overwriteVersion(entry.id, currentVersion.id, { workflow });
            } else {
              await VaultAPI.createVersion(entry.id, {
                workflow,
                custom_label: customLabelInput.value.trim() || null,
                notes: notesInput.value,
                make_current: true,
              });
            }
            controller.setDirty(false);
            await controller.refresh();
            await controller.openEntry(entry.id, "settings");
            showToast(`Saved to "${entry.name}".`, "success");
          } catch (e) {
            status.textContent = e.message;
          } finally {
            saveBtn.disabled = false;
          }
        },
      },
      ["Save to Vault"]
    );
    actions.appendChild(saveBtn);
    detailContainer.appendChild(actions);
  };

  entrySelect.addEventListener("change", renderEntryDetail);
  if (entries.length > 0) renderEntryDetail();
  else form.appendChild(el("p", { className: "wv-muted" }, ["No entries yet. Create a new entry instead."]));

  return form;
}
