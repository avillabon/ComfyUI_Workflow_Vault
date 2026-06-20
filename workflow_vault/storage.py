"""Filesystem layout helpers and vault scanning.

No central index or database: every read walks the entries/ directory and
reads the relevant JSON/Markdown files directly.
"""

import os

from . import utils


def entries_dir(vault_root):
    return os.path.join(vault_root, "entries")


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
