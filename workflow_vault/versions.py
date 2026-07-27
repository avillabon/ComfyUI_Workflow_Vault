"""Manual workflow version management for a vault entry."""

import os
import re

from . import storage, utils

_DEFAULT_LABEL_RE = re.compile(r"^v(\d{3,})$")


def _next_default_label(existing_versions):
    nums = []
    for v in existing_versions:
        m = _DEFAULT_LABEL_RE.match(v.get("label", ""))
        if m:
            nums.append(int(m.group(1)))
    n = (max(nums) + 1) if nums else 1
    return f"v{n:03d}"


def _label_taken(existing_versions, label):
    for v in existing_versions:
        if v.get("label") == label or v.get("custom_label") == label:
            return True
    return False


def create_version(vault_root, manifest, slug, workflow, label=None, custom_label=None,
                    notes="", make_current=True):
    """Create a new version directory. Mutates ``manifest`` in place
    (current_version_id / updated_at) when ``make_current`` is true.
    Returns (version_dict, error).
    """
    if workflow is None:
        return None, "Workflow JSON snapshot is required."

    existing = storage.list_versions(vault_root, slug)

    label = (label or "").strip() or _next_default_label(existing)
    if _label_taken(existing, label):
        return None, f"Version label '{label}' already exists in this entry."

    custom_label = (custom_label or "").strip() or None
    if custom_label and _label_taken(existing, custom_label):
        return None, f"Version label '{custom_label}' already exists in this entry."

    version_id = utils.generate_id("version")
    now = utils.now_iso()
    dir_name = utils.unique_slug(utils.slugify(label), {v["dir"] for v in existing})

    vdir = storage.version_dir(vault_root, slug, dir_name)
    os.makedirs(vdir, exist_ok=True)
    utils.atomic_write_json(os.path.join(vdir, "workflow.json"), workflow)

    version = {
        "id": version_id,
        "label": label,
        "custom_label": custom_label,
        "created_at": now,
        "updated_at": now,
        "notes": notes or "",
        "workflow_file": "workflow.json",
    }
    utils.atomic_write_json(os.path.join(vdir, "version.json"), version)
    version["dir"] = dir_name

    if make_current:
        manifest["current_version_id"] = version_id
    manifest["updated_at"] = now

    return version, None


def _find_version(vault_root, slug, version_id):
    for v in storage.list_versions(vault_root, slug):
        if v.get("id") == version_id:
            return v
    return None


def _workflow_filename(version):
    """The version's workflow file name. basename() keeps a hand-edited
    version.json from pointing reads/writes outside the version folder."""
    return os.path.basename(version.get("workflow_file") or "") or "workflow.json"


def overwrite_version(vault_root, manifest, slug, version_id, workflow, notes=None):
    if workflow is None:
        return None, "Workflow JSON snapshot is required."
    version = _find_version(vault_root, slug, version_id)
    if not version:
        return None, "Version not found."

    vdir = storage.version_dir(vault_root, slug, version["dir"])
    utils.atomic_write_json(os.path.join(vdir, _workflow_filename(version)), workflow)

    now = utils.now_iso()
    version["updated_at"] = now
    if notes is not None:
        version["notes"] = notes

    saved = {k: v for k, v in version.items() if k != "dir"}
    utils.atomic_write_json(os.path.join(vdir, "version.json"), saved)

    manifest["updated_at"] = now
    return version, None


def promote_version(vault_root, manifest, slug, version_id):
    version = _find_version(vault_root, slug, version_id)
    if not version:
        return None, "Version not found."
    manifest["current_version_id"] = version_id
    manifest["updated_at"] = utils.now_iso()
    return version, None


def update_version_notes(vault_root, manifest, slug, version_id, notes):
    version = _find_version(vault_root, slug, version_id)
    if not version:
        return None, "Version not found."
    version["notes"] = notes or ""
    version["updated_at"] = utils.now_iso()
    vdir = storage.version_dir(vault_root, slug, version["dir"])
    saved = {k: v for k, v in version.items() if k != "dir"}
    utils.atomic_write_json(os.path.join(vdir, "version.json"), saved)
    manifest["updated_at"] = utils.now_iso()
    return version, None


def delete_version(vault_root, manifest, slug, version_id):
    """Delete a version's folder, preferring the OS trash so it stays
    recoverable. Mutates ``manifest`` in place. Returns (new_current_id, error).

    An entry always keeps at least one version: deleting the last one would
    leave an entry whose "Open Workflow" button has nothing to open, and whose
    current_version_id points at nothing. Deleting the *current* version is
    allowed — the next-most-recent survivor is promoted in its place, so the
    entry is never left without a current version."""
    all_versions = storage.list_versions(vault_root, slug)
    version = next((v for v in all_versions if v.get("id") == version_id), None)
    if not version:
        return None, "Version not found."
    if len(all_versions) <= 1:
        return None, "An entry must keep at least one version."

    vdir = storage.version_dir(vault_root, slug, version["dir"])
    versions_root = storage.versions_dir(vault_root, slug)
    # Defensive: never delete anything outside this entry's versions folder.
    if not utils.is_path_inside(versions_root, vdir) or not os.path.isdir(vdir):
        return None, "Version folder not found."
    try:
        utils.send_to_trash(vdir)
    except OSError as e:
        return None, f"Could not delete version: {e}"

    if manifest.get("current_version_id") == version_id:
        # list_versions sorts oldest first, so the last survivor is the newest.
        survivors = [v for v in all_versions if v.get("id") != version_id]
        manifest["current_version_id"] = survivors[-1].get("id")
    manifest["updated_at"] = utils.now_iso()
    return manifest.get("current_version_id"), None


def get_version_workflow(vault_root, slug, version_id):
    version = _find_version(vault_root, slug, version_id)
    if not version:
        return None, "Version not found."
    vdir = storage.version_dir(vault_root, slug, version["dir"])
    workflow = utils.read_json(os.path.join(vdir, _workflow_filename(version)))
    if workflow is None:
        return None, "Workflow file is missing."
    return workflow, None
