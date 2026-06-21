// Examples tab: reference media (inputs/outputs) plus notes for each
// example, with simple add/edit/reorder/delete management.

import { el, clear, showToast, confirmDialog, promptDialog, formDialog, createProgressStatus } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { renderMarkdown } from "./vault_markdown.js";
import { renderMediaPicker } from "./vault_media_picker.js";

export function renderExamplesTab(controller, entry) {
  const wrap = el("div", { className: "wv-examples-tab" });

  const addFormContainer = el("div", { className: "wv-add-example-form" });
  addFormContainer.style.display = "none";

  const toggleBtn = el(
    "button",
    {
      className: "wv-btn wv-section-action",
      onclick: async () => {
        if (addFormContainer.style.display === "none") {
          clear(addFormContainer);
          addFormContainer.appendChild(
            renderAddExampleForm(controller, entry, () => {
              addFormContainer.style.display = "none";
              clear(addFormContainer);
            })
          );
          addFormContainer.style.display = "";
        } else {
          const proceed = await controller.checkDirty();
          if (!proceed) return;
          controller.setDirty(false);
          addFormContainer.style.display = "none";
          clear(addFormContainer);
        }
      },
    },
    [el("i", { className: "pi pi-plus" }), "Add example"]
  );
  wrap.appendChild(toggleBtn);
  wrap.appendChild(addFormContainer);

  const examples = entry.examples || [];
  if (examples.length === 0) {
    wrap.appendChild(el("p", { className: "wv-muted" }, ["No examples yet."]));
  } else {
    const listEl = el("div", { className: "wv-examples-list" });
    examples.forEach((example, idx) => {
      listEl.appendChild(renderExampleCard(controller, entry, example, idx, examples.length));
    });
    wrap.appendChild(listEl);
  }

  return wrap;
}

