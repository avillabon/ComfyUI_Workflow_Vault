// Examples tab: reference media (inputs/outputs) plus notes for each
// example, with simple add/edit/reorder/delete management.

import { el, videoEl, showToast, confirmDialog, promptDialog, formDialog, createProgressStatus } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { renderMarkdown } from "./vault_markdown.js";
import { renderMediaPicker, convertFlaggedMedia } from "./vault_media_picker.js";

export function renderExamplesTab(controller, entry) {
  const wrap = el("div", { className: "wv-examples-tab" });
  wrap.appendChild(renderNewExampleSlot(controller, entry));

  const examples = entry.examples || [];
  if (examples.length) {
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

// ---------------------------------------------------------------------------
// New example slot: an always-present, unsaved drop target at the top of the
// list. Nothing is persisted until media actually lands in it, so an empty
// slot never becomes a real (and therefore carousel-visible) example. A short
// debounce coalesces bursts like "Import from workflow" (which can add inputs
// and outputs in quick succession) into a single create call. A freshly-found
// H.265 file gets a much longer grace period instead — a plain 400ms would
// auto-save (and reset the slot) before the warning badge and its convert
// toggle were even visible long enough to click.
// ---------------------------------------------------------------------------

const NEW_EXAMPLE_COMMIT_DELAY = 400;
const HEVC_GRACE_DELAY = 4000;

function renderNewExampleSlot(controller, entry) {
  const card = el("div", { className: "wv-example-card wv-example-new" });
  card.appendChild(
    el("div", { className: "wv-example-header" }, [
      el("i", { className: "pi pi-plus wv-example-new-icon" }),
      el("div", { className: "wv-example-title wv-example-title-empty" }, ["New example"]),
    ])
  );

  let committing = false;
  let timer = null;
  const progress = createProgressStatus();

  async function commit() {
    if (committing || picker.isEmpty()) return;
    if (!(entry.versions || []).length) {
      showToast("This entry has no versions to attach an example to.", "error");
      return;
    }
    committing = true;
    progress.reset();
    await picker.awaitPendingProbes();
    const priorIds = new Set((entry.examples || []).map((e) => e.id));
    const inputFiles = picker.getByRole("input");
    const outputFiles = picker.getByRole("output");
    const inputFlags = picker.getConvertFlags("input");
    const outputFlags = picker.getConvertFlags("output");
    try {
      const formData = new FormData();
      const mtimes = {};
      inputFiles.forEach((f, i) => {
        formData.append(`input_${i}`, f);
        mtimes[`input_${i}`] = f.lastModified;
      });
      outputFiles.forEach((f, i) => {
        formData.append(`output_${i}`, f);
        mtimes[`output_${i}`] = f.lastModified;
      });
      formData.append("data", JSON.stringify({ file_mtimes: mtimes }));
      const result = await VaultAPI.createExample(entry.id, formData, { onProgress: (event) => progress.update(event) });
      if (result.skipped_files?.length) {
        showToast(`Skipped unsupported file(s): ${result.skipped_files.join(", ")}`, "warn");
      }
      await controller.refresh();
      const newExample = (result.examples || []).find((e) => !priorIds.has(e.id));
      if (newExample) {
        const convertedInputs = await convertFlaggedMedia(entry.id, newExample.inputs || [], inputFiles, inputFlags);
        const convertedOutputs = await convertFlaggedMedia(entry.id, newExample.outputs || [], outputFiles, outputFlags);
        if (convertedInputs || convertedOutputs) await controller.refresh();
      }
    } catch (e) {
      showToast(e.message, "error");
      committing = false;
    } finally {
      progress.reset();
    }
  }

  const picker = renderMediaPicker({
    preview: true,
    onChange: (info) => {
      if (committing) return;
      clearTimeout(timer);
      timer = setTimeout(commit, info?.longDelay ? HEVC_GRACE_DELAY : NEW_EXAMPLE_COMMIT_DELAY);
    },
  });

  card.appendChild(picker.element);
  card.appendChild(progress.element);
  card.appendChild(
    el("div", { className: "wv-example-new-note" }, [
      "Nothing is saved here until a file lands — drop, paste, or import from the workflow.",
    ])
  );
  return card;
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

    cell.appendChild(renderMediaPreview(controller, entry, item));
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

function renderMediaPreview(controller, entry, item) {
  const url = VaultAPI.mediaUrl(entry.id, item.file);
  if (item.type === "image") return el("img", { src: url, className: "wv-media-thumb", alt: item.label });
  if (item.type === "video") {
    return videoEl(
      { src: url, controls: true, className: "wv-media-thumb" },
      { convert: { entryId: entry.id, file: item.file, onConverted: () => controller.refresh() } }
    );
  }
  if (item.type === "audio") return el("audio", { src: url, controls: true, className: "wv-media-audio" });
  return el("div", { className: "wv-media-thumb wv-card-thumb-placeholder" }, ["?"]);
}

function renderAddMediaRow(controller, entry, example) {
  // Two zones, aligned under the Inputs / Outputs columns above. Dropping or
  // browsing in a zone uploads with that section's role, after a short
  // debounce (longer if the file just turned out to be H.265 — see the
  // HEVC_GRACE_DELAY comment on the new-example slot above).
  const row = el("div", { className: "wv-add-media-row wv-example-io" });

  const makeZone = (role, label) => {
    let uploading = false;
    let timer = null;
    const progress = createProgressStatus();

    async function upload() {
      if (uploading || picker.isEmpty()) return;
      uploading = true;
      progress.reset();
      await picker.awaitPendingProbes();
      const priorInputIds = new Set((example.inputs || []).map((m) => m.id));
      const priorOutputIds = new Set((example.outputs || []).map((m) => m.id));
      const inputFiles = picker.getByRole("input");
      const outputFiles = picker.getByRole("output");
      const inputFlags = picker.getConvertFlags("input");
      const outputFlags = picker.getConvertFlags("output");
      try {
        const formData = new FormData();
        const mtimes = {};
        inputFiles.forEach((f, i) => {
          formData.append(`new_input_${i}`, f);
          mtimes[`new_input_${i}`] = f.lastModified;
        });
        outputFiles.forEach((f, i) => {
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
        const updated = (result.examples || []).find((e) => e.id === example.id);
        if (updated) {
          const newInputs = (updated.inputs || []).filter((m) => !priorInputIds.has(m.id));
          const newOutputs = (updated.outputs || []).filter((m) => !priorOutputIds.has(m.id));
          const convertedInputs = await convertFlaggedMedia(entry.id, newInputs, inputFiles, inputFlags);
          const convertedOutputs = await convertFlaggedMedia(entry.id, newOutputs, outputFiles, outputFlags);
          if (convertedInputs || convertedOutputs) await controller.refresh();
        }
      } catch (e) {
        showToast(e.message, "error");
        uploading = false;
      } finally {
        progress.reset();
      }
    }

    const picker = renderMediaPicker({
      role,
      label,
      onChange: (info) => {
        if (uploading) return;
        clearTimeout(timer);
        timer = setTimeout(upload, info?.longDelay ? HEVC_GRACE_DELAY : NEW_EXAMPLE_COMMIT_DELAY);
      },
    });
    return el("div", { className: "wv-example-io-col" }, [picker.element, progress.element]);
  };

  row.appendChild(makeZone("input", "Drag inputs here, paste, or"));
  row.appendChild(makeZone("output", "Drag outputs here, paste, or"));
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
