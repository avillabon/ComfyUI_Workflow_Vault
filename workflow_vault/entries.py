"""Vault entry creation and metadata editing."""

import os
import shutil

from . import config
from . import examples as examples_mod
from . import folders as folders_mod
from . import media as media_mod
from . import storage, utils, versions

VALID_STATUSES = {"draft", "experimental", "stable", "production", "archived"}
VALID_GENERATION_TYPES = {"image", "video", "audio", "3d_model", "llm", "api_nodes"}

_UNSET = object()


def _should_compress_source(vault_root):
    """Whether to re-encode the archival thumbnail source to WebP on save."""
    if not media_mod.pillow_available():
        return False
    return bool(config.load_vault_settings(vault_root).get("compress_thumbnail_source", True))


def normalize_tags(tags):
    result = []
    for t in tags or []:
        t = str(t).strip().lower()
        if t and t not in result:
            result.append(t)
    return result


def normalize_notes(notes):
    """Coerce incoming notes into a clean [{id, title, content}] list."""
    result = []
    for n in notes or []:
        if not isinstance(n, dict):
            continue
        title = (str(n.get("title") or "")).strip() or "Untitled"
        content = n.get("content")
        result.append({
            "id": n.get("id") or utils.generate_id("note"),
            "title": title[:200],
            "content": content if isinstance(content, str) else "",
        })
    return result


def _all_names_and_slugs(vault_root, exclude_slug=None):
    names = set()
    slugs = set()
    for slug in storage.list_entry_slugs(vault_root):
        slugs.add(slug)
        if slug == exclude_slug:
            continue
        manifest = storage.read_manifest(vault_root, slug)
        if manifest:
            names.add((manifest.get("name") or "").strip().lower())
    return names, slugs


def create_entry(vault_root, data):
    """data keys: name, description, tags, status, generation_type, favorite,
    folder_id, notes, version_label, custom_label, version_notes,
    workflow (dict), thumbnail ({bytes, filename}),
    examples (list of {...}) each with optional input_files/output_files.
    Returns (entry_state, error).
    """
    name = (data.get("name") or "").strip()
    if not name:
        return None, "Name is required."

    workflow = data.get("workflow")
    if workflow is None:
        return None, "A workflow JSON snapshot is required."

    names, slugs = _all_names_and_slugs(vault_root)
    if name.lower() in names:
        return None, "An entry with this name already exists."

    status = data.get("status") or "draft"
    if status not in VALID_STATUSES:
        status = "draft"

    generation_type = data.get("generation_type")
    if generation_type not in VALID_GENERATION_TYPES:
        generation_type = None

    base_slug = utils.slugify(name)
    slug = utils.unique_slug(base_slug, slugs)

    edir = storage.entry_dir(vault_root, slug)
    os.makedirs(storage.thumbnails_dir(vault_root, slug), exist_ok=True)
    os.makedirs(storage.versions_dir(vault_root, slug), exist_ok=True)
    os.makedirs(storage.examples_dir(vault_root, slug), exist_ok=True)

    now = utils.now_iso()
    manifest = {
        "schema_version": "1.0",
        "id": utils.generate_id("entry"),
        "slug": slug,
        "name": name,
        "description": data.get("description") or "",
        "tags": normalize_tags(data.get("tags")),
        "status": status,
        "generation_type": generation_type,
        "favorite": bool(data.get("favorite", False)),
        "thumbnail": None,
        "thumbnail_source": None,
        "thumbnail_source_compressed": False,
        "folder_id": data.get("folder_id"),
        "current_version_id": None,
        "created_at": now,
        "updated_at": now,
    }

    notes = normalize_notes(data.get("notes"))
    if notes:
        storage.write_notes(vault_root, slug, notes)

    version, err = versions.create_version(
        vault_root, manifest, slug, workflow,
        label=data.get("version_label") or "v001",
        custom_label=data.get("custom_label"),
        notes=data.get("version_notes", ""),
        make_current=True,
    )
    if err:
        shutil.rmtree(edir, ignore_errors=True)
        return None, err

    thumbnail = data.get("thumbnail")
    if thumbnail:
        rel, merr = media_mod.save_thumbnail(vault_root, slug, thumbnail["bytes"], thumbnail["filename"], mtime=thumbnail.get("mtime"))
        if merr:
            shutil.rmtree(edir, ignore_errors=True)
            return None, merr
        manifest["thumbnail"] = rel

    # Archival full-resolution original is best-effort: a failure here must not
    # discard the whole entry, since the display thumbnail already succeeded.
    thumbnail_source = data.get("thumbnail_source")
    if thumbnail_source:
        rel, src_compressed, merr = media_mod.save_thumbnail_source(
            vault_root, slug, thumbnail_source["bytes"], thumbnail_source["filename"],
            mtime=thumbnail_source.get("mtime"), compress=_should_compress_source(vault_root)
        )
        if not merr:
            manifest["thumbnail_source"] = rel
            manifest["thumbnail_source_compressed"] = src_compressed

    storage.write_manifest(vault_root, slug, manifest)

    if manifest["folder_id"]:
        ok, ferr = folders_mod.add_entry_to_folder(vault_root, manifest["folder_id"], manifest["id"])
        if not ok:
            manifest["folder_id"] = None
            storage.write_manifest(vault_root, slug, manifest)

    skipped_files = []
    examples_data = data.get("examples") or []
    if examples_data:
        for example_data in examples_data:
            input_files = example_data.pop("input_files", [])
            output_files = example_data.pop("output_files", [])
            if not input_files and not output_files:
                continue
            _, eerr, skipped = examples_mod.create_example(vault_root, manifest, slug, example_data, input_files, output_files)
            if eerr is None:
                skipped_files.extend(skipped)
        storage.write_manifest(vault_root, slug, manifest)

    entry_state = storage.build_entry_state(vault_root, slug)
    if skipped_files:
        entry_state["skipped_files"] = skipped_files
    return entry_state, None


