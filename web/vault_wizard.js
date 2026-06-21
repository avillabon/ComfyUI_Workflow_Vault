// "Save Current Workflow to Vault" flow: create a brand-new entry, or save
// the current canvas as a new/overwritten version of an existing entry.

import { el, clear, showToast, confirmDialog, toggleField, createProgressStatus } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { STATUS_LABELS, STATUS_ORDER, renderGenTypePicker } from "./vault_modal.js";
import { renderTagInput, tagCountsFrom } from "./vault_tag_input.js";
import { renderThumbnailField } from "./vault_thumbnail_input.js";
import { renderMediaPicker } from "./vault_media_picker.js";
import { renderNotesEditor } from "./vault_notes_editor.js";
import { getCurrentWorkflowJSON, getWorkflowVaultOrigin, getCurrentWorkflowName } from "./vault_workflow.js";

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
  let footerEl = null;
  const paintBody = () => {
    clear(body);
    if (footerEl) { footerEl.remove(); footerEl = null; }
    const form = mode === "update" ? renderUpdateForm(controller) : renderCreateForm(controller);
    body.appendChild(form);
    // The create form's footer mounts as a sibling of the scroll body so it
    // pins to the bottom without overlapping (and blocking clicks on) content.
    if (form.wizardFooter) {
      footerEl = form.wizardFooter;
      wrap.appendChild(footerEl);
    }
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
  const markDirty = () => controller.setDirty(true, {
    saveHandler: () => saveNewEntry({ openAfterSave: false }),
    discardHandler: () => controller.render(),
    dialog: {
      title: "Save workflow before leaving?",
      message: "You have unsaved new-entry changes.",
      saveText: "Save to Vault",
      discardText: "Discard",
    },
  });

  // Required-field validation. Each error renders inline under its field (and we
  // jump focus to the first problem) so the user can see exactly what's missing
  // — rather than facing a silently disabled Save button.
  const fieldErr = () => el("div", { className: "wv-field-error", style: { display: "none" }, role: "alert" });
  const nameErr = fieldErr();
  const tagErr = fieldErr();
  const statusErr = fieldErr();
  const genErr = fieldErr();
  const reqRow = (label, input, errEl) =>
    el("div", { className: "wv-form-row" }, [
      el("label", {}, [label, el("span", { className: "wv-required" }, [" *"])]),
      input,
      errEl,
    ]);

  // --- Left column: entry metadata ---
  // Default the name to the current ComfyUI tab's name (blank if the tab is
  // unsaved/untitled). The user can overwrite it before saving.
  const nameInput = el("input", { className: "wv-input", type: "text", placeholder: "Workflow name", value: getCurrentWorkflowName() });
  const descInput = el("textarea", { className: "wv-input wv-textarea", placeholder: "What does this workflow do?" });
  const tagInput = renderTagInput({
    tags: [],
    allTags: controller.state.tags || [],
    tagCounts: tagCountsFrom(controller.state.entries),
  });
  // Status starts unselected ("None") and must be chosen before saving.
  const statusSelect = el(
    "select",
    { className: "wv-input" },
    [
      el("option", { value: "", selected: true }, ["Select a status…"]),
      ...STATUS_ORDER.filter((s) => s !== "archived").map((s) => el("option", { value: s }, [STATUS_LABELS[s]])),
    ]
  );
  const genTypePicker = renderGenTypePicker([], () => { markDirty(); genErr.style.display = "none"; });
  const favSwitch = toggleField("Favorite", false, markDirty);
  const thumbField = renderThumbnailField({ currentUrl: null });
  const compareField = renderThumbnailField({ currentUrl: null, clearable: true, noun: "compare image" });

  // --- Right column inputs: version + notes ---
  const customLabelInput = el("input", { className: "wv-input", type: "text", placeholder: "e.g. Initial version" });
  const versionNotesInput = el("textarea", { className: "wv-input wv-textarea", placeholder: "Notes for this version (Markdown supported)" });

  for (const input of [nameInput, descInput, statusSelect, thumbField.fileInput, compareField.fileInput, customLabelInput, versionNotesInput]) {
    input.addEventListener("input", markDirty);
    input.addEventListener("change", markDirty);
  }
  tagInput.addEventListener("change", markDirty);

  const notesEditor = renderNotesEditor({ notes: [], onChange: markDirty });

  // Clear each field's error as soon as the user addresses it.
  nameInput.addEventListener("input", () => { nameErr.style.display = "none"; });
  statusSelect.addEventListener("change", () => { statusErr.style.display = "none"; });
  tagInput.addEventListener("change", () => { tagErr.style.display = "none"; });

  const left = el("div", { className: "wv-wizard-left" });
  left.appendChild(reqRow("Name", nameInput, nameErr));
  left.appendChild(formRow("Description", descInput));
  left.appendChild(reqRow("Tags", tagInput, tagErr));
  left.appendChild(reqRow("Status", statusSelect, statusErr));
  left.appendChild(reqRow("Generation types", genTypePicker, genErr));
  left.appendChild(el("div", { className: "wv-form-row" }, [favSwitch]));
  left.appendChild(formRow("Thumbnail (optional)", thumbField));
  left.appendChild(formRow("Compare image (optional)", compareField));

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

  function addExampleBlock(markAsDirty = true) {
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
    if (markAsDirty) markDirty();
  }

  addExampleBlock(false);
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
  const progress = createProgressStatus();
  const saveBtn = el("button", { className: "wv-btn wv-btn-primary" }, [el("i", { className: "pi pi-save" }), "Save to Vault"]);
  const setSaving = (saving) => {
    saveBtn.disabled = saving;
    saveBtn.replaceChildren(
      ...(saving ? [document.createTextNode("Saving…")] : [el("i", { className: "pi pi-save" }), document.createTextNode("Save to Vault")])
    );
  };
  async function saveNewEntry({ openAfterSave = true } = {}) {
    // Validate required fields, surfacing an inline error on each missing one
    // and jumping to the first so the user knows precisely what's needed.
    const checks = [
      [nameErr, !nameInput.value.trim(), "Name is required.", nameInput],
      [tagErr, tagInput.getTags().length === 0, "Add at least one tag.", tagInput],
      [statusErr, !statusSelect.value, "Choose a status.", statusSelect],
      [genErr, genTypePicker.getSelected().length === 0, "Select at least one generation type.", genTypePicker],
    ];
    let firstBad = null;
    for (const [errEl, bad, msg, focusEl] of checks) {
      errEl.textContent = bad ? msg : "";
      errEl.style.display = bad ? "" : "none";
      if (bad && !firstBad) firstBad = focusEl;
    }
    if (firstBad) {
      status.textContent = "Please complete the required fields.";
      firstBad.focus?.();
      firstBad.scrollIntoView?.({ block: "nearest" });
      return false;
    }
    const name = nameInput.value.trim();
    const workflow = getCurrentWorkflowJSON();
    if (countNodes(workflow) === 0) {
      status.textContent = "The canvas is empty — add nodes before saving.";
      return false;
    }
    setSaving(true);
    status.textContent = "";
    progress.reset();
    try {
      const data = {
        name,
        description: descInput.value,
        tags: tagInput.getTags(),
        status: statusSelect.value,
        generation_types: genTypePicker.getSelected(),
        favorite: favSwitch.input.checked,
        custom_label: customLabelInput.value.trim() || null,
        version_notes: versionNotesInput.value,
        notes: notesEditor.getNotes(),
        workflow,
      };

      const formData = new FormData();
      // Original source date per uploaded part, so converted files keep it.
      const mtimes = {};
      // Display thumbnail + untouched original (archival). For a video this
      // yields an animated WebP (converted server-side) or a still frame; for
      // an image, a downscaled cover. See renderThumbnailField().getUpload().
      const up = await thumbField.getUpload();
      if (up?.file) {
        formData.append("thumbnail", up.file);
        if (up.source) formData.append("thumbnail_source", up.source);
        mtimes.thumbnail = up.mtime;
        mtimes.thumbnail_source = up.mtime;
      }
      // Optional before/after compare overlay (same image/video picker).
      const cmp = await compareField.getUpload();
      if (cmp?.file) {
        formData.append("compare_image", cmp.file);
        if (cmp.source) formData.append("compare_image_source", cmp.source);
        mtimes.compare_image = cmp.mtime;
        mtimes.compare_image_source = cmp.mtime;
      }

      const examplesData = [];
      let exampleIdx = 0;
      for (const blk of exampleBlocks) {
        if (blk.picker.isEmpty()) continue;
        examplesData.push({ notes: blk.notesInput.value });
        blk.picker.getByRole("input").forEach((f, i) => {
          const name = `example_${exampleIdx}_input_${i}`;
          formData.append(name, f);
          mtimes[name] = f.lastModified;
        });
        blk.picker.getByRole("output").forEach((f, i) => {
          const name = `example_${exampleIdx}_output_${i}`;
          formData.append(name, f);
          mtimes[name] = f.lastModified;
        });
        exampleIdx++;
      }
      data.examples = examplesData;
      data.file_mtimes = mtimes;
      formData.append("data", JSON.stringify(data));

      const entry = await VaultAPI.createEntry(formData, { onProgress: (event) => progress.update(event) });
      controller.setDirty(false);
      await controller.refresh();
      if (openAfterSave) await controller.openEntry(entry.id);
      showToast(`"${entry.name}" saved to vault.`, "success");
      if (entry.skipped_files?.length) {
        showToast(`Skipped unsupported file(s): ${entry.skipped_files.join(", ")}`, "warn");
      }
      return true;
    } catch (e) {
      status.textContent = e.message;
      return false;
    } finally {
      setSaving(false);
      progress.reset();
    }
  }
  saveBtn.addEventListener("click", () => saveNewEntry({ openAfterSave: true }));

  // Exposed (not appended here) so the wizard can mount it OUTSIDE the scroll
  // body — a sticky footer inside the scroll area overlaps and steals clicks
  // from the content above it (e.g. the thumbnail dropzone).
  wrap.wizardFooter = el("div", { className: "wv-wizard-footer" }, [
    el("span", { className: "wv-wizard-footer-hint" }, [el("i", { className: "pi pi-info-circle" }), " Fields marked * are required"]),
    progress.element,
    status,
    saveBtn,
  ]);

  return wrap;
}

