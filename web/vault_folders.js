// Folder tree data helpers, sidebar tree rendering, and folder CRUD dialogs.

import { VaultAPI } from "./vault_api.js";
import { el, clear, showToast, promptDialog, confirmDialog, formDialog, onActivate } from "./vault_dom.js";

export function findFolder(folders, folderId) {
  return (folders || []).find((f) => f.id === folderId) || null;
}

export function getDescendantIds(folders, folderId) {
  const result = new Set();
  const stack = [folderId];
  while (stack.length) {
    const fid = stack.pop();
    for (const f of folders) {
      if (f.parent_id === fid && !result.has(f.id)) {
        result.add(f.id);
        stack.push(f.id);
      }
    }
  }
  return result;
}

export function folderPath(folders, folderId) {
  const byId = new Map((folders || []).map((f) => [f.id, f]));
  const path = [];
  let current = byId.get(folderId);
  while (current) {
    path.unshift(current);
    current = byId.get(current.parent_id);
  }
  return path;
}

export function buildFolderTree(folders) {
  const byId = new Map((folders || []).map((f) => [f.id, { ...f, children: [] }]));
  const roots = [];
  for (const f of byId.values()) {
    if (f.parent_id && byId.has(f.parent_id)) {
      byId.get(f.parent_id).children.push(f);
    } else {
      roots.push(f);
    }
  }
  const sortRec = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

/** Flat list of {id, label, depth} for use in a <select>, excluding excludeIds. */
export function folderSelectOptions(folders, excludeIds = new Set()) {
  const tree = buildFolderTree(folders.filter((f) => !excludeIds.has(f.id)));
  const options = [{ value: "", label: "(No parent / root)" }];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      options.push({ value: n.id, label: `${"— ".repeat(depth)}${n.name}` });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return options;
}

/**
 * Renders a folder <select> that includes a "Create new folder…" option.
 * `folders` should be the live controller.state.folders array (mutated in
 * place when a folder is created so other UI stays in sync). Fires a native
 * "change" event when the selection changes, including after a new folder
 * is created and auto-selected.
 */
export function renderFolderSelect({ folders, selectedId = "", excludeIds } = {}) {
  let current = selectedId || "";

  const select = el("select", { className: "wv-input" });

  const populate = () => {
    clear(select);
    for (const o of folderSelectOptions(folders, excludeIds)) {
      select.appendChild(el("option", { value: o.value, selected: o.value === current }, [o.label]));
    }
    select.appendChild(el("option", { value: "__new__" }, ["+ Create new folder…"]));
  };
  populate();

  select.addEventListener("change", async () => {
    if (select.value !== "__new__") {
      current = select.value;
      return;
    }
    const name = await promptDialog({ title: "New Folder", message: "Folder name", placeholder: "Folder name" });
    if (!name || !name.trim()) {
      select.value = current;
      return;
    }
    try {
      const result = await VaultAPI.createFolder({ name: name.trim(), parent_id: null });
      folders.length = 0;
      folders.push(...result.folders);
      current = result.folder.id;
      populate();
      showToast("Folder created.", "success");
      select.dispatchEvent(new Event("change"));
    } catch (e) {
      showToast(e.message, "error");
      select.value = current;
    }
  });

  return select;
}

/** Count entries (recursively, including subfolders) assigned to a folder. */
export function countEntriesInFolder(state, folderId) {
  const descendants = getDescendantIds(state.folders, folderId);
  descendants.add(folderId);
  return (state.entries || []).filter((e) => e.folder_id && descendants.has(e.folder_id)).length;
}

// ---------------------------------------------------------------------------
// Sidebar tree rendering
// ---------------------------------------------------------------------------

export function renderFolderTree(container, controller) {
  const { state, filters } = controller;
  const folders = state.folders || [];

  const header = el("div", { className: "wv-sidebar-heading-row" }, [
    el("div", { className: "wv-sidebar-heading" }, ["Folders"]),
    el("button", { className: "wv-icon-btn", title: "New folder", "aria-label": "New folder", onclick: () => createFolder(controller, null) }, ["+"]),
  ]);
  container.appendChild(header);

  const totalCount = (state.entries || []).length;
  const uncategorizedCount = (state.entries || []).filter((e) => !e.folder_id).length;

  container.appendChild(
    makeRow({
      label: "All Workflows",
      count: totalCount,
      active: filters.folderId === undefined,
      onClick: () => setFolder(controller, undefined),
    })
  );
  container.appendChild(
    makeRow({
      label: "Uncategorized",
      count: uncategorizedCount,
      active: filters.folderId === null,
      onClick: () => setFolder(controller, null),
    })
  );

  const tree = buildFolderTree(folders);
  const list = el("div", { className: "wv-folder-tree" });
  for (const node of tree) {
    list.appendChild(renderFolderNode(node, controller, 0));
  }
  container.appendChild(list);
}

function makeRow({ label, count, active, onClick, depth = 0, actions = [] }) {
  const row = el("div", {
    className: `wv-folder-row${active ? " wv-folder-row-active" : ""}`,
    style: { paddingLeft: `${10 + depth * 14}px` },
  });
  row.appendChild(
    el("span", { className: "wv-folder-label", role: "button", tabindex: "0", onclick: onClick, onkeydown: onActivate(onClick) }, [label])
  );
  row.appendChild(el("span", { className: "wv-folder-count" }, [String(count)]));
  if (actions.length) {
    const actionsEl = el("span", { className: "wv-folder-actions" }, actions);
    row.appendChild(actionsEl);
  }
  return row;
}

function renderFolderNode(node, controller, depth) {
  const { state, filters } = controller;
  const count = countEntriesInFolder(state, node.id);
  const wrapper = el("div", {});

  const actions = [
    el("button", { className: "wv-icon-btn", title: "New subfolder", onclick: (e) => { e.stopPropagation(); createFolder(controller, node.id); } }, [el("i", { className: "pi pi-plus" })]),
    el("button", { className: "wv-icon-btn", title: "Rename", onclick: (e) => { e.stopPropagation(); renameFolder(controller, node); } }, [el("i", { className: "pi pi-pencil" })]),
    el("button", { className: "wv-icon-btn", title: "Move", onclick: (e) => { e.stopPropagation(); moveFolder(controller, node); } }, [el("i", { className: "pi pi-arrows-h" })]),
    el("button", { className: "wv-icon-btn", title: "Delete", onclick: (e) => { e.stopPropagation(); deleteFolder(controller, node); } }, [el("i", { className: "pi pi-trash" })]),
  ];

  wrapper.appendChild(
    makeRow({
      label: node.name,
      count,
      active: filters.folderId === node.id,
      onClick: () => setFolder(controller, node.id),
      depth,
      actions,
    })
  );

  for (const child of node.children) {
    wrapper.appendChild(renderFolderNode(child, controller, depth + 1));
  }
  return wrapper;
}

function setFolder(controller, folderId) {
  controller.filters.folderId = folderId;
  controller.render();
}

// ---------------------------------------------------------------------------
// Folder CRUD
// ---------------------------------------------------------------------------

async function createFolder(controller, parentId) {
  const name = await promptDialog({ title: "New Folder", message: "Folder name", placeholder: "Folder name" });
  if (name == null) return;
  if (!name.trim()) {
    showToast("Folder name is required.", "error");
    return;
  }
  try {
    await VaultAPI.createFolder({ name: name.trim(), parent_id: parentId });
    showToast("Folder created.", "success");
    await controller.refresh();
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function renameFolder(controller, folder) {
  const name = await promptDialog({ title: "Rename Folder", message: "Folder name", defaultValue: folder.name });
  if (name == null) return;
  if (!name.trim()) {
    showToast("Folder name is required.", "error");
    return;
  }
  try {
    await VaultAPI.updateFolder(folder.id, { name: name.trim() });
    showToast("Folder renamed.", "success");
    await controller.refresh();
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function moveFolder(controller, folder) {
  const exclude = new Set([folder.id, ...getDescendantIds(controller.state.folders, folder.id)]);
  const options = folderSelectOptions(controller.state.folders, exclude);
  const result = await formDialog({
    title: "Move Folder",
    message: `Choose a new parent for "${folder.name}".`,
    fields: [{ name: "parent_id", type: "select", value: folder.parent_id || "", options }],
    confirmText: "Move",
  });
  if (result == null) return;
  try {
    await VaultAPI.updateFolder(folder.id, { parent_id: result.parent_id || null });
    showToast("Folder moved.", "success");
    await controller.refresh();
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function deleteFolder(controller, folder) {
  const ok = await confirmDialog({
    title: `Delete folder "${folder.name}"?`,
    message:
      "This will delete the folder and any subfolders.\n" +
      "Workflow entries inside them will not be deleted.\n" +
      "They will be moved to Uncategorized.\n\n" +
      "Continue?",
    confirmText: "Delete Folder",
    danger: true,
  });
  if (!ok) return;
  try {
    await VaultAPI.deleteFolder(folder.id);
    if (controller.filters.folderId === folder.id || getDescendantIds(controller.state.folders, folder.id).has(controller.filters.folderId)) {
      controller.filters.folderId = undefined;
    }
    showToast("Folder deleted.", "success");
    await controller.refresh();
  } catch (e) {
    showToast(e.message, "error");
  }
}
