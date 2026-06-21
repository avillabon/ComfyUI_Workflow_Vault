"""Vault entry creation and metadata editing."""

import os
import shutil

from . import config
from . import examples as examples_mod
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


def normalize_generation_types(value):
    """Coerce an incoming value into an ordered, de-duplicated list of valid
    generation types. Accepts a list, a single string, or None; silently drops
    anything not in VALID_GENERATION_TYPES."""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    result = []
    for v in value:
        if v in VALID_GENERATION_TYPES and v not in result:
            result.append(v)
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
    """data keys: name, description, tags, status, generation_types, favorite,
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

    # Accept the new plural field, falling back to the legacy singular one.
    generation_types = normalize_generation_types(
        data["generation_types"] if "generation_types" in data else data.get("generation_type")
    )

    base_slug = utils.slugify(name)
    slug = utils.unique_slug(base_slug, slugs)
    staging_slug = f"{storage.staging_entry_prefix()}{slug}_{utils.generate_id('stage')}"

    final_dir = storage.entry_dir(vault_root, slug)
    staging_dir = storage.entry_dir(vault_root, staging_slug)
    os.makedirs(storage.thumbnails_dir(vault_root, staging_slug), exist_ok=True)
    os.makedirs(storage.versions_dir(vault_root, staging_slug), exist_ok=True)
    os.makedirs(storage.examples_dir(vault_root, staging_slug), exist_ok=True)

    now = utils.now_iso()
    manifest = {
        "schema_version": "1.0",
        "id": utils.generate_id("entry"),
        "slug": slug,
        "name": name,
        "description": data.get("description") or "",
        "tags": normalize_tags(data.get("tags")),
        "status": status,
        "generation_types": generation_types,
        "favorite": bool(data.get("favorite", False)),
        "thumbnail": None,
        "thumbnail_source": None,
        "thumbnail_source_compressed": False,
        "compare_image": None,
        "compare_image_source": None,
        # Folders are deprecated: the vault is tag-first. New entries are never
        # filed into a folder. Legacy folder_id values on existing entries are
        # preserved and can be converted to tags (see convert_folders_to_tags).
        "folder_id": None,
        "current_version_id": None,
        "created_at": now,
        "updated_at": now,
    }

    try:
        notes = normalize_notes(data.get("notes"))
        if notes:
            storage.write_notes(vault_root, staging_slug, notes)

        version, err = versions.create_version(
            vault_root, manifest, staging_slug, workflow,
            label=data.get("version_label") or "v001",
            custom_label=data.get("custom_label"),
            notes=data.get("version_notes", ""),
            make_current=True,
        )
        if err:
            shutil.rmtree(staging_dir, ignore_errors=True)
            return None, err

        thumbnail = data.get("thumbnail")
        if thumbnail:
            rel, merr = media_mod.save_thumbnail(
                vault_root, staging_slug, thumbnail["bytes"], thumbnail["filename"], mtime=thumbnail.get("mtime")
            )
            if merr:
                shutil.rmtree(staging_dir, ignore_errors=True)
                return None, merr
            manifest["thumbnail"] = rel

        # Archival full-resolution original is best-effort: a failure here must
        # not discard the whole entry, since the display thumbnail already
        # succeeded.
        thumbnail_source = data.get("thumbnail_source")
        if thumbnail_source:
            rel, src_compressed, merr = media_mod.save_thumbnail_source(
                vault_root, staging_slug, thumbnail_source["bytes"], thumbnail_source["filename"],
                mtime=thumbnail_source.get("mtime"), compress=_should_compress_source(vault_root)
            )
            if not merr:
                manifest["thumbnail_source"] = rel
                manifest["thumbnail_source_compressed"] = src_compressed

        # Compare overlay is best-effort too — never discard the entry over it.
        compare_image = data.get("compare_image")
        if compare_image:
            rel, merr = media_mod.save_compare_image(
                vault_root, staging_slug, compare_image["bytes"], compare_image["filename"], mtime=compare_image.get("mtime")
            )
            if not merr:
                manifest["compare_image"] = rel
            compare_image_source = data.get("compare_image_source")
            if not merr and compare_image_source:
                srel, serr = media_mod.save_compare_image_source(
                    vault_root, staging_slug, compare_image_source["bytes"], compare_image_source["filename"],
                    mtime=compare_image_source.get("mtime"),
                )
                if not serr:
                    manifest["compare_image_source"] = srel

        skipped_files = []
        examples_data = data.get("examples") or []
        if examples_data:
            for example_data in examples_data:
                input_files = example_data.pop("input_files", [])
                output_files = example_data.pop("output_files", [])
                if not input_files and not output_files:
                    continue
                _, eerr, skipped = examples_mod.create_example(
                    vault_root, manifest, staging_slug, example_data, input_files, output_files
                )
                if eerr is None:
                    skipped_files.extend(skipped)

        storage.write_manifest(vault_root, staging_slug, manifest)
        if os.path.exists(final_dir):
            shutil.rmtree(staging_dir, ignore_errors=True)
            return None, "A folder for this slug already exists on disk."
        os.rename(staging_dir, final_dir)
    except Exception as e:
        shutil.rmtree(staging_dir, ignore_errors=True)
        return None, f"Could not create entry: {e}"

    entry_state = storage.build_entry_state(vault_root, slug)
    if skipped_files:
        entry_state["skipped_files"] = skipped_files
    return entry_state, None


def update_entry_metadata(vault_root, manifest, slug, data, thumbnail_file=None, thumbnail_source_file=None, compare_image_file=None, compare_image_source_file=None):
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

    if "generation_types" in data or "generation_type" in data:
        raw = data["generation_types"] if "generation_types" in data else data.get("generation_type")
        manifest["generation_types"] = normalize_generation_types(raw)
        manifest.pop("generation_type", None)  # migrate away from the legacy field

    if "favorite" in data:
        manifest["favorite"] = bool(data["favorite"])

    # Folder assignments are no longer written (folders are deprecated). Any
    # existing manifest["folder_id"] is left untouched as legacy metadata.

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

    # Compare overlay: a new asset replaces it; an explicit clear removes it.
    if compare_image_file:
        rel, merr = media_mod.save_compare_image(
            vault_root, new_slug, compare_image_file["bytes"], compare_image_file["filename"], mtime=compare_image_file.get("mtime")
        )
        if merr:
            return new_slug, merr
        manifest["compare_image"] = rel
        manifest["compare_image_source"] = None
        if compare_image_source_file:
            srel, serr = media_mod.save_compare_image_source(
                vault_root, new_slug, compare_image_source_file["bytes"], compare_image_source_file["filename"],
                mtime=compare_image_source_file.get("mtime"),
            )
            if not serr:
                manifest["compare_image_source"] = srel
    elif data.get("compare_image_clear"):
        media_mod.remove_compare_image(vault_root, new_slug)
        manifest["compare_image"] = None
        manifest["compare_image_source"] = None

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


def delete_entry(vault_root, slug):
    """Permanently remove an entry's whole folder, preferring the OS trash
    (Recycle Bin) so it stays recoverable. Returns (method, error) where method
    is "trash" or "permanent"."""
    edir = storage.entry_dir(vault_root, slug)
    # Defensive: never delete anything outside the vault's entries directory.
    entries_root = config.entries_dir(vault_root)
    if not os.path.isdir(edir) or not utils.is_path_inside(entries_root, edir):
        return None, "Entry not found."
    try:
        method = utils.send_to_trash(edir)
    except OSError as e:
        return None, f"Could not delete entry: {e}"
    return method, None


def duplicate_entry(vault_root, source_slug, new_name):
    """Clone an entry into a brand-new entry under new_name: same description,
    tags, status, generation types, favorite, folder, thumbnail, examples, and
    notes — but carrying ONLY the source's current version (a fresh single-
    version history), never the full version history.
    Returns (entry_state, error)."""
    new_name = (new_name or "").strip()
    if not new_name:
        return None, "Name is required."
    src_manifest = storage.read_manifest(vault_root, source_slug)
    if not src_manifest:
        return None, "Entry not found."

    names, slugs = _all_names_and_slugs(vault_root)
    if new_name.lower() in names:
        return None, "An entry with this name already exists."
    new_slug = utils.unique_slug(utils.slugify(new_name), slugs)

    src_dir = storage.entry_dir(vault_root, source_slug)
    dst_dir = storage.entry_dir(vault_root, new_slug)
    try:
        shutil.copytree(src_dir, dst_dir)
    except OSError as e:
        shutil.rmtree(dst_dir, ignore_errors=True)
        return None, f"Could not copy entry files: {e}"

    manifest = storage.read_manifest(vault_root, new_slug)
    now = utils.now_iso()
    manifest["id"] = utils.generate_id("entry")
    manifest["slug"] = new_slug
    manifest["name"] = new_name
    manifest["created_at"] = now
    manifest["updated_at"] = now
    # A duplicate is a brand-new entry: tag-first, never filed into a folder.
    manifest["folder_id"] = None

    # Keep only the source's current version; drop the rest of the history.
    _trim_to_single_version(vault_root, new_slug, manifest, src_manifest.get("current_version_id"))
    # Fresh ids for examples + their media so nothing is shared with the source.
    _reidentify_examples(vault_root, new_slug)

    storage.write_manifest(vault_root, new_slug, manifest)

    return storage.build_entry_state(vault_root, new_slug), None


def _trim_to_single_version(vault_root, slug, manifest, source_current_version_id):
    """Reduce a freshly-copied entry to a single version — the source's current
    one (falling back to the most recent) — relabeled as a clean 'v001' with a
    fresh version id. Other version directories are deleted."""
    versions_list = storage.list_versions(vault_root, slug)
    if not versions_list:
        manifest["current_version_id"] = None
        return
    keep = next((v for v in versions_list if v.get("id") == source_current_version_id), versions_list[-1])

    for v in versions_list:
        if v.get("dir") != keep.get("dir"):
            shutil.rmtree(storage.version_dir(vault_root, slug, v["dir"]), ignore_errors=True)

    old_dir = storage.version_dir(vault_root, slug, keep["dir"])
    new_dir = storage.version_dir(vault_root, slug, "v001")
    if os.path.normpath(old_dir) != os.path.normpath(new_dir):
        shutil.rmtree(new_dir, ignore_errors=True)
        try:
            os.rename(old_dir, new_dir)
        except OSError:
            new_dir = old_dir  # keep the original dir name if the rename fails

    vpath = os.path.join(new_dir, "version.json")
    vdata = utils.read_json(vpath) or {}
    new_version_id = utils.generate_id("version")
    created = utils.now_iso()
    vdata["id"] = new_version_id
    vdata["label"] = "v001"
    vdata["created_at"] = created
    vdata["updated_at"] = created
    utils.atomic_write_json(vpath, vdata)
    manifest["current_version_id"] = new_version_id


def _reidentify_examples(vault_root, slug):
    """Give every copied example (and its media items) fresh ids so the
    duplicate never shares ids with the source it was cloned from."""
    for example in storage.list_examples(vault_root, slug):
        example["id"] = utils.generate_id("example")
        for role in ("inputs", "outputs"):
            for item in example.get(role, []):
                item["id"] = utils.generate_id("media")
        edir = storage.example_dir(vault_root, slug, example["dir"])
        saved = {k: v for k, v in example.items() if k != "dir"}
        utils.atomic_write_json(os.path.join(edir, "example.json"), saved)


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
        if media_mod.ext_of(rel) in media_mod.VIDEO_EXTS:
            continue  # video sources are kept as-is; nothing to compress
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


# ---------------------------------------------------------------------------
# Legacy folders -> tags (explicit, one-time conversion)
# ---------------------------------------------------------------------------

def _folder_path_names(folders_by_id, folder_id):
    """Return the folder names from root to folder_id (e.g. ["Image", "Cleanup"]).

    Guards against cycles in malformed folders.json so a bad parent_id chain
    can never loop forever."""
    names = []
    seen = set()
    current = folders_by_id.get(folder_id)
    while current and current.get("id") not in seen:
        seen.add(current.get("id"))
        name = (current.get("name") or "").strip()
        if name:
            names.append(name)
        current = folders_by_id.get(current.get("parent_id"))
    names.reverse()
    return names


def convert_folders_to_tags(vault_root, allowed_tags=None):
    """Add each entry's legacy folder-path names to its tags.

    Folders are deprecated, but old vaults may still carry folder_id values and
    a folders.json. This is the explicit, user-triggered migration: an entry in
    "Image / Cleanup" gains the tags "image" and "cleanup". It is additive and
    non-destructive — folders.json is left in place and folder_id is preserved,
    so the action is safe to re-run (duplicate tags are avoided).

    `allowed_tags`, when given, restricts the migration to those folder-name
    tags (normalized): any folder name not in the set is skipped, so the user
    can convert some folder names and leave junk ones behind. None converts all.

    Returns {"converted": <entries that gained at least one candidate tag slot>,
             "added": <total new tags added across all entries>}."""
    folders = storage.read_folders(vault_root)
    folders_by_id = {f.get("id"): f for f in folders if f.get("id")}
    allow = None if allowed_tags is None else set(normalize_tags(allowed_tags))

    converted = 0
    added = 0
    for slug in storage.list_entry_slugs(vault_root):
        manifest = storage.read_manifest(vault_root, slug)
        if not manifest:
            continue
        folder_id = manifest.get("folder_id")
        if not folder_id:
            continue
        candidate = normalize_tags(_folder_path_names(folders_by_id, folder_id))
        if allow is not None:
            candidate = [t for t in candidate if t in allow]
        if not candidate:
            continue
        existing = normalize_tags(manifest.get("tags"))
        merged = normalize_tags(existing + candidate)
        converted += 1
        if merged != existing:
            added += len(merged) - len(existing)
            manifest["tags"] = merged
            manifest["updated_at"] = utils.now_iso()
            storage.write_manifest(vault_root, slug, manifest)
    return {"converted": converted, "added": added}
