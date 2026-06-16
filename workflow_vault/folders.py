"""Nested folder management, stored entirely in folders.json."""

from . import storage, utils

_UNSET = object()


def _find(folders, folder_id):
    return next((f for f in folders if f.get("id") == folder_id), None)


def _siblings(folders, parent_id, exclude_id=None):
    return [
        f for f in folders
        if f.get("parent_id") == parent_id and f.get("id") != exclude_id
    ]


def get_descendant_ids(folders, folder_id):
    result = set()
    stack = [folder_id]
    while stack:
        fid = stack.pop()
        for f in folders:
            if f.get("parent_id") == fid and f["id"] not in result:
                result.add(f["id"])
                stack.append(f["id"])
    return result


def _is_self_or_descendant(folders, candidate_id, of_id):
    if candidate_id == of_id:
        return True
    return candidate_id in get_descendant_ids(folders, of_id)


def create_folder(vault_root, name, parent_id=None):
    name = (name or "").strip()
    if not name:
        return None, "Folder name is required."
    folders = storage.read_folders(vault_root)
    if parent_id and not _find(folders, parent_id):
        return None, "Parent folder not found."
    for f in _siblings(folders, parent_id):
        if f.get("name", "").strip().lower() == name.lower():
            return None, "A folder with this name already exists here."
    folder = {
        "id": utils.generate_id("folder"),
        "name": name,
        "parent_id": parent_id,
        "description": "",
        "entry_ids": [],
    }
    folders.append(folder)
    storage.write_folders(vault_root, folders)
    return folder, None


def update_folder(vault_root, folder_id, name=_UNSET, parent_id=_UNSET):
    folders = storage.read_folders(vault_root)
    folder = _find(folders, folder_id)
    if not folder:
        return None, "Folder not found."

    new_name = folder["name"] if name is _UNSET else (name or "").strip()
    new_parent = folder["parent_id"] if parent_id is _UNSET else parent_id

    if not new_name:
        return None, "Folder name is required."
    if new_parent is not None:
        if not _find(folders, new_parent):
            return None, "Parent folder not found."
        if _is_self_or_descendant(folders, new_parent, folder_id):
            return None, "Cannot move a folder into itself or one of its subfolders."

    for f in _siblings(folders, new_parent, exclude_id=folder_id):
        if f.get("name", "").strip().lower() == new_name.lower():
            return None, "A folder with this name already exists here."

    folder["name"] = new_name
    folder["parent_id"] = new_parent
    storage.write_folders(vault_root, folders)
    return folder, None


def delete_folder(vault_root, folder_id):
    folders = storage.read_folders(vault_root)
    folder = _find(folders, folder_id)
    if not folder:
        return False, "Folder not found."

    to_delete = {folder_id} | get_descendant_ids(folders, folder_id)
    remaining = [f for f in folders if f["id"] not in to_delete]
    storage.write_folders(vault_root, remaining)

    for slug in storage.list_entry_slugs(vault_root):
        manifest = storage.read_manifest(vault_root, slug)
        if manifest and manifest.get("folder_id") in to_delete:
            manifest["folder_id"] = None
            manifest["updated_at"] = utils.now_iso()
            storage.write_manifest(vault_root, slug, manifest)

    return True, None


def add_entry_to_folder(vault_root, folder_id, entry_id):
    if not folder_id:
        return True, None
    folders = storage.read_folders(vault_root)
    folder = _find(folders, folder_id)
    if not folder:
        return False, "Folder not found."
    if entry_id not in folder.setdefault("entry_ids", []):
        folder["entry_ids"].append(entry_id)
        storage.write_folders(vault_root, folders)
    return True, None


def set_entry_folder(vault_root, entry_id, new_folder_id):
    """Move an entry to new_folder_id (or None for uncategorized)."""
    folders = storage.read_folders(vault_root)
    if new_folder_id and not _find(folders, new_folder_id):
        return False, "Folder not found."

    changed = False
    for f in folders:
        entry_ids = f.setdefault("entry_ids", [])
        if entry_id in entry_ids and f["id"] != new_folder_id:
            entry_ids.remove(entry_id)
            changed = True

    if new_folder_id:
        folder = _find(folders, new_folder_id)
        if entry_id not in folder.setdefault("entry_ids", []):
            folder["entry_ids"].append(entry_id)
            changed = True

    if changed:
        storage.write_folders(vault_root, folders)
    return True, None
