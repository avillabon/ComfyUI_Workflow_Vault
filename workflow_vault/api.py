"""REST-style backend endpoints for the Workflow Vault extension."""

import asyncio
import json
import os
import re

from aiohttp import web
from server import PromptServer

from . import config, entries, examples, exporting, folders, media, storage, utils, versions

routes = PromptServer.instance.routes

# Per-file upload ceiling for thumbnails and example media (defense against
# accidental/oversized uploads filling memory or disk).
MAX_UPLOAD_BYTES = 256 * 1024 * 1024  # 256 MB
MAX_MULTIPART_BYTES = 768 * 1024 * 1024  # 768 MB total per request

# Mutating endpoints perform read/modify/write cycles across several plain
# files. Serialize those cycles per vault root so concurrent browser tabs do
# not clobber each other's manifest/folder/example updates inside one ComfyUI
# process.
_WRITE_LOCKS = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _error(message, status=400):
    return web.json_response({"error": message}, status=status)


async def _read_json(request):
    """Parse a JSON request body. Returns (body, error_response); body is None
    on error so callers can `if err: return err`."""
    try:
        body = await request.json()
    except Exception:
        return None, _error("Invalid JSON in request body.", 400)
    if not isinstance(body, dict):
        return None, _error("Request body must be a JSON object.", 400)
    return body, None


def _require_vault():
    """Returns (vault_root, error_response). vault_root is None on error."""
    vault_root = config.get_vault_root()
    if not vault_root:
        return None, _error("Vault root is not configured. Set one in Settings.", 400)
    if not config.is_initialized(vault_root):
        return None, _error("Vault root is not initialized.", 400)
    return vault_root, None


def _require_entry(vault_root, entry_id):
    """Returns (slug, manifest, error_response)."""
    slug, manifest = storage.find_slug_by_id(vault_root, entry_id)
    if not slug:
        return None, None, _error("Entry not found.", 404)
    return slug, manifest, None


def _write_lock(vault_root):
    key = os.path.realpath(vault_root or "__workflow_vault_extension__")
    lock = _WRITE_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _WRITE_LOCKS[key] = lock
    return lock


class _MultipartError(Exception):
    """Raised when a multipart request is malformed or a file is too large."""


async def _parse_multipart(request):
    """Returns (data: dict, files: dict[name -> {filename, bytes}]).

    Raises _MultipartError on malformed bodies or oversized uploads; callers
    wrap the call and translate it into a clean 400 response."""
    data = {}
    files = {}
    request_total = {"bytes": 0}
    try:
        reader = await request.multipart()
        async for part in reader:
            if part.name == "data":
                text = await part.text()
                try:
                    data = json.loads(text) if text else {}
                except ValueError:
                    raise _MultipartError("Invalid JSON in 'data' field.")
                if not isinstance(data, dict):
                    raise _MultipartError("'data' field must be a JSON object.")
            elif part.filename:
                content = await _read_part_limited(part, request_total)
                files[part.name] = {"filename": part.filename, "bytes": content}
            else:
                await part.read(decode=False)
    except _MultipartError:
        raise
    except Exception:
        raise _MultipartError("Could not parse upload.")
    # Carry each source file's original date (browser File.lastModified, in ms)
    # onto its file dict as POSIX seconds, so converted files keep their date.
    mtimes = data.get("file_mtimes") if isinstance(data.get("file_mtimes"), dict) else {}
    for name, f in files.items():
        ts = mtimes.get(name)
        if isinstance(ts, (int, float)) and ts > 0:
            f["mtime"] = ts / 1000.0
    return data, files


