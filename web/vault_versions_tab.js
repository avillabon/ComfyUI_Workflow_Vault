// Versions tab: list manual versions, save new ones from the current
// canvas, promote, overwrite, and edit notes.

import { el, formatDate, showToast, confirmDialog, formDialog } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { renderMarkdown } from "./vault_markdown.js";
import { getCurrentWorkflowJSON } from "./vault_workflow.js";
import { openVersionById } from "./vault_detail.js";

export function renderVersionsTab(controller, entry) {
  const wrap = el("div", { className: "wv-versions-tab" });

  wrap.appendChild(
    el(
      "button",
      { className: "wv-btn wv-section-action", onclick: () => saveNewVersion(controller, entry) },
      [el("i", { className: "pi pi-plus" }), "Save canvas as new version"]
    )
  );

  const versions = [...(entry.versions || [])].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

  if (versions.length === 0) {
    wrap.appendChild(el("p", { className: "wv-muted" }, ["No versions yet."]));
    return wrap;
  }

  const list = el("div", { className: "wv-version-list" });
  for (const version of versions) {
    list.appendChild(renderVersionCard(controller, entry, version));
  }
  wrap.appendChild(list);

  return wrap;
}

function renderVersionCard(controller, entry, version) {
  const isCurrent = version.id === entry.current_version_id;
  const card = el("div", { className: `wv-version-card${isCurrent ? " wv-version-current" : ""}` });

  const header = el("div", { className: "wv-version-header" });
  const label = version.custom_label ? `${version.custom_label} (${version.label})` : version.label;
  header.appendChild(el("div", { className: "wv-version-label" }, [label]));
  if (isCurrent) {
    header.appendChild(el("span", { className: "wv-status-badge wv-status-stable" }, ["Current"]));
  }
  card.appendChild(header);

  card.appendChild(
    el("div", { className: "wv-version-meta" }, [
      `Created ${formatDate(version.created_at)}`,
      version.updated_at && version.updated_at !== version.created_at ? ` · Updated ${formatDate(version.updated_at)}` : "",
    ])
  );

  if (version.notes && version.notes.trim()) {
    const notesBox = el("div", { className: "wv-markdown wv-version-notes" });
    notesBox.innerHTML = renderMarkdown(version.notes);
    card.appendChild(notesBox);
  }

  const actions = el("div", { className: "wv-version-actions" });
  actions.appendChild(
    el("button", { className: "wv-btn wv-btn-small", onclick: () => openVersionById(controller, entry, version.id) }, [
      el("i", { className: "pi pi-external-link" }),
      "Open in Graph",
    ])
  );
  actions.appendChild(
    el("button", { className: "wv-btn wv-btn-small", onclick: () => editNotes(controller, entry, version) }, [
      el("i", { className: "pi pi-pencil" }),
      "Edit Notes",
    ])
  );
  actions.appendChild(
    el("button", { className: "wv-btn wv-btn-small", onclick: () => overwriteVersion(controller, entry, version) }, [
      el("i", { className: "pi pi-refresh" }),
      "Overwrite with Canvas",
    ])
  );
  if (!isCurrent) {
    actions.appendChild(
      el("button", { className: "wv-btn wv-btn-small wv-btn-primary", onclick: () => promoteVersion(controller, entry, version) }, [
        el("i", { className: "pi pi-check" }),
        "Promote to Current",
      ])
    );
  }
  card.appendChild(actions);

  return card;
}

async function saveNewVersion(controller, entry) {
  const result = await formDialog({
    title: "Save New Version",
    message: "This saves the current canvas as a new version of this entry.",
    fields: [
      { name: "custom_label", label: "Custom label (optional)", type: "text", placeholder: "e.g. Final, Stable cut" },
      { name: "notes", label: "Notes (optional, Markdown supported)", type: "textarea" },
      { name: "make_current", label: "Set as current version", type: "checkbox", value: true },
    ],
    confirmText: "Save Version",
  });
  if (result == null) return;

  try {
    const workflow = getCurrentWorkflowJSON();
    await VaultAPI.createVersion(entry.id, {
      workflow,
      custom_label: result.custom_label || null,
      notes: result.notes || "",
      make_current: !!result.make_current,
    });
    await controller.refresh();
    showToast("Version saved.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function editNotes(controller, entry, version) {
  const result = await formDialog({
    title: "Edit Version Notes",
    fields: [{ name: "notes", label: "Notes (Markdown supported)", type: "textarea", value: version.notes || "" }],
    confirmText: "Save Notes",
  });
  if (result == null) return;
  try {
    await VaultAPI.updateVersionNotes(entry.id, version.id, result.notes || "");
    await controller.refresh();
    showToast("Notes updated.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function overwriteVersion(controller, entry, version) {
  const label = version.custom_label || version.label;
  const ok = await confirmDialog({
    title: `Overwrite "${label}" with current canvas?`,
    message: "This replaces the saved workflow for this version with the current canvas. This cannot be undone.",
    confirmText: "Overwrite",
    danger: true,
  });
  if (!ok) return;
  try {
    const workflow = getCurrentWorkflowJSON();
    await VaultAPI.overwriteVersion(entry.id, version.id, { workflow });
    await controller.refresh();
    showToast("Version overwritten.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function promoteVersion(controller, entry, version) {
  try {
    await VaultAPI.promoteVersion(entry.id, version.id);
    await controller.refresh();
    showToast(`"${version.custom_label || version.label}" is now the current version.`, "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}
