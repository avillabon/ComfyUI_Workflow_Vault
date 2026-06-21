"""Filesystem layout helpers and vault scanning.

No central index or database: every read walks the entries/ directory and
reads the relevant JSON/Markdown files directly.
"""

import os

from . import utils


def entries_dir(vault_root):
    return os.path.join(vault_root, "entries")


def staging_entry_prefix():
    return ".wv_staging_"


def entry_dir(vault_root, slug):
    return os.path.join(entries_dir(vault_root), slug)


def manifest_path(vault_root, slug):
    return os.path.join(entry_dir(vault_root, slug), "manifest.json")


def thumbnails_dir(vault_root, slug):
    return os.path.join(entry_dir(vault_root, slug), "thumbnails")


def versions_dir(vault_root, slug):
    return os.path.join(entry_dir(vault_root, slug), "versions")


def version_dir(vault_root, slug, version_dir_name):
    return os.path.join(versions_dir(vault_root, slug), version_dir_name)


def examples_dir(vault_root, slug):
    return os.path.join(entry_dir(vault_root, slug), "examples")


def example_dir(vault_root, slug, example_dir_name):
    return os.path.join(examples_dir(vault_root, slug), example_dir_name)


def list_entry_slugs(vault_root):
    edir = entries_dir(vault_root)
    if not os.path.isdir(edir):
        return []
    slugs = []
    for name in sorted(os.listdir(edir)):
        if name.startswith(staging_entry_prefix()):
            continue
        full = os.path.join(edir, name)
        if os.path.isdir(full) and os.path.isfile(os.path.join(full, "manifest.json")):
            slugs.append(name)
    return slugs


def read_manifest(vault_root, slug):
    return utils.read_json(manifest_path(vault_root, slug))


def write_manifest(vault_root, slug, manifest):
    utils.atomic_write_json(manifest_path(vault_root, slug), manifest)


def notes_path(vault_root, slug):
    return os.path.join(entry_dir(vault_root, slug), "notes.json")


def read_notes(vault_root, slug):
    """Return the entry's notes as a list of {id, title, content}.

    All notes live in a single notes.json. Entries created before this format
    are lazily migrated from the old notes.md into a single 'Notes' note;
    the old README.md / best_practices.md are intentionally dropped."""
    data = utils.read_json(notes_path(vault_root, slug), default=None)
    if isinstance(data, dict) and isinstance(data.get("notes"), list):
        return data["notes"]
    legacy = utils.read_text(os.path.join(entry_dir(vault_root, slug), "notes.md"), default="")
    if legacy and legacy.strip():
        return [{"id": utils.generate_id("note"), "title": "Notes", "content": legacy}]
    return []


def write_notes(vault_root, slug, notes):
    utils.atomic_write_json(notes_path(vault_root, slug), {"notes": notes or []})


def find_slug_by_id(vault_root, entry_id):
    for slug in list_entry_slugs(vault_root):
        manifest = read_manifest(vault_root, slug)
        if manifest and manifest.get("id") == entry_id:
            return slug, manifest
    return None, None


def list_versions(vault_root, slug):
    """Return version dicts (each tagged with 'dir'), sorted oldest first."""
    vdir = versions_dir(vault_root, slug)
    if not os.path.isdir(vdir):
        return []
    versions = []
    for name in sorted(os.listdir(vdir)):
        full = os.path.join(vdir, name)
        vjson = os.path.join(full, "version.json")
        if os.path.isdir(full) and os.path.isfile(vjson):
            data = utils.read_json(vjson)
            if data:
                data = dict(data)
                data["dir"] = name
                versions.append(data)
    versions.sort(key=lambda v: v.get("created_at", ""))
    return versions


def list_examples(vault_root, slug):
    """Return example dicts (each tagged with 'dir'), sorted by folder name."""
    exdir = examples_dir(vault_root, slug)
    if not os.path.isdir(exdir):
        return []
    examples = []
    for name in sorted(os.listdir(exdir)):
        full = os.path.join(exdir, name)
        ejson = os.path.join(full, "example.json")
        if os.path.isdir(full) and os.path.isfile(ejson):
            data = utils.read_json(ejson)
            if data:
                data = dict(data)
                data["dir"] = name
                examples.append(data)
    # Examples without an explicit "order" keep their original directory order
    # and sort ahead of explicitly-ordered ones; once the user reorders, every
    # example gets an "order" so they sort purely by it.
    examples.sort(key=lambda e: (
        1 if e.get("order") is not None else 0,
        e.get("order") if e.get("order") is not None else 0,
        e.get("dir", ""),
    ))
    return examples


