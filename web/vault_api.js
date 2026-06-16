// Thin client for the Workflow Vault backend REST API.

import { api } from "../../scripts/api.js";

async function handle(resp) {
  if (!resp.ok) {
    let payload = {};
    try {
      payload = await resp.json();
    } catch {
      // ignore non-JSON error bodies
    }
    const err = new Error(payload.error || `Request failed (${resp.status})`);
    err.status = resp.status;
    err.data = payload;
    throw err;
  }
  return resp.json();
}

function getJSON(route) {
  return api.fetchApi(route).then(handle);
}

function postJSON(route, body) {
  return api
    .fetchApi(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    })
    .then(handle);
}

function postForm(route, formData) {
  return api.fetchApi(route, { method: "POST", body: formData }).then(handle);
}

export const VaultAPI = {
  getState: () => getJSON("/workflow-vault/state"),
  getSettings: () => getJSON("/workflow-vault/settings"),
  postSettings: (body) => postJSON("/workflow-vault/settings", body),
  browseFolder: () => postJSON("/workflow-vault/browse-folder", {}),
  compressExamples: () => postJSON("/workflow-vault/compress-examples", {}),
  initialize: (vaultRoot) => postJSON("/workflow-vault/initialize", { vault_root: vaultRoot }),

  createEntry: (formData) => postForm("/workflow-vault/entries", formData),
  updateEntryMetadata: (entryId, formData) =>
    postForm(`/workflow-vault/entries/${encodeURIComponent(entryId)}/metadata`, formData),
  archiveEntry: (entryId, body) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/archive`, body),
  deleteEntry: (entryId) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/delete`, {}),
  openEntryFolder: (entryId) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/open-folder`, {}),
  revealMedia: (entryId, relPath) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/reveal-media`, { path: relPath }),

  createVersion: (entryId, body) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/versions`, body),
  overwriteVersion: (entryId, versionId, body) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/versions/${encodeURIComponent(versionId)}/overwrite`, body),
  promoteVersion: (entryId, versionId) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/versions/${encodeURIComponent(versionId)}/promote`, {}),
  updateVersionNotes: (entryId, versionId, notes) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/versions/${encodeURIComponent(versionId)}`, { notes }),
  getVersionWorkflow: (entryId, versionId) =>
    getJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/versions/${encodeURIComponent(versionId)}/workflow`),

  createExample: (entryId, formData) =>
    postForm(`/workflow-vault/entries/${encodeURIComponent(entryId)}/examples`, formData),
  updateExample: (entryId, exampleId, formData) =>
    postForm(`/workflow-vault/entries/${encodeURIComponent(entryId)}/examples/${encodeURIComponent(exampleId)}`, formData),
  deleteExample: (entryId, exampleId) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/examples/${encodeURIComponent(exampleId)}/delete`, {}),
  reorderExamples: (entryId, order) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/examples/reorder`, { order }),

  renameTag: (from, to) => postJSON("/workflow-vault/tags/rename", { from, to }),
  deleteTag: (tag) => postJSON("/workflow-vault/tags/delete", { tag }),

  createFolder: (body) => postJSON("/workflow-vault/folders", body),
  updateFolder: (folderId, body) => postJSON(`/workflow-vault/folders/${encodeURIComponent(folderId)}`, body),
  deleteFolder: (folderId) => postJSON(`/workflow-vault/folders/${encodeURIComponent(folderId)}/delete`, {}),

  mediaUrl: (entryId, relPath) => {
    const route = `/workflow-vault/media?entry_id=${encodeURIComponent(entryId)}&path=${encodeURIComponent(relPath)}`;
    return typeof api.apiURL === "function" ? api.apiURL(route) : route;
  },

  exportUrl: (entryId) => {
    const route = `/workflow-vault/entries/${encodeURIComponent(entryId)}/export`;
    return typeof api.apiURL === "function" ? api.apiURL(route) : route;
  },
};