def update_entry_metadata(vault_root, manifest, slug, data, thumbnail_file=None, thumbnail_source_file=None):
    """Returns (new_slug, error)."""
    new_slug = slug

    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            return slug, "Name is required."
        if new_name.lower() != (manifest.get("name") or "").strip().lower():
            names, slugs = _all_names_and_slugs(vault_root, exclude_slug=slug)
            if new_name.lower() in names:
                return slug, "An entry with this name already exists."
            base_slug = utils.slugify(new_name)
            new_slug = utils.unique_slug(base_slug, slugs) if base_slug in slugs else base_slug
            if new_slug != slug:
                old_dir = storage.entry_dir(vault_root, slug)
                new_dir = storage.entry_dir(vault_root, new_slug)
                if os.path.exists(new_dir):
                    return slug, "A folder for this slug already exists on disk."
                os.rename(old_dir, new_dir)
        manifest["name"] = new_name
        manifest["slug"] = new_slug

    if "description" in data:
        manifest["description"] = data["description"] or ""

    if "tags" in data:
        manifest["tags"] = normalize_tags(data["tags"])

    if "status" in data:
        if data["status"] not in VALID_STATUSES:
            return new_slug, "Invalid status."
        manifest["status"] = data["status"]

    if "generation_type" in data:
        gt = data["generation_type"]
        if gt is not None and gt not in VALID_GENERATION_TYPES:
            return new_slug, "Invalid generation type."
        manifest["generation_type"] = gt

    if "favorite" in data:
        manifest["favorite"] = bool(data["favorite"])

    if "folder_id" in data:
        ok, ferr = folders_mod.set_entry_folder(vault_root, manifest["id"], data["folder_id"])
        if not ok:
            return new_slug, ferr
        manifest["folder_id"] = data["folder_id"]

    if thumbnail_file:
        rel, merr = media_mod.save_thumbnail(
            vault_root, new_slug, thumbnail_file["bytes"], thumbnail_file["filename"], mtime=thumbnail_file.get("mtime")
        )
        if merr:
            return new_slug, merr
        manifest["thumbnail"] = rel

    if thumbnail_source_file:
        rel, src_compressed, merr = media_mod.save_thumbnail_source(
            vault_root, new_slug, thumbnail_source_file["bytes"], thumbnail_source_file["filename"],
            mtime=thumbnail_source_file.get("mtime"), compress=_should_compress_source(vault_root)
        )
        if not merr:
            manifest["thumbnail_source"] = rel
            manifest["thumbnail_source_compressed"] = src_compressed

    if "notes" in data:
        storage.write_notes(vault_root, new_slug, normalize_notes(data["notes"]))

    manifest["updated_at"] = utils.now_iso()
    storage.write_manifest(vault_root, new_slug, manifest)
    return new_slug, None