def all_tags(vault_root):
    tags = set()
    for slug in list_entry_slugs(vault_root):
        manifest = read_manifest(vault_root, slug)
        if manifest:
            for t in manifest.get("tags", []):
                tags.add(t)
    return sorted(tags)


def read_folders(vault_root):
    data = utils.read_json(os.path.join(vault_root, "folders.json"), default={"folders": []})
    return (data or {}).get("folders", [])


def write_folders(vault_root, folders):
    utils.atomic_write_json(os.path.join(vault_root, "folders.json"), {"folders": folders})


def _coerce_generation_types(manifest):
    """Read generation types as a list, transparently upgrading the legacy
    scalar `generation_type` field so old manifests keep working until their
    next save rewrites them to the plural `generation_types`."""
    types = manifest.get("generation_types")
    if isinstance(types, list):
        return [t for t in types if isinstance(t, str)]
    legacy = manifest.get("generation_type")
    return [legacy] if isinstance(legacy, str) and legacy else []


def build_entry_state(vault_root, slug):
    manifest = read_manifest(vault_root, slug)
    if not manifest:
        return None
    return {
        "id": manifest.get("id"),
        "slug": slug,
        "name": manifest.get("name"),
        "description": manifest.get("description", ""),
        "tags": manifest.get("tags", []),
        "status": manifest.get("status", "draft"),
        "generation_types": _coerce_generation_types(manifest),
        "favorite": bool(manifest.get("favorite", False)),
        "thumbnail": manifest.get("thumbnail"),
        "thumbnail_source": manifest.get("thumbnail_source"),
        "compare_image": manifest.get("compare_image"),
        "compare_image_source": manifest.get("compare_image_source"),
        "folder_id": manifest.get("folder_id"),
        "current_version_id": manifest.get("current_version_id"),
        "created_at": manifest.get("created_at"),
        "updated_at": manifest.get("updated_at"),
        "versions": list_versions(vault_root, slug),
        "examples": list_examples(vault_root, slug),
        "notes": read_notes(vault_root, slug),
    }


def compute_footprint(vault_root):
    """Walk the vault and tally on-disk bytes by media category, plus counts.

    Sizes are real file sizes, bucketed by each entry's top-level subfolder
    (thumbnails / examples / versions). Files outside those folders (manifests,
    notes, and top-level vault metadata like folders.json/vault_settings.json)
    aren't bucketed but still count toward 'total'. Returns a flat dict the
    settings UI renders directly."""
    totals = {"total": 0, "examples": 0, "thumbnails": 0, "workflows": 0}
    counts = {"entries": 0, "versions": 0, "examples_count": 0, "tags": 0}
    if not os.path.isdir(vault_root):
        return {**totals, **counts}

    for slug in list_entry_slugs(vault_root):
        counts["entries"] += 1
        entry_root = entry_dir(vault_root, slug)
        for root, _dirs, files in os.walk(entry_root):
            rel = os.path.relpath(root, entry_root).replace("\\", "/")
            top = rel.split("/", 1)[0] if rel != "." else ""
            bucket = {
                "thumbnails": "thumbnails",
                "examples": "examples",
                "versions": "workflows",
            }.get(top)
            for name in files:
                try:
                    size = os.path.getsize(os.path.join(root, name))
                except OSError:
                    continue
                totals["total"] += size
                if bucket:
                    totals[bucket] += size
        counts["versions"] += len(list_versions(vault_root, slug))
        counts["examples_count"] += len(list_examples(vault_root, slug))

    # Top-level vault metadata sits outside any entry — counts toward total only.
    try:
        top_names = os.listdir(vault_root)
    except OSError:
        top_names = []
    for name in top_names:
        p = os.path.join(vault_root, name)
        if os.path.isfile(p):
            try:
                totals["total"] += os.path.getsize(p)
            except OSError:
                continue

    counts["tags"] = len(all_tags(vault_root))
    return {**totals, **counts}


def build_state(vault_root):
    entries = []
    for slug in list_entry_slugs(vault_root):
        entry = build_entry_state(vault_root, slug)
        if entry:
            entries.append(entry)
    return {
        "folders": read_folders(vault_root),
        "entries": entries,
        "tags": all_tags(vault_root),
    }


