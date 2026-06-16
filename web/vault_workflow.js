// Bridges between the vault and ComfyUI's own graph serialize/load
// mechanisms. The vault never parses or validates workflow JSON itself.

import { app } from "../../scripts/app.js";

export function getCurrentWorkflowJSON() {
  const data = app.graph.serialize();
  // The vault tracks origin via its own folder structure; the runtime-only
  // marker we inject on open must not be persisted into saved snapshots
  // (otherwise a "create new entry" save would carry the source entry's id).
  if (data && data.extra && "workflow_vault" in data.extra) {
    const { workflow_vault, ...rest } = data.extra;
    data.extra = rest;
  }
  return data;
}

// The display name of the currently-active ComfyUI workflow tab, cleaned up
// for use as a default entry name. Returns "" for an unsaved/untitled tab so
// callers can fall back to an empty field rather than a meaningless default.
export function getCurrentWorkflowName() {
  try {
    const active = app.extensionManager?.workflow?.activeWorkflow;
    if (!active) return "";
    // `filename` is what ComfyUI shows on the tab; key/path are fallbacks for
    // older/newer frontends. Any of them may carry a folder prefix and a
    // trailing ".json".
    let raw = String(active.filename || active.key || active.path || "");
    raw = raw.split(/[\\/]/).pop();        // drop any directory portion
    raw = raw.replace(/\.json$/i, "");      // drop the .json extension
    raw = raw.replace(/^\*+/, "").trim();   // drop a leading "modified" marker
    if (!raw || /^unsaved workflow$/i.test(raw)) return "";
    return raw;
  } catch {
    return "";
  }
}

// The origin marker (entry/version this canvas was opened from), read straight
// off the live graph so the Save wizard can default to updating that entry.
export function getWorkflowVaultOrigin() {
  try {
    return app.graph?.serialize?.()?.extra?.workflow_vault || null;
  } catch {
    return null;
  }
}

function sanitizeName(name) {
  const cleaned = (name || "").replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned || "workflow";
}

export async function openWorkflowInGraph(workflowJson, name, origin) {
  // Open the snapshot in its OWN new tab, named after the entry, without
  // disturbing whatever the user currently has open. We create a temporary
  // (unsaved) workflow and load the snapshot into it — the same pattern
  // ComfyUI's own "duplicate workflow" uses. A hidden `extra.workflow_vault`
  // marker lets a later save recognize which entry this came from.
  const data = origin
    ? { ...workflowJson, extra: { ...(workflowJson.extra || {}), workflow_vault: origin } }
    : workflowJson;
  const wf = app.extensionManager?.workflow;
  if (wf?.createTemporary) {
    const temp = wf.createTemporary(`${sanitizeName(name)}.json`, data);
    await app.loadGraphData(data, true, true, temp);
    return;
  }
  // Fallback for older frontends without the workflow store.
  await app.loadGraphData(data);
}
