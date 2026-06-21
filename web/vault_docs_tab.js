// Notes tab: a dynamic set of notes (segmented subtabs) saved together into a
// single notes.json. The editor itself is the shared renderNotesEditor; this
// module just wires it to the entry's save flow and dirty state.

import { el, showToast } from "./vault_dom.js";
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

  updateStatus();
  return wrap;
}