def health_report(vault_root):
    """Return a non-mutating consistency report for the vault.

    The report is intentionally conservative: it lists issues the UI can show
    or a future repair flow can act on, but it never edits user data.
    """
    issues = []
    summary = {
        "entries": 0,
        "versions": 0,
        "examples": 0,
        "staging_entries": 0,
        "orphan_entry_dirs": 0,
        "missing_files": 0,
    }

    # Folders are deprecated, so legacy folder_id values and folders.json are
    # treated as inert metadata: the health report intentionally does not flag
    # them as issues anymore.
    edir = entries_dir(vault_root)

    if os.path.isdir(edir):
        for name in sorted(os.listdir(edir)):
            full = os.path.join(edir, name)
            if not os.path.isdir(full):
                continue
            if name.startswith(staging_entry_prefix()):
                summary["staging_entries"] += 1
                issues.append({
                    "severity": "warning",
                    "type": "staging_entry",
                    "path": os.path.relpath(full, vault_root).replace("\\", "/"),
                    "message": "Interrupted entry save staging folder can be cleaned up.",
                })
                continue
            if not os.path.isfile(os.path.join(full, "manifest.json")):
                summary["orphan_entry_dirs"] += 1
                issues.append({
                    "severity": "warning",
                    "type": "orphan_entry_dir",
                    "path": os.path.relpath(full, vault_root).replace("\\", "/"),
                    "message": "Entry folder has no manifest.json and is not shown in the vault.",
                })

    for slug in list_entry_slugs(vault_root):
        manifest = read_manifest(vault_root, slug)
        if not manifest:
            continue
        summary["entries"] += 1
        entry_id = manifest.get("id")

        entry_root = entry_dir(vault_root, slug)
        for key in ("thumbnail", "thumbnail_source", "compare_image", "compare_image_source"):
            rel = (manifest.get(key) or "").replace("\\", "/")
            if not rel:
                continue
            path = os.path.normpath(os.path.join(entry_root, rel))
            if not utils.is_path_inside(entry_root, path) or not os.path.isfile(path):
                summary["missing_files"] += 1
                issues.append({
                    "severity": "error",
                    "type": "missing_media",
                    "entry_id": entry_id,
                    "entry_slug": slug,
                    "field": key,
                    "path": rel,
                    "message": "Manifest references a media file that is missing or invalid.",
                })

        versions = list_versions(vault_root, slug)
        summary["versions"] += len(versions)
        for version in versions:
            rel = version.get("workflow_file") or "workflow.json"
            path = os.path.normpath(os.path.join(version_dir(vault_root, slug, version["dir"]), rel))
            if not utils.is_path_inside(version_dir(vault_root, slug, version["dir"]), path) or not os.path.isfile(path):
                summary["missing_files"] += 1
                issues.append({
                    "severity": "error",
                    "type": "missing_workflow",
                    "entry_id": entry_id,
                    "entry_slug": slug,
                    "version_id": version.get("id"),
                    "path": rel,
                    "message": "Version references a workflow file that is missing or invalid.",
                })

        examples = list_examples(vault_root, slug)
        summary["examples"] += len(examples)
        for example in examples:
            ex_root = example_dir(vault_root, slug, example["dir"])
            for item in example.get("inputs", []) + example.get("outputs", []):
                rel = (item.get("file") or "").replace("\\", "/")
                path = os.path.normpath(os.path.join(ex_root, rel))
                if not utils.is_path_inside(ex_root, path) or not os.path.isfile(path):
                    summary["missing_files"] += 1
                    issues.append({
                        "severity": "error",
                        "type": "missing_example_media",
                        "entry_id": entry_id,
                        "entry_slug": slug,
                        "example_id": example.get("id"),
                        "media_id": item.get("id"),
                        "path": rel,
                        "message": "Example references a media file that is missing or invalid.",
                    })

    return {"ok": not issues, "summary": summary, "issues": issues}


def cleanup_staging_entries(vault_root):
    """Move interrupted staging folders to the OS trash where possible."""
    edir = entries_dir(vault_root)
    removed = []
    failed = []
    if not os.path.isdir(edir):
        return {"removed": removed, "failed": failed}
    for name in sorted(os.listdir(edir)):
        if not name.startswith(staging_entry_prefix()):
            continue
        path = os.path.join(edir, name)
        if not os.path.isdir(path) or not utils.is_path_inside(edir, path):
            continue
        try:
            method = utils.send_to_trash(path)
            removed.append({"path": os.path.relpath(path, vault_root).replace("\\", "/"), "method": method})
        except OSError as e:
            failed.append({"path": os.path.relpath(path, vault_root).replace("\\", "/"), "error": str(e)})
    return {"removed": removed, "failed": failed}
