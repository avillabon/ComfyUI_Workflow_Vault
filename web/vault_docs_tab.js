// Notes & Files tab. Notes keep their existing save flow; files are copied
// immediately into the entry so the originals remain recoverable.

import { el, showToast, confirmDialog, promptDialog, formatBytes } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { renderNotesEditor } from "./vault_notes_editor.js";

export function renderDocsTab(controller, entry) {
  const wrap = el("div", { className: "wv-docs-tab" });

  const statusEl = el("span", { className: "wv-doc-status" });
  const updateStatus = () => {
    if (controller.isDirty) {
      statusEl.className = "wv-doc-status wv-doc-status-dirty";
      statusEl.replaceChildren(el("i", { className: "pi pi-circle-fill" }), document.createTextNode("Unsaved changes"));
    } else {
      statusEl.className = "wv-doc-status";
      statusEl.replaceChildren(el("i", { className: "pi pi-check" }), document.createTextNode("All changes saved"));
    }
  };

  let saveBtn = null;
  const saveNotes = async () => {
    if (saveBtn) saveBtn.disabled = true;
    try {
      const formData = new FormData();
      formData.append("data", JSON.stringify({ notes: editor.getNotes() }));
      await VaultAPI.updateEntryMetadata(entry.id, formData);
      controller.setDirty(false);
      await controller.refresh();
      showToast("Notes saved.", "success");
      return true;
    } catch (err) {
      showToast(err.message, "error");
      return false;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  };
  const markDirty = () => {
    controller.setDirty(true, {
      saveHandler: saveNotes,
      discardHandler: () => controller.render(),
      dialog: {
        title: "Save notes before leaving?",
        message: "You have unsaved note changes.",
        saveText: "Save notes",
        discardText: "Discard",
      },
    });
    updateStatus();
  };
  const editor = renderNotesEditor({
    notes: entry.notes,
    onChange: markDirty,
  });
  wrap.appendChild(editor);

  const footer = el("div", { className: "wv-doc-footer" });
  footer.appendChild(statusEl);
  const actions = el("div", { className: "wv-doc-footer-actions" });
  actions.appendChild(
    el("button", { className: "wv-btn", onclick: () => { controller.setDirty(false); controller.render(); } }, ["Discard changes"])
  );
  saveBtn = el(
    "button",
    {
      className: "wv-btn wv-btn-primary",
      onclick: saveNotes,
    },
    [el("i", { className: "pi pi-save" }), "Save notes"]
  );
  actions.appendChild(saveBtn);
  footer.appendChild(actions);
  wrap.appendChild(footer);

  const files = el("section", { className: "wv-attachments" });
  const input = el("input", { type: "file", multiple: true, className: "wv-attachment-input", "aria-label": "Add files" });
  const progress = el("span", { className: "wv-muted wv-attachment-progress", role: "status" });
  const addBtn = el("button", { type: "button", className: "wv-btn", onclick: () => input.click() }, [
    el("i", { className: "pi pi-paperclip" }), "Add files",
  ]);
  input.addEventListener("change", async () => {
    const selected = Array.from(input.files || []);
    input.value = "";
    if (!selected.length || !await controller.checkDirty()) return;
    addBtn.disabled = true;
    let saved = 0;
    try {
      for (const file of selected) {
        if (!file.size || file.size > 2 * 1024 ** 3) {
          showToast(`${file.name}: Files must be nonempty and no larger than 2 GiB.`, "error");
          continue;
        }
        progress.textContent = `Adding ${file.name} (${saved + 1} of ${selected.length})…`;
        try {
          await VaultAPI.addAttachment(entry.id, file, {
            onProgress: ({ phase, percent }) => {
              progress.textContent = `${phase === "processing" ? "Saving" : "Uploading"} ${file.name}${percent == null ? "" : ` · ${percent}%`}`;
            },
          });
          saved++;
        } catch (err) {
          showToast(`${file.name}: ${err.message}`, "error");
        }
      }
      if (saved) {
        await controller.refresh();
        showToast(`Added ${saved} ${saved === 1 ? "file" : "files"}.`, "success");
      }
    } finally {
      progress.textContent = "";
      addBtn.disabled = false;
    }
  });

  files.appendChild(el("div", { className: "wv-attachments-header" }, [
    el("div", {}, [
      el("h3", {}, ["Files"]),
      el("p", { className: "wv-muted" }, ["Keep original ZIPs, custom nodes, and other files with this entry."]),
    ]),
    el("div", { className: "wv-attachment-add" }, [progress, addBtn, input]),
  ]));

  const attachments = entry.attachments || [];
  if (!attachments.length) {
    files.appendChild(el("p", { className: "wv-attachments-empty" }, ["No files attached yet."]));
  } else {
    const list = el("div", { className: "wv-attachments-list" });
    for (const attachment of attachments) {
      const name = attachment.name || "File";
      const row = el("div", { className: "wv-attachment-row" });
      const info = el("div", { className: "wv-attachment-info" }, [
        el("div", { className: "wv-attachment-name" }, [el("i", { className: "pi pi-file" }), name]),
        el("div", { className: "wv-muted wv-attachment-meta" }, [formatBytes(attachment.size || 0)]),
        attachment.note ? el("div", { className: "wv-attachment-note" }, [attachment.note]) : null,
      ]);
      const actions = el("div", { className: "wv-attachment-actions" }, [
        el("a", { className: "wv-btn wv-btn-small", href: VaultAPI.attachmentUrl(entry.id, attachment.id), download: name }, [
          el("i", { className: "pi pi-download" }), "Save as",
        ]),
        el("button", { type: "button", className: "wv-icon-btn", title: "Edit file note", "aria-label": `Edit note for ${name}`, onclick: async () => {
          if (!await controller.checkDirty()) return;
          const note = await promptDialog({ title: `Note for ${name}`, message: "What is this file for?", defaultValue: attachment.note || "", confirmText: "Save note" });
          if (note == null) return;
          try {
            await VaultAPI.updateAttachmentNote(entry.id, attachment.id, note);
            await controller.refresh();
            showToast("File note saved.", "success");
          } catch (err) { showToast(err.message, "error"); }
        } }, [el("i", { className: "pi pi-pencil" })]),
        el("button", { type: "button", className: "wv-icon-btn wv-icon-btn-danger", title: "Remove file", "aria-label": `Remove ${name}`, onclick: async () => {
          if (!await controller.checkDirty()) return;
          const ok = await confirmDialog({ title: `Remove ${name}?`, message: "The file will be removed from this entry and sent to your system trash where available.", confirmText: "Remove file", danger: true });
          if (!ok) return;
          try {
            await VaultAPI.deleteAttachment(entry.id, attachment.id);
            await controller.refresh();
            showToast("File removed.", "success");
          } catch (err) { showToast(err.message, "error"); }
        } }, [el("i", { className: "pi pi-trash" })]),
      ]);
      row.append(info, actions);
      list.appendChild(row);
    }
    files.appendChild(list);
  }
  wrap.appendChild(files);

  updateStatus();
  return wrap;
}