async def _read_part_limited(part, request_total=None):
    """Read a multipart file part in chunks, enforcing per-file and request caps."""
    chunks = []
    total = 0
    if request_total is None:
        request_total = {"bytes": 0}
    while True:
        chunk = await part.read_chunk()
        if not chunk:
            break
        total += len(chunk)
        request_total["bytes"] += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise _MultipartError(
                f"File '{part.filename}' exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit."
            )
        if request_total["bytes"] > MAX_MULTIPART_BYTES:
            raise _MultipartError(
                f"Upload exceeds the {MAX_MULTIPART_BYTES // (1024 * 1024)} MB request limit."
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _collect_indexed_files(files, prefix, labels=None):
    result = []
    i = 0
    while f"{prefix}{i}" in files:
        item = dict(files[f"{prefix}{i}"])
        if labels and i < len(labels):
            item["label"] = labels[i]
        result.append(item)
        i += 1
    return result


def _full_state(vault_root):
    state = storage.build_state(vault_root)
    state["vault_root"] = vault_root
    state["initialized"] = True
    state["settings"] = config.load_vault_settings(vault_root)
    state["pillow_available"] = media.pillow_available()
    state["trash_label"] = utils.trash_label()
    return state


# ---------------------------------------------------------------------------
# Settings / vault initialization
# ---------------------------------------------------------------------------

@routes.get("/workflow-vault/state")
async def get_state(request):
    vault_root = config.get_vault_root()
    if not vault_root or not config.is_initialized(vault_root):
        return web.json_response({
            "vault_root": vault_root,
            "initialized": False,
            "settings": dict(config.DEFAULT_VAULT_SETTINGS),
            "folders": [],
            "entries": [],
            "tags": [],
            "extension_dir": config.EXTENSION_DIR,
        })
    return web.json_response(_full_state(vault_root))


@routes.get("/workflow-vault/settings")
async def get_settings(request):
    vault_root = config.get_vault_root()
    initialized = bool(vault_root and config.is_initialized(vault_root))
    settings = config.load_vault_settings(vault_root) if initialized else dict(config.DEFAULT_VAULT_SETTINGS)
    return web.json_response({
        "vault_root": vault_root,
        "initialized": initialized,
        "settings": settings,
    })


@routes.post("/workflow-vault/settings")
async def post_settings(request):
    body, err = await _read_json(request)
    if err:
        return err
    vault_root = None

    if "vault_root" in body:
        new_root = (body.get("vault_root") or "").strip()
        ok, err = config.validate_vault_root(new_root)
        if not ok:
            return _error(err)

        if config.is_empty(new_root) or not os.path.exists(new_root):
            config.initialize_vault(new_root)
        elif not config.is_initialized(new_root):
            if not body.get("confirm"):
                return web.json_response({
                    "needs_confirmation": True,
                    "message": (
                        "This folder does not appear to be a Workflow Vault.\n\n"
                        "Vault files will be created inside it:\n"
                        "  vault_settings.json\n"
                        "  folders.json\n"
                        "  entries/\n\n"
                        "Existing files will not be modified.\n\n"
                        "Continue?"
                    ),
                }, status=409)
            config.initialize_vault(new_root)

        config.set_vault_root(new_root)
        vault_root = new_root

    if vault_root is None:
        vault_root = config.get_vault_root()
        if not vault_root:
            return _error("Vault root is not configured.")

    updates = {}
    if "show_archived" in body:
        updates["show_archived"] = bool(body["show_archived"])
    if "default_thumbnail_behavior" in body:
        updates["default_thumbnail_behavior"] = body["default_thumbnail_behavior"]
    if "grid_columns" in body:
        try:
            grid_columns = int(body["grid_columns"])
        except (TypeError, ValueError):
            return _error("Invalid grid_columns.")
        if grid_columns not in (2, 3, 4):
            return _error("Invalid grid_columns.")
        updates["grid_columns"] = grid_columns
    if "sort" in body:
        if body["sort"] not in config.VALID_SORTS:
            return _error("Invalid sort.")
        updates["sort"] = body["sort"]
    if "accent_color" in body:
        color = str(body.get("accent_color") or "").strip()
        if not re.match(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", color):
            return _error("Invalid accent color.")
        updates["accent_color"] = color
    if "card_fields" in body:
        cf = body.get("card_fields")
        if not isinstance(cf, dict):
            return _error("Invalid card_fields.")
        updates["card_fields"] = {k: bool(v) for k, v in cf.items() if k in config.CARD_FIELD_KEYS}
    if "compress_examples_on_upload" in body:
        updates["compress_examples_on_upload"] = bool(body["compress_examples_on_upload"])
    if "example_compress_format" in body:
        if body["example_compress_format"] not in config.VALID_COMPRESS_FORMATS:
            return _error("Invalid example_compress_format.")
        updates["example_compress_format"] = body["example_compress_format"]
    if "compress_thumbnail_source" in body:
        updates["compress_thumbnail_source"] = bool(body["compress_thumbnail_source"])

    if updates:
        config.save_vault_settings(vault_root, updates)

    return web.json_response({
        "vault_root": vault_root,
        "initialized": True,
        "settings": config.load_vault_settings(vault_root),
    })


@routes.post("/workflow-vault/initialize")
async def post_initialize(request):
    body, err = await _read_json(request)
    if err:
        return err
    vault_root = (body.get("vault_root") or "").strip()
    ok, err = config.validate_vault_root(vault_root)
    if not ok:
        return _error(err)
    async with _write_lock(vault_root):
        config.initialize_vault(vault_root)
        config.set_vault_root(vault_root)
        return web.json_response({
            "vault_root": vault_root,
            "initialized": True,
            "settings": config.load_vault_settings(vault_root),
        })


# ---------------------------------------------------------------------------
# Entries
# ---------------------------------------------------------------------------

@routes.post("/workflow-vault/entries")
async def post_create_entry(request):
    vault_root, err = _require_vault()
    if err:
        return err

    try:
        data, files = await _parse_multipart(request)
    except _MultipartError as e:
        return _error(str(e))

    if "thumbnail" in files:
        data["thumbnail"] = files["thumbnail"]
    if "thumbnail_source" in files:
        data["thumbnail_source"] = files["thumbnail_source"]
    if "compare_image" in files:
        data["compare_image"] = files["compare_image"]
    if "compare_image_source" in files:
        data["compare_image_source"] = files["compare_image_source"]

    for i, example in enumerate(data.get("examples") or []):
        example["input_files"] = _collect_indexed_files(files, f"example_{i}_input_", example.get("input_labels"))
        example["output_files"] = _collect_indexed_files(files, f"example_{i}_output_", example.get("output_labels"))

    async with _write_lock(vault_root):
        entry, err_msg = entries.create_entry(vault_root, data)
        if err_msg:
            return _error(err_msg)
        return web.json_response(entry)


@routes.post("/workflow-vault/entries/{entry_id}/metadata")
async def post_entry_metadata(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]

    try:
        data, files = await _parse_multipart(request)
    except _MultipartError as e:
        return _error(str(e))
    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        new_slug, err_msg = entries.update_entry_metadata(
            vault_root, manifest, slug, data, files.get("thumbnail"), files.get("thumbnail_source"),
            compare_image_file=files.get("compare_image"),
            compare_image_source_file=files.get("compare_image_source"),
        )
        if err_msg:
            return _error(err_msg)
        return web.json_response(storage.build_entry_state(vault_root, new_slug))


@routes.post("/workflow-vault/entries/{entry_id}/archive")
async def post_archive_entry(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    if request.can_read_body:
        body, err = await _read_json(request)
        if err:
            return err
    else:
        body = {}
    archived = bool(body.get("archived", True))
    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        entries.set_archived(vault_root, manifest, slug, archived, body.get("restore_status"))
        return web.json_response(storage.build_entry_state(vault_root, slug))


@routes.post("/workflow-vault/entries/{entry_id}/duplicate")
async def post_duplicate_entry(request):
    """Clone an entry into a new one under a user-supplied unique name, keeping
    only the source's current version. File copying runs off the event loop."""
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    slug, _manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err
    body, err = await _read_json(request)
    if err:
        return err

    new_name = (body.get("name") or "").strip()
    async with _write_lock(vault_root):
        slug, _manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        state, err_msg = await asyncio.to_thread(entries.duplicate_entry, vault_root, slug, new_name)
        if err_msg:
            return _error(err_msg)
        return web.json_response(state)


@routes.post("/workflow-vault/entries/{entry_id}/delete")
async def post_delete_entry(request):
    """Delete a whole entry from the vault, sending its folder to the Recycle
    Bin where supported. CPU/IO work runs off the event loop."""
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    slug, _manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    async with _write_lock(vault_root):
        slug, _manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        method, err_msg = await asyncio.to_thread(entries.delete_entry, vault_root, slug)
        if err_msg:
            return _error(err_msg)
        return web.json_response({"ok": True, "method": method})


async def _stream_zip_response(request, zip_path, filename):
    headers = {
        "Content-Type": "application/zip",
        "Content-Disposition": f'attachment; filename="{filename}"',
    }
    resp = web.StreamResponse(headers=headers)
    await resp.prepare(request)
    try:
        with open(zip_path, "rb") as fh:
            while True:
                chunk = await asyncio.to_thread(fh.read, 1024 * 1024)
                if not chunk:
                    break
                await resp.write(chunk)
        await resp.write_eof()
        return resp
    finally:
        try:
            os.remove(zip_path)
        except OSError:
            pass


@routes.get("/workflow-vault/entries/{entry_id}/export")
async def get_export_entry(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    edir = storage.entry_dir(vault_root, slug)
    zip_path = await asyncio.to_thread(exporting.build_zip_file, edir, slug)
    return await _stream_zip_response(request, zip_path, f"{exporting.download_name(slug, 'entry')}.zip")


@routes.get("/workflow-vault/footprint")
async def get_footprint(request):
    vault_root, err = _require_vault()
    if err:
        return err
    # Walk off the event loop so a large vault doesn't block other requests.
    data = await asyncio.get_event_loop().run_in_executor(
        None, storage.compute_footprint, vault_root
    )
    return web.json_response(data)


@routes.get("/workflow-vault/health")
async def get_health(request):
    vault_root, err = _require_vault()
    if err:
        return err
    data = await asyncio.to_thread(storage.health_report, vault_root)
    return web.json_response(data)


@routes.post("/workflow-vault/health/cleanup-staging")
async def post_cleanup_staging(request):
    vault_root, err = _require_vault()
    if err:
        return err
    async with _write_lock(vault_root):
        data = await asyncio.to_thread(storage.cleanup_staging_entries, vault_root)
        report = storage.health_report(vault_root)
    return web.json_response({"ok": not data["failed"], **data, "health": report})


@routes.get("/workflow-vault/export")
async def get_export_vault(request):
    vault_root, err = _require_vault()
    if err:
        return err
    arc_root = os.path.basename(os.path.normpath(vault_root)) or "vault"
    zip_path = await asyncio.to_thread(exporting.build_zip_file, vault_root, arc_root, True)
    return await _stream_zip_response(request, zip_path, f"{exporting.download_name(arc_root, 'vault')}.zip")


@routes.post("/workflow-vault/entries/{entry_id}/reveal-media")
async def post_reveal_media(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err
    body, err = await _read_json(request)
    if err:
        return err

    abs_path, err_msg = media.resolve_media_path(vault_root, entry_id, body.get("path"))
    if err_msg:
        return _error(err_msg, 404)
    ok, rerr = utils.reveal_in_file_manager(abs_path)
    if not ok:
        return _error(rerr)
    return web.json_response({"ok": True})


@routes.post("/workflow-vault/entries/{entry_id}/open-folder")
async def post_open_entry_folder(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err
    ok, err_msg = utils.open_in_file_manager(storage.entry_dir(vault_root, slug))
    if not ok:
        return _error(err_msg)
    return web.json_response({"ok": True})


@routes.post("/workflow-vault/browse-folder")
async def post_browse_folder(request):
    """Open a native OS folder-picker dialog and return the chosen path.

    Runs tkinter off the event loop so the server stays responsive while the
    dialog is open. Returns {"path": "..."} or an error if the user cancels or
    tkinter is unavailable."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        return _error("Native folder browser is unavailable (tkinter not installed).")

    def _pick():
        root = tk.Tk()
        root.withdraw()
        root.wm_attributes("-topmost", True)
        path = filedialog.askdirectory(title="Choose vault folder")
        root.destroy()
        return path or None

    chosen = await asyncio.to_thread(_pick)
    if not chosen:
        return web.json_response({"ok": True, "path": None})
    return web.json_response({"ok": True, "path": chosen})


@routes.post("/workflow-vault/compress-examples")
async def post_compress_examples(request):
    """Batch-compress every existing example image across the vault."""
    vault_root, err = _require_vault()
    if err:
        return err
    if not media.pillow_available():
        return _error("Image compression is unavailable (Pillow not installed).")
    settings = config.load_vault_settings(vault_root)
    fmt = settings.get("example_compress_format", "webp")
    if fmt not in config.VALID_COMPRESS_FORMATS:
        fmt = "webp"
    # CPU-bound — run off the event loop so the server stays responsive. The
    # same sweep also re-encodes archival thumbnail sources (always WebP); the
    # two stat sets are summed so the completion summary covers everything.
    def _compress_all():
        a = examples.compress_all_examples(vault_root, fmt)
        b = entries.compress_all_thumbnail_sources(vault_root)
        return {k: a[k] + b[k] for k in a}

    async with _write_lock(vault_root):
        stats = await asyncio.to_thread(_compress_all)
        return web.json_response({"ok": True, **stats})


# ---------------------------------------------------------------------------
# Versions
# ---------------------------------------------------------------------------

@routes.post("/workflow-vault/entries/{entry_id}/versions")
async def post_create_version(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    body, err = await _read_json(request)
    if err:
        return err
    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        version, err_msg = versions.create_version(
            vault_root, manifest, slug, body.get("workflow"),
            label=body.get("label"),
            custom_label=body.get("custom_label"),
            notes=body.get("notes", ""),
            make_current=body.get("make_current", True),
        )
        if err_msg:
            return _error(err_msg)
        storage.write_manifest(vault_root, slug, manifest)
        return web.json_response(storage.build_entry_state(vault_root, slug))


@routes.post("/workflow-vault/entries/{entry_id}/versions/{version_id}/overwrite")
async def post_overwrite_version(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    version_id = request.match_info["version_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    body, err = await _read_json(request)
    if err:
        return err
    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        version, err_msg = versions.overwrite_version(
            vault_root, manifest, slug, version_id, body.get("workflow"), body.get("notes"))
        if err_msg:
            return _error(err_msg)
        storage.write_manifest(vault_root, slug, manifest)
        return web.json_response(storage.build_entry_state(vault_root, slug))


@routes.post("/workflow-vault/entries/{entry_id}/versions/{version_id}/promote")
async def post_promote_version(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    version_id = request.match_info["version_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        version, err_msg = versions.promote_version(vault_root, manifest, slug, version_id)
        if err_msg:
            return _error(err_msg)
        storage.write_manifest(vault_root, slug, manifest)
        return web.json_response(storage.build_entry_state(vault_root, slug))


@routes.post("/workflow-vault/entries/{entry_id}/versions/{version_id}")
async def post_update_version(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    version_id = request.match_info["version_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    body, err = await _read_json(request)
    if err:
        return err
    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        version, err_msg = versions.update_version_notes(vault_root, manifest, slug, version_id, body.get("notes", ""))
        if err_msg:
            return _error(err_msg)
        storage.write_manifest(vault_root, slug, manifest)
        return web.json_response(storage.build_entry_state(vault_root, slug))


@routes.get("/workflow-vault/entries/{entry_id}/versions/{version_id}/workflow")
async def get_version_workflow(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    version_id = request.match_info["version_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    workflow, err_msg = versions.get_version_workflow(vault_root, slug, version_id)
    if err_msg:
        return _error(err_msg, 404)
    return web.json_response(workflow)


# ---------------------------------------------------------------------------
# Examples
# ---------------------------------------------------------------------------

@routes.post("/workflow-vault/entries/{entry_id}/examples")
async def post_create_example(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    try:
        data, files = await _parse_multipart(request)
    except _MultipartError as e:
        return _error(str(e))
    input_files = _collect_indexed_files(files, "input_", data.get("input_labels"))
    output_files = _collect_indexed_files(files, "output_", data.get("output_labels"))

    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        example, err_msg, skipped = examples.create_example(vault_root, manifest, slug, data, input_files, output_files)
        if err_msg:
            return _error(err_msg)
        storage.write_manifest(vault_root, slug, manifest)
        state = storage.build_entry_state(vault_root, slug)
        if skipped:
            state["skipped_files"] = skipped
        return web.json_response(state)


@routes.post("/workflow-vault/entries/{entry_id}/examples/reorder")
async def post_reorder_examples(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    body, err = await _read_json(request)
    if err:
        return err
    order = body.get("order")
    if not isinstance(order, list):
        return _error("'order' must be a list of example ids.")

    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        ok, err_msg = examples.reorder_examples(vault_root, manifest, slug, order)
        if not ok:
            return _error(err_msg)
        storage.write_manifest(vault_root, slug, manifest)
        return web.json_response(storage.build_entry_state(vault_root, slug))


@routes.post("/workflow-vault/entries/{entry_id}/examples/{example_id}")
async def post_update_example(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    example_id = request.match_info["example_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    try:
        data, files = await _parse_multipart(request)
    except _MultipartError as e:
        return _error(str(e))
    new_input_files = _collect_indexed_files(files, "new_input_", data.get("new_input_labels"))
    new_output_files = _collect_indexed_files(files, "new_output_", data.get("new_output_labels"))

    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        example, err_msg, skipped = examples.update_example(
            vault_root, manifest, slug, example_id, data, new_input_files, new_output_files)
        if err_msg:
            return _error(err_msg)
        storage.write_manifest(vault_root, slug, manifest)
        state = storage.build_entry_state(vault_root, slug)
        if skipped:
            state["skipped_files"] = skipped
        return web.json_response(state)


@routes.post("/workflow-vault/entries/{entry_id}/examples/{example_id}/delete")
async def post_delete_example(request):
    vault_root, err = _require_vault()
    if err:
        return err
    entry_id = request.match_info["entry_id"]
    example_id = request.match_info["example_id"]
    slug, manifest, err = _require_entry(vault_root, entry_id)
    if err:
        return err

    async with _write_lock(vault_root):
        slug, manifest, err = _require_entry(vault_root, entry_id)
        if err:
            return err
        ok, err_msg = examples.delete_example(vault_root, manifest, slug, example_id)
        if not ok:
            return _error(err_msg)
        storage.write_manifest(vault_root, slug, manifest)
        return web.json_response(storage.build_entry_state(vault_root, slug))


# ---------------------------------------------------------------------------
# Folders
# ---------------------------------------------------------------------------

@routes.post("/workflow-vault/folders")
async def post_create_folder(request):
    vault_root, err = _require_vault()
    if err:
        return err
    body, err = await _read_json(request)
    if err:
        return err
    async with _write_lock(vault_root):
        folder, err_msg = folders.create_folder(vault_root, body.get("name"), body.get("parent_id"))
        if err_msg:
            return _error(err_msg)
        return web.json_response({"folder": folder, "folders": storage.read_folders(vault_root)})


@routes.post("/workflow-vault/folders/{folder_id}")
async def post_update_folder(request):
    vault_root, err = _require_vault()
    if err:
        return err
    folder_id = request.match_info["folder_id"]
    body, err = await _read_json(request)
    if err:
        return err

    kwargs = {}
    if "name" in body:
        kwargs["name"] = body["name"]
    if "parent_id" in body:
        kwargs["parent_id"] = body["parent_id"]

    async with _write_lock(vault_root):
        folder, err_msg = folders.update_folder(vault_root, folder_id, **kwargs)
        if err_msg:
            return _error(err_msg)
        return web.json_response({"folder": folder, "folders": storage.read_folders(vault_root)})


@routes.post("/workflow-vault/folders/{folder_id}/delete")
async def post_delete_folder(request):
    vault_root, err = _require_vault()
    if err:
        return err
    folder_id = request.match_info["folder_id"]

    async with _write_lock(vault_root):
        ok, err_msg = folders.delete_folder(vault_root, folder_id)
        if not ok:
            return _error(err_msg)
        return web.json_response(_full_state(vault_root))


# ---------------------------------------------------------------------------
# Tags (vault-wide)
# ---------------------------------------------------------------------------

@routes.post("/workflow-vault/tags/rename")
async def post_rename_tag(request):
    vault_root, err = _require_vault()
    if err:
        return err
    body, err = await _read_json(request)
    if err:
        return err
    async with _write_lock(vault_root):
        count, err_msg = entries.rename_tag(vault_root, body.get("from"), body.get("to"))
        if err_msg:
            return _error(err_msg)
        return web.json_response({"updated": count, **_full_state(vault_root)})


@routes.post("/workflow-vault/tags/delete")
async def post_delete_tag(request):
    vault_root, err = _require_vault()
    if err:
        return err
    body, err = await _read_json(request)
    if err:
        return err
    async with _write_lock(vault_root):
        count, err_msg = entries.delete_tag(vault_root, body.get("tag"))
        if err_msg:
            return _error(err_msg)
        return web.json_response({"updated": count, **_full_state(vault_root)})


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

@routes.get("/workflow-vault/media")
async def get_media(request):
    vault_root = config.get_vault_root()
    if not vault_root or not config.is_initialized(vault_root):
        return _error("Vault is not configured.", 404)

    entry_id = request.query.get("entry_id")
    rel_path = request.query.get("path")

    abs_path, err_msg = media.resolve_media_path(vault_root, entry_id, rel_path)
    if err_msg:
        return _error(err_msg, 404)

    return web.FileResponse(abs_path)
