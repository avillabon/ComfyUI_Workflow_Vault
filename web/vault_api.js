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

function postForm(route, formData, options = {}) {
  if (typeof options.onProgress !== "function") {
    return api.fetchApi(route, { method: "POST", body: formData }).then(handle);
  }
  return postFormWithProgress(route, formData, options.onProgress);
}

function postFormWithProgress(route, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = typeof api.apiURL === "function" ? api.apiURL(route) : route;
    xhr.open("POST", url, true);
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress({ phase: "upload", loaded: event.loaded, total: event.total, percent: Math.round((event.loaded / event.total) * 100) });
      } else {
        onProgress({ phase: "upload", loaded: event.loaded, total: 0, percent: null });
      }
    };
    xhr.upload.onload = () => onProgress({ phase: "processing", percent: 100 });
    xhr.onload = () => {
      let payload = {};
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        payload = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      const err = new Error(payload.error || `Request failed (${xhr.status})`);
      err.status = xhr.status;
      err.data = payload;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("Upload failed."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    onProgress({ phase: "starting", percent: 0 });
    xhr.send(formData);
  });
}

export const VaultAPI = {
  getState: () => getJSON("/workflow-vault/state"),
  getSettings: () => getJSON("/workflow-vault/settings"),
  postSettings: (body) => postJSON("/workflow-vault/settings", body),
  browseFolder: () => postJSON("/workflow-vault/browse-folder", {}),
  getFootprint: () => getJSON("/workflow-vault/footprint"),
  getHealth: () => getJSON("/workflow-vault/health"),
  cleanupStaging: () => postJSON("/workflow-vault/health/cleanup-staging", {}),
  compressExamples: () => postJSON("/workflow-vault/compress-examples", {}),
  initialize: (vaultRoot) => postJSON("/workflow-vault/initialize", { vault_root: vaultRoot }),

  createEntry: (formData, options) => postForm("/workflow-vault/entries", formData, options),
  updateEntryMetadata: (entryId, formData, options) =>
    postForm(`/workflow-vault/entries/${encodeURIComponent(entryId)}/metadata`, formData, options),
  archiveEntry: (entryId, body) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/archive`, body),
  deleteEntry: (entryId) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/delete`, {}),
  duplicateEntry: (entryId, name) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/duplicate`, { name }),
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

  versionWorkflowUrl: (entryId, versionId) => {
    const route = `/workflow-vault/entries/${encodeURIComponent(entryId)}/versions/${encodeURIComponent(versionId)}/workflow`;
    return typeof api.apiURL === "function" ? api.apiURL(route) : route;
  },

  createExample: (entryId, formData, options) =>
    postForm(`/workflow-vault/entries/${encodeURIComponent(entryId)}/examples`, formData, options),
  updateExample: (entryId, exampleId, formData, options) =>
    postForm(`/workflow-vault/entries/${encodeURIComponent(entryId)}/examples/${encodeURIComponent(exampleId)}`, formData, options),
  deleteExample: (entryId, exampleId) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/examples/${encodeURIComponent(exampleId)}/delete`, {}),
  reorderExamples: (entryId, order) =>
    postJSON(`/workflow-vault/entries/${encodeURIComponent(entryId)}/examples/reorder`, { order }),

  renameTag: (from, to) => postJSON("/workflow-vault/tags/rename", { from, to }),
  deleteTag: (tag) => postJSON("/workflow-vault/tags/delete", { tag }),

  // Folders are deprecated (the vault is tag-first). The only supported folder
  // action is the explicit one-time conversion of legacy folder paths to tags.
  convertFoldersToTags: (tags) => postJSON("/workflow-vault/convert-folders-to-tags", tags ? { tags } : {}),

  mediaUrl: (entryId, relPath, version) => {
    // `version` is an optional cache-buster: thumbnails keep a stable filename
    // (cover.webp), so without it the browser shows a stale cached image after
    // the file is replaced. Passing the entry's updated_at forces a refetch.
    let route = `/workflow-vault/media?entry_id=${encodeURIComponent(entryId)}&path=${encodeURIComponent(relPath)}`;
    if (version) route += `&v=${encodeURIComponent(version)}`;
    return typeof api.apiURL === "function" ? api.apiURL(route) : route;
  },

  exportUrl: (entryId) => {
    const route = `/workflow-vault/entries/${encodeURIComponent(entryId)}/export`;
    return typeof api.apiURL === "function" ? api.apiURL(route) : route;
  },

  exportVaultUrl: () => {
    const route = "/workflow-vault/export";
    return typeof api.apiURL === "function" ? api.apiURL(route) : route;
  },
};