def set_archived(vault_root, manifest, slug, archived, restore_status=None):
    if archived:
        manifest["_pre_archive_status"] = manifest.get("status", "draft")
        manifest["status"] = "archived"
    else:
        manifest["status"] = restore_status or manifest.pop("_pre_archive_status", "draft")
        manifest.pop("_pre_archive_status", None)
    manifest["updated_at"] = utils.now_iso()
    storage.write_manifest(vault_root, slug, manifest)


def compress_all_thumbnail_sources(vault_root):
    """Re-encode every existing full-resolution thumbnail source across the
    vault to WebP, in place. Always WebP (metadata-preserving).

    Idempotent: sources already flagged compressed are skipped, and per-entry
    failures are ignored. The converted file keeps the source's original
    modified AND created dates. Returns the same stats shape as
    examples.compress_all_examples so callers can sum the two."""
    examined = 0
    converted = 0
    bytes_before = 0
    bytes_after = 0
    if not media_mod.pillow_available():
        return {"examined": 0, "converted": 0, "skipped": 0, "bytes_before": 0, "bytes_after": 0}
    for slug in storage.list_entry_slugs(vault_root):
        manifest = storage.read_manifest(vault_root, slug)
        if not manifest:
            continue
        rel = manifest.get("thumbnail_source")
        if not rel:
            continue
        examined += 1
        if manifest.get("thumbnail_source_compressed"):
            continue  # already compressed — never re-encode (generation loss)
        edir = storage.entry_dir(vault_root, slug)
        abs_path = os.path.normpath(os.path.join(edir, rel.replace("\\", "/")))
        if not utils.is_path_inside(edir, abs_path) or not os.path.isfile(abs_path):
            continue
        try:
            with open(abs_path, "rb") as fh:
                data = fh.read()
            src_mtime = os.path.getmtime(abs_path)
            src_ctime = os.path.getctime(abs_path)
        except OSError:
            continue
        new_rel, was_compressed, merr = media_mod.save_thumbnail_source(
            vault_root, slug, data, os.path.basename(rel), mtime=src_mtime, compress=True
        )
        if merr or not was_compressed:
            continue
        new_abs = os.path.join(edir, new_rel)
        # Keep the source file's original modified + created dates.
        utils.set_file_times(new_abs, src_mtime, ctime=src_ctime)
        try:
            new_size = os.path.getsize(new_abs)
        except OSError:
            new_size = 0
        manifest["thumbnail_source"] = new_rel
        manifest["thumbnail_source_compressed"] = True
        storage.write_manifest(vault_root, slug, manifest)
        bytes_before += len(data)
        bytes_after += new_size
        converted += 1
    return {
        "examined": examined,
        "converted": converted,
        "skipped": examined - converted,
        "bytes_before": bytes_before,
        "bytes_after": bytes_after,
    }


# ---------------------------------------------------------------------------
# Vault-wide tag operations
# ---------------------------------------------------------------------------

def rename_tag(vault_root, old, new):
    """Rename a tag across every entry. If `new` already exists on an entry,
    the two are merged (de-duplicated). Returns (updated_count, error)."""
    old = (old or "").strip().lower()
    new = (new or "").strip().lower()
    if not old or not new:
        return 0, "Both the existing and new tag names are required."
    if old == new:
        return 0, None

    count = 0
    for slug in storage.list_entry_slugs(vault_root):
        manifest = storage.read_manifest(vault_root, slug)
        if not manifest:
            continue
        tags = manifest.get("tags") or []
        if old not in tags:
            continue
        manifest["tags"] = normalize_tags([new if t == old else t for t in tags])
        manifest["updated_at"] = utils.now_iso()
        storage.write_manifest(vault_root, slug, manifest)
        count += 1
    return count, None


def delete_tag(vault_root, tag):
    """Remove a tag from every entry. Returns (updated_count, error)."""
    tag = (tag or "").strip().lower()
    if not tag:
        return 0, "Tag is required."

    count = 0
    for slug in storage.list_entry_slugs(vault_root):
        manifest = storage.read_manifest(vault_root, slug)
        if not manifest:
            continue
        tags = manifest.get("tags") or []
        if tag not in tags:
            continue
        manifest["tags"] = [t for t in tags if t != tag]
        manifest["updated_at"] = utils.now_iso()
        storage.write_manifest(vault_root, slug, manifest)
        count += 1
    return count, None