// ---------------------------------------------------------------------------
// Update existing entry
// ---------------------------------------------------------------------------

function renderUpdateForm(controller) {
  const form = el("div", { className: "wv-form" });
  let currentSaveHandler = null;
  const markDirty = () => controller.setDirty(true, {
    saveHandler: () => currentSaveHandler ? currentSaveHandler() : false,
    discardHandler: () => controller.render(),
    dialog: {
      title: "Save workflow update before leaving?",
      message: "You have unsaved workflow update changes.",
      saveText: "Save to Vault",
      discardText: "Discard",
    },
  });

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
      markDirty();
      newVersionFields.style.display = "";
      overwriteWarning.style.display = "none";
    });
    overwriteRadio.addEventListener("change", () => {
      if (!overwriteRadio.checked) return;
      markDirty();
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
    async function saveUpdate({ openAfterSave = true } = {}) {
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
          if (!ok) return false;
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
        if (openAfterSave) await controller.openEntry(entry.id, "settings");
        showToast(`Saved to "${entry.name}".`, "success");
        return true;
      } catch (e) {
        status.textContent = e.message;
        return false;
      } finally {
        saveBtn.disabled = false;
      }
    }
    currentSaveHandler = () => saveUpdate({ openAfterSave: false });
    const saveBtn = el(
      "button",
      {
        className: "wv-btn wv-btn-primary",
        onclick: () => saveUpdate({ openAfterSave: true }),
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