// Reorder example cards with up/down arrows. (Media *within* an example still
// uses drag — see enableExampleMediaDnd — but whole-card moves are explicit.)
async function moveExample(controller, entry, example, direction) {
  const ids = (entry.examples || []).map((e) => e.id);
  const idx = ids.indexOf(example.id);
  const swap = idx + direction;
  if (idx < 0 || swap < 0 || swap >= ids.length) return;
  [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
  try {
    await VaultAPI.reorderExamples(entry.id, ids);
    await controller.refresh();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function formRow(label, input) {
  return el("div", { className: "wv-form-row" }, [el("label", {}, [label]), input]);
}

// ---------------------------------------------------------------------------
// Add example
// ---------------------------------------------------------------------------

function renderAddExampleForm(controller, entry, onClose) {
  const form = el("div", { className: "wv-form wv-inline-form" });
  const closeCleanly = () => {
    controller.setDirty(false);
    onClose();
  };
  const markDirty = () => controller.setDirty(true, {
    saveHandler: () => saveExample({ closeAfterSave: false }),
    discardHandler: onClose,
    dialog: {
      title: "Save example before leaving?",
      message: "You have an unsaved example.",
      saveText: "Create example",
      discardText: "Discard",
    },
  });

  const titleInput = el("input", { className: "wv-input", type: "text", placeholder: "Title (optional)" });
  const notesInput = el("textarea", { className: "wv-input wv-textarea", placeholder: "Notes (optional, Markdown supported)" });
  const picker = renderMediaPicker({ preview: true, onChange: markDirty });
  titleInput.addEventListener("input", markDirty);
  notesInput.addEventListener("input", markDirty);

  form.appendChild(formRow("Title", titleInput));
  form.appendChild(formRow("Notes", notesInput));
  form.appendChild(formRow("Media", picker.element));

  const actions = el("div", { className: "wv-form-actions" });
  const progress = createProgressStatus();
  const createBtn = el(
    "button",
    {
      className: "wv-btn wv-btn-primary",
      onclick: () => saveExample({ closeAfterSave: true }),
    },
    ["Create Example"]
  );
  async function saveExample({ closeAfterSave = true } = {}) {
    if (!(entry.versions || []).length) {
      showToast("This entry has no versions to attach an example to.", "error");
      return false;
    }
    createBtn.disabled = true;
    progress.reset();
    try {
      const formData = new FormData();
      const mtimes = {};
      picker.getByRole("input").forEach((f, i) => {
        formData.append(`input_${i}`, f);
        mtimes[`input_${i}`] = f.lastModified;
      });
      picker.getByRole("output").forEach((f, i) => {
        formData.append(`output_${i}`, f);
        mtimes[`output_${i}`] = f.lastModified;
      });
      formData.append(
        "data",
        JSON.stringify({
          title: titleInput.value,
          notes: notesInput.value,
          file_mtimes: mtimes,
        })
      );
      const result = await VaultAPI.createExample(entry.id, formData, { onProgress: (event) => progress.update(event) });
      controller.setDirty(false);
      await controller.refresh();
      showToast("Example added.", "success");
      if (result.skipped_files?.length) {
        showToast(`Skipped unsupported file(s): ${result.skipped_files.join(", ")}`, "warn");
      }
      if (closeAfterSave) closeCleanly();
      return true;
    } catch (e) {
      showToast(e.message, "error");
      return false;
    } finally {
      createBtn.disabled = false;
      progress.reset();
    }
  }
  actions.appendChild(createBtn);
  actions.appendChild(progress.element);
  actions.appendChild(el("button", { className: "wv-btn", onclick: closeCleanly }, ["Cancel"]));
  form.appendChild(actions);

  return form;
}

// ---------------------------------------------------------------------------
// Example card
// ---------------------------------------------------------------------------

function renderExampleCard(controller, entry, example, idx, total) {
  const card = el("div", { className: "wv-example-card" });
  card.dataset.exampleId = example.id;

  const header = el("div", { className: "wv-example-header" });
  const reorder = el("div", { className: "wv-example-reorder" });
  reorder.appendChild(
    el("button", { className: "wv-icon-btn", title: "Move up", "aria-label": "Move example up", disabled: idx === 0, onclick: () => moveExample(controller, entry, example, -1) }, [el("i", { className: "pi pi-chevron-up" })])
  );
  reorder.appendChild(
    el("button", { className: "wv-icon-btn", title: "Move down", "aria-label": "Move example down", disabled: idx === total - 1, onclick: () => moveExample(controller, entry, example, 1) }, [el("i", { className: "pi pi-chevron-down" })])
  );
  header.appendChild(reorder);
  const hasTitle = !!(example.title && example.title.trim());
  header.appendChild(
    el(
      "div",
      {
        className: `wv-example-title${hasTitle ? "" : " wv-example-title-empty"}`,
        title: "Click to rename",
        role: "button",
        tabindex: "0",
        onclick: () => editExample(controller, entry, example),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); editExample(controller, entry, example); } },
      },
      [hasTitle ? example.title : "Untitled example"]
    )
  );

  header.appendChild(el("div", { className: "wv-topbar-spacer" }));
  header.appendChild(
    el("button", { className: "wv-icon-btn", title: "Edit example", onclick: () => editExample(controller, entry, example) }, [
      el("i", { className: "pi pi-pencil" }),
    ])
  );
  header.appendChild(
    el("button", { className: "wv-icon-btn wv-icon-btn-danger", title: "Delete example", onclick: () => deleteExampleAction(controller, entry, example) }, [
      el("i", { className: "pi pi-trash" }),
    ])
  );
  card.appendChild(header);

  if (example.notes && example.notes.trim()) {
    const notesBox = el("div", { className: "wv-markdown" });
    notesBox.innerHTML = renderMarkdown(example.notes);
    card.appendChild(notesBox);
  }

  // Always reserve both halves (Inputs left, Outputs right). The grids are
  // shared drop targets so media can be dragged within or between sections.
  const inputsGrid = renderMediaGrid(controller, entry, example, "inputs", "No inputs yet");
  const outputsGrid = renderMediaGrid(controller, entry, example, "outputs", "No outputs yet");
  enableExampleMediaDnd(controller, entry, example, inputsGrid, outputsGrid);
  card.appendChild(
    el("div", { className: "wv-example-io" }, [
      el("div", { className: "wv-example-io-col" }, [el("h4", {}, ["Inputs"]), inputsGrid]),
      el("div", { className: "wv-example-io-col" }, [el("h4", {}, ["Outputs"]), outputsGrid]),
    ])
  );

  card.appendChild(renderAddMediaRow(controller, entry, example));

  return card;
}

function renderMediaGrid(controller, entry, example, key, emptyLabel) {
  const items = example[key] || [];
  const grid = el("div", { className: "wv-media-grid" });
  grid.dataset.role = key;
  items.forEach((item, idx) => {
    const cell = el("div", { className: "wv-media-cell" });
    cell.dataset.mediaId = item.id;

    cell.addEventListener("dragstart", (e) => {
      cell.classList.add("wv-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.id || "");
    });
    cell.addEventListener("dragend", () => {
      cell.classList.remove("wv-dragging");
      cell.draggable = false;
    });

    cell.appendChild(renderMediaPreview(entry, item));
    cell.appendChild(el("div", { className: "wv-media-label" }, [item.label]));

    const controls = el("div", { className: "wv-media-controls" });
    const handle = el("span", { className: "wv-media-drag-handle", title: "Drag to reorder or move between Inputs/Outputs", "aria-label": "Drag to reorder or move" }, [el("i", { className: "pi pi-bars" })]);
    handle.addEventListener("mousedown", () => { cell.draggable = true; });
    handle.addEventListener("mouseup", () => { cell.draggable = false; });
    controls.appendChild(handle);
    controls.appendChild(el("div", { className: "wv-topbar-spacer" }));
    controls.appendChild(
      el("button", { className: "wv-icon-btn", title: "Rename", "aria-label": "Rename media", onclick: () => renameMedia(controller, entry, example, key, idx) }, [el("i", { className: "pi pi-pencil" })])
    );
    controls.appendChild(
      el("button", { className: "wv-icon-btn wv-icon-btn-danger", title: "Delete", "aria-label": "Delete media", onclick: () => deleteMedia(controller, entry, example, key, idx) }, [el("i", { className: "pi pi-trash" })])
    );
    cell.appendChild(controls);

    grid.appendChild(cell);
  });
  if (!items.length) grid.appendChild(el("div", { className: "wv-example-io-empty" }, [emptyLabel]));
  return grid;
}

// Drag media within a section to reorder, or across sections to change its
// role (input <-> output). Both grids share one drag system.
function enableExampleMediaDnd(controller, entry, example, inputsGrid, outputsGrid) {
  const getAfter = (grid, x, y) => {
    const cells = [...grid.querySelectorAll(".wv-media-cell:not(.wv-dragging)")];
    for (const cell of cells) {
      const b = cell.getBoundingClientRect();
      if (y < b.top + b.height / 2 || (y < b.bottom && x < b.left + b.width / 2)) return cell;
    }
    return null;
  };

  const persist = () => {
    const byId = new Map();
    for (const role of ["inputs", "outputs"]) {
      for (const it of example[role] || []) byId.set(it.id, it);
    }
    const specs = (grid) =>
      [...grid.querySelectorAll(".wv-media-cell")]
        .map((c) => byId.get(c.dataset.mediaId))
        .filter(Boolean)
        .map((it) => ({ id: it.id, label: it.label }));
    applyMediaLayout(controller, entry, example, specs(inputsGrid), specs(outputsGrid));
  };

  for (const grid of [inputsGrid, outputsGrid]) {
    grid.addEventListener("dragover", (e) => {
      const dragging = document.querySelector(".wv-media-cell.wv-dragging");
      if (!dragging) return;
      e.preventDefault();
      const after = getAfter(grid, e.clientX, e.clientY);
      if (after == null) grid.appendChild(dragging);
      else if (after !== dragging) grid.insertBefore(dragging, after);
    });
    grid.addEventListener("drop", (e) => {
      if (!document.querySelector(".wv-media-cell.wv-dragging")) return;
      e.preventDefault();
      persist();
    });
  }
}

function renderMediaPreview(entry, item) {
  const url = VaultAPI.mediaUrl(entry.id, item.file);
  if (item.type === "image") return el("img", { src: url, className: "wv-media-thumb", alt: item.label });
  if (item.type === "video") return el("video", { src: url, controls: true, className: "wv-media-thumb" });
  if (item.type === "audio") return el("audio", { src: url, controls: true, className: "wv-media-audio" });
  return el("div", { className: "wv-media-thumb wv-card-thumb-placeholder" }, ["?"]);
}

function renderAddMediaRow(controller, entry, example) {
  // Two zones, aligned under the Inputs / Outputs columns above. Dropping or
  // browsing in a zone uploads straight away with that section's role.
  const row = el("div", { className: "wv-add-media-row wv-example-io" });

  const makeZone = (role, label) => {
    let uploading = false;
    const progress = createProgressStatus();
    const picker = renderMediaPicker({
      role,
      label,
      onChange: async () => {
        if (uploading || picker.isEmpty()) return;
        uploading = true;
        progress.reset();
        try {
          const formData = new FormData();
          const mtimes = {};
          picker.getByRole("input").forEach((f, i) => {
            formData.append(`new_input_${i}`, f);
            mtimes[`new_input_${i}`] = f.lastModified;
          });
          picker.getByRole("output").forEach((f, i) => {
            formData.append(`new_output_${i}`, f);
            mtimes[`new_output_${i}`] = f.lastModified;
          });
          formData.append("data", JSON.stringify({ file_mtimes: mtimes }));
          const result = await VaultAPI.updateExample(entry.id, example.id, formData, { onProgress: (event) => progress.update(event) });
          showToast("Media added.", "success");
          if (result.skipped_files?.length) {
            showToast(`Skipped unsupported file(s): ${result.skipped_files.join(", ")}`, "warn");
          }
          await controller.refresh();
        } catch (e) {
          showToast(e.message, "error");
          uploading = false;
        } finally {
          progress.reset();
        }
      },
    });
    return el("div", { className: "wv-example-io-col" }, [picker.element, progress.element]);
  };

  row.appendChild(makeZone("input", "Drag inputs here, or"));
  row.appendChild(makeZone("output", "Drag outputs here, or"));
  return row;
}

// ---------------------------------------------------------------------------
// Per-example actions
// ---------------------------------------------------------------------------

async function applyMediaSpecs(controller, entry, example, key, items) {
  const specs = items.map((item) => ({ id: item.id, label: item.label }));
  const formData = new FormData();
  formData.append("data", JSON.stringify({ [key]: specs }));
  try {
    await VaultAPI.updateExample(entry.id, example.id, formData);
    await controller.refresh();
  } catch (e) {
    showToast(e.message, "error");
  }
}

// Persist the full inputs/outputs layout at once (used by drag, which can move
// items between the two sections).
async function applyMediaLayout(controller, entry, example, inputs, outputs) {
  const formData = new FormData();
  formData.append("data", JSON.stringify({ inputs, outputs }));
  try {
    await VaultAPI.updateExample(entry.id, example.id, formData);
    await controller.refresh();
  } catch (e) {
    showToast(e.message, "error");
    controller.render();
  }
}

async function renameMedia(controller, entry, example, key, idx) {
  const items = [...(example[key] || [])];
  const newLabel = await promptDialog({ title: "Rename Media", defaultValue: items[idx].label });
  if (newLabel == null) return;
  items[idx] = { ...items[idx], label: newLabel.trim() || items[idx].label };
  await applyMediaSpecs(controller, entry, example, key, items);
}

async function deleteMedia(controller, entry, example, key, idx) {
  const ok = await confirmDialog({
    title: "Delete this file?",
    message: "This file will be removed from the example and moved to your system Trash/Recycle Bin where supported.",
    confirmText: "Delete",
    danger: true,
  });
  if (!ok) return;
  const items = [...(example[key] || [])];
  items.splice(idx, 1);
  await applyMediaSpecs(controller, entry, example, key, items);
}

async function editExample(controller, entry, example) {
  const result = await formDialog({
    title: "Edit Example",
    fields: [
      { name: "title", label: "Title", type: "text", value: example.title || "" },
      { name: "notes", label: "Notes", type: "textarea", value: example.notes || "" },
    ],
    confirmText: "Save",
  });
  if (result == null) return;
  try {
    const formData = new FormData();
    formData.append("data", JSON.stringify(result));
    await VaultAPI.updateExample(entry.id, example.id, formData);
    await controller.refresh();
    showToast("Example updated.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function deleteExampleAction(controller, entry, example) {
  const ok = await confirmDialog({
    title: `Delete example "${example.title || example.label}"?`,
    message: "This removes the example and moves its media folder to your system Trash/Recycle Bin where supported.",
    confirmText: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await VaultAPI.deleteExample(entry.id, example.id);
    await controller.refresh();
    showToast("Example deleted.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}
