"""Media file copying, type detection, safe path resolution, and optional
image compression (Pillow — already bundled by ComfyUI)."""

import io
import json
import os

from . import storage, utils, video

# Pillow ships with ComfyUI, but guard the import so the vault still works
# (just without compression) in the rare environment where it's unavailable.
try:
    from PIL import Image

    _PIL_AVAILABLE = True
except Exception:  # pragma: no cover - defensive
    _PIL_AVAILABLE = False

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif"}
VIDEO_EXTS = video.VIDEO_EXTS  # single source of truth lives in video.py
AUDIO_EXTS = {"wav", "mp3", "m4a", "flac", "ogg"}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS
THUMBNAIL_EXTS = IMAGE_EXTS

# Images we can re-encode (animated GIF is left alone to avoid flattening it).
COMPRESSIBLE_IMAGE_EXTS = {"png", "jpg", "jpeg", "webp"}
WEBP_QUALITY = 85
JPEG_QUALITY = 90


def pillow_available():
    return _PIL_AVAILABLE


def _has_alpha(img):
    if img.mode in ("RGBA", "LA", "PA"):
        return True
    return img.mode == "P" and "transparency" in img.info


def _build_workflow_exif(workflow, prompt):
    """EXIF block carrying the ComfyUI graph, matching how ComfyUI reads it
    back (string tags split on the first ':'). Returns bytes or None."""
    if not _PIL_AVAILABLE or (not workflow and not prompt):
        return None
    exif = Image.Exif()
    if workflow:
        exif[0x010E] = "Workflow:" + (workflow if isinstance(workflow, str) else json.dumps(workflow))
    if prompt:
        exif[0x010F] = "Prompt:" + (prompt if isinstance(prompt, str) else json.dumps(prompt))
    return exif.tobytes()


def compress_example_image(data, filename, fmt):
    """Re-encode image bytes to a smaller lossy WebP/JPEG.

    - WebP keeps transparency and re-embeds the ComfyUI workflow as EXIF so the
      image stays drag-droppable into ComfyUI.
    - JPEG is smaller/maximally compatible but flattens transparency and cannot
      carry a ComfyUI-readable workflow, so we fall back to WebP for any image
      with an alpha channel and don't bother embedding the (unreadable) graph.

    Returns (new_bytes, new_filename) or None when compression isn't possible
    or wouldn't shrink the file (caller then keeps the original untouched)."""
    if not _PIL_AVAILABLE:
        return None
    if ext_of(filename) not in COMPRESSIBLE_IMAGE_EXTS:
        return None
    try:
        src = Image.open(io.BytesIO(data))
        src.load()
    except Exception:
        return None

    workflow = src.info.get("workflow")
    prompt = src.info.get("prompt")
    alpha = _has_alpha(src)
    out_fmt = "webp" if (fmt == "jpeg" and alpha) else fmt

    buf = io.BytesIO()
    try:
        if out_fmt == "webp":
            img = src if src.mode in ("RGB", "RGBA") else src.convert("RGBA" if alpha else "RGB")
            save_kwargs = {"quality": WEBP_QUALITY, "method": 6}
            exif_bytes = _build_workflow_exif(workflow, prompt)
            if exif_bytes:
                save_kwargs["exif"] = exif_bytes
            img.save(buf, "WEBP", **save_kwargs)
            new_ext = "webp"
        else:  # jpeg
            src.convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY, subsampling=0, optimize=True)
            new_ext = "jpg"
    except Exception:
        return None

    new_bytes = buf.getvalue()
    if len(new_bytes) >= len(data):
        return None  # no win — keep the original

    base = os.path.splitext(os.path.basename(filename or "image"))[0] or "image"
    return new_bytes, f"{base}.{new_ext}"


def ext_of(filename):
    return os.path.splitext(filename or "")[1].lstrip(".").lower()


def media_type_for_ext(ext):
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    return None


def _unique_filename(dest_dir, filename):
    name, ext = os.path.splitext(filename)
    candidate = filename
    i = 2
    while os.path.exists(os.path.join(dest_dir, candidate)):
        candidate = f"{name}_{i:03d}{ext}"
        i += 1
    return candidate


def copy_media_bytes(dest_dir, data, filename, mtime=None):
    """Copy bytes into dest_dir using a safe filename, returning the final
    filename used (renamed on collision). When mtime (POSIX seconds) is given,
    stamp it onto the saved file so converted files keep their source date."""
    os.makedirs(dest_dir, exist_ok=True)
    safe_name = os.path.basename(filename or "").strip() or "file"
    final_name = _unique_filename(dest_dir, safe_name)
    dest_path = os.path.join(dest_dir, final_name)
    utils.atomic_write_bytes(dest_path, data)
    if mtime is not None:
        utils.set_file_times(dest_path, mtime)
    return final_name


def _clear_prefixed(tdir, prefix):
    """Remove files in tdir whose name starts with prefix (e.g. "cover.")."""
    if os.path.isdir(tdir):
        for old in os.listdir(tdir):
            if old.startswith(prefix):
                try:
                    os.remove(os.path.join(tdir, old))
                except OSError:
                    pass


def save_thumbnail(vault_root, slug, data, filename, mtime=None):
    """Save the small display thumbnail as thumbnails/cover.<ext>.

    A video source (MP4/MOV/WebM) is converted to an animated WebP first, so
    the grid shows a looping preview. The untouched original is kept separately
    via save_thumbnail_source."""
    ext = ext_of(filename)
    if video.is_video_ext(ext):
        webp_bytes = video.convert_to_animated_webp(data, ext)
        if webp_bytes is None:
            return None, (
                "Could not convert the video to an animated thumbnail. "
                "ffmpeg may be unavailable — try picking a single frame instead."
            )
        data = webp_bytes
        ext = "webp"
    elif ext not in THUMBNAIL_EXTS:
        return None, "Unsupported thumbnail type."
    tdir = storage.thumbnails_dir(vault_root, slug)
    _clear_prefixed(tdir, "cover.")
    final_name = copy_media_bytes(tdir, data, "cover." + ext, mtime=mtime)
    return f"thumbnails/{final_name}", None


def save_thumbnail_source(vault_root, slug, data, filename, mtime=None, compress=False):
    """Save the full-resolution original alongside the thumbnail as
    thumbnails/source.<ext> (archival — never shown as an example).

    When compress is enabled, re-encode the original to a full-resolution WebP
    that keeps the embedded ComfyUI workflow (metadata-preserving, no resize)
    so the source is smaller on disk but still drag-droppable into ComfyUI.
    Always WebP — JPEG can't carry a ComfyUI-readable workflow, which is the
    whole reason this source copy exists.

    A video source is archived as-is (no re-encode): it stays the untouched,
    drag-droppable original behind a converted animated-WebP cover.

    Returns (rel_path, compressed, error)."""
    ext = ext_of(filename)
    is_video = video.is_video_ext(ext)
    if not is_video and ext not in THUMBNAIL_EXTS:
        return None, False, "Unsupported thumbnail source type."
    compressed = False
    if compress and not is_video:
        result = compress_example_image(data, filename, "webp")
        if result:
            data, filename = result
            compressed = True
    tdir = storage.thumbnails_dir(vault_root, slug)
    _clear_prefixed(tdir, "source.")
    final_name = copy_media_bytes(tdir, data, "source." + ext_of(filename), mtime=mtime)
    return f"thumbnails/{final_name}", compressed, None


def save_compare_image(vault_root, slug, data, filename, mtime=None):
    """Save the before/after compare overlay as thumbnails/compare.<ext>.

    Mirrors save_thumbnail: a video source (MP4/MOV/WebM) is converted to an
    animated WebP so the overlay loops, exactly like the display thumbnail. The
    untouched original is archived separately via save_compare_image_source."""
    ext = ext_of(filename)
    if video.is_video_ext(ext):
        webp_bytes = video.convert_to_animated_webp(data, ext)
        if webp_bytes is None:
            return None, (
                "Could not convert the video to an animated compare image. "
                "ffmpeg may be unavailable — try picking a single frame instead."
            )
        data = webp_bytes
        ext = "webp"
    elif ext not in THUMBNAIL_EXTS:
        return None, "Unsupported compare image type."
    tdir = storage.thumbnails_dir(vault_root, slug)
    _clear_prefixed(tdir, "compare.")
    final_name = copy_media_bytes(tdir, data, "compare." + ext, mtime=mtime)
    return f"thumbnails/{final_name}", None


def save_compare_image_source(vault_root, slug, data, filename, mtime=None):
    """Archive the untouched compare overlay original as
    thumbnails/compare_source.<ext> (mirrors save_thumbnail_source). A video is
    kept as-is so the original stays drag-droppable behind the animated WebP.

    The "compare_source." prefix is distinct from "compare." (the 8th char is
    "_" not "."), so saving/clearing one never touches the other."""
    ext = ext_of(filename)
    if not video.is_video_ext(ext) and ext not in THUMBNAIL_EXTS:
        return None, "Unsupported compare image source type."
    tdir = storage.thumbnails_dir(vault_root, slug)
    _clear_prefixed(tdir, "compare_source.")
    final_name = copy_media_bytes(tdir, data, "compare_source." + ext, mtime=mtime)
    return f"thumbnails/{final_name}", None


def remove_thumbnail(vault_root, slug):
    """Delete any saved display thumbnail and its archived source."""
    tdir = storage.thumbnails_dir(vault_root, slug)
    _clear_prefixed(tdir, "cover.")
    _clear_prefixed(tdir, "source.")


def remove_compare_image(vault_root, slug):
    """Delete any saved compare overlay and its archived source."""
    tdir = storage.thumbnails_dir(vault_root, slug)
    _clear_prefixed(tdir, "compare.")
    _clear_prefixed(tdir, "compare_source.")


# Manifest keys that hold an entry-relative media path.
MANIFEST_MEDIA_KEYS = ("thumbnail", "thumbnail_source", "compare_image", "compare_image_source")


def _resolve_referenced_path(vault_root, slug, manifest, rel_path):
    """Return the entry-relative path for rel_path if it is referenced by
    this entry's thumbnail or example media, else None.

    rel_path may already be entry-relative (e.g. "thumbnails/cover.png") or,
    for example media, relative to the example's own directory (e.g.
    "outputs/CLIP B.mp4"), since that's how item["file"] is stored and how
    the frontend requests it.
    """
    for key in MANIFEST_MEDIA_KEYS:
        if (manifest.get(key) or "").replace("\\", "/") == rel_path:
            return rel_path
    for example in storage.list_examples(vault_root, slug):
        prefix = f"examples/{example['dir']}/"
        for item in example.get("inputs", []) + example.get("outputs", []):
            item_file = (item.get("file") or "").replace("\\", "/")
            if rel_path == item_file or rel_path == prefix + item_file:
                return prefix + item_file
    return None


def _repoint_reference(vault_root, slug, manifest, old_rel, new_rel):
    """Repoint whatever references old_rel (entry-relative) at new_rel, saving
    the manifest or example.json that changed. Returns True if something was
    updated.

    Mirrors _resolve_referenced_path — the two must stay in step, since a path
    that resolves but can't be repointed would orphan the converted file.
    """
    changed = False
    for key in MANIFEST_MEDIA_KEYS:
        if (manifest.get(key) or "").replace("\\", "/") == old_rel:
            manifest[key] = new_rel
            changed = True
    if changed:
        manifest["updated_at"] = utils.now_iso()
        storage.write_manifest(vault_root, slug, manifest)
        return True

    for example in storage.list_examples(vault_root, slug):
        prefix = f"examples/{example['dir']}/"
        if not old_rel.startswith(prefix):
            continue
        item_rel = old_rel[len(prefix):]  # example.json stores paths example-relative
        touched = False
        for role in ("inputs", "outputs"):
            for item in example.get(role, []):
                if (item.get("file") or "").replace("\\", "/") == item_rel:
                    item["file"] = new_rel[len(prefix):]
                    touched = True
        if touched:
            edir = storage.example_dir(vault_root, slug, example["dir"])
            saved = {k: v for k, v in example.items() if k != "dir"}
            utils.atomic_write_json(os.path.join(edir, "example.json"), saved)
            return True
    return False


def resolve_media_ref(vault_root, entry_id, rel_path):
    """Validate entry_id/rel_path and locate the file it refers to.

    Returns (info, None) or (None, error), where info carries the slug,
    manifest, entry-relative path and absolute path. Callers that only need the
    path on disk should use resolve_media_path.
    """
    if not entry_id:
        return None, "entry_id is required."
    if not rel_path:
        return None, "path is required."

    rel_path = rel_path.replace("\\", "/")
    if rel_path.startswith("/") or os.path.isabs(rel_path) or ".." in rel_path.split("/"):
        return None, "Invalid path."

    slug, manifest = storage.find_slug_by_id(vault_root, entry_id)
    if not slug:
        return None, "Entry not found."

    resolved = _resolve_referenced_path(vault_root, slug, manifest, rel_path)
    if resolved is None:
        return None, "File is not referenced by this entry."

    edir = storage.entry_dir(vault_root, slug)
    abs_path = os.path.normpath(os.path.join(edir, resolved))
    if not utils.is_path_inside(edir, abs_path):
        return None, "Invalid path."

    ext = ext_of(abs_path)
    if ext not in ALL_MEDIA_EXTS:
        return None, "Unsupported file type."

    if not os.path.isfile(abs_path):
        return None, "File not found."

    return {"slug": slug, "manifest": manifest, "rel": resolved, "abs": abs_path}, None


def resolve_media_path(vault_root, entry_id, rel_path):
    """Validate entry_id/rel_path and return (abs_path, None) or (None, error)."""
    info, err = resolve_media_ref(vault_root, entry_id, rel_path)
    return (None, err) if err else (info["abs"], None)


# --- Browser-safe H.264 conversion -----------------------------------------
# Offered when a browser reports it can't decode a video (typically H.265/HEVC
# in Firefox). The converted copy is written ALONGSIDE the original rather than
# over it: the re-encode is lossy and often drops 10-bit to 8-bit, so the
# original stays on disk and the change is reversible by hand.

def plan_h264_conversion(vault_root, entry_id, rel_path):
    """Validate a conversion request and choose the destination filename.

    Returns (plan, None) or (None, error). Deliberately does no work and takes
    no lock — the caller runs the encode off the event loop, then calls
    finish_h264_conversion to repoint the entry at the result.
    """
    info, err = resolve_media_ref(vault_root, entry_id, rel_path)
    if err:
        return None, err
    if ext_of(info["abs"]) not in VIDEO_EXTS:
        return None, "That file is not a video."
    if not video.ffmpeg_available():
        return None, "Video conversion is unavailable (ffmpeg not found)."

    codec = video.probe_video_codec(info["abs"])
    if codec == "h264":
        return None, "This video is already H.264 — converting it again would only lose quality."

    edir = storage.entry_dir(vault_root, info["slug"])
    src_dir, src_name = os.path.split(info["rel"])
    base = os.path.splitext(src_name)[0]
    dest_name = _unique_filename(os.path.join(edir, src_dir), f"{base}_h264.mp4")
    dest_rel = f"{src_dir}/{dest_name}" if src_dir else dest_name
    return {
        "slug": info["slug"],
        "codec": codec,
        "src_rel": info["rel"],
        "src_abs": info["abs"],
        "dest_rel": dest_rel,
        "dest_abs": os.path.join(edir, dest_rel),
    }, None


def finish_h264_conversion(vault_root, entry_id, plan):
    """Point the entry at the converted file. Returns (result, None) or
    (None, error). Call under the vault write lock, after the encode."""
    if not os.path.isfile(plan["dest_abs"]):
        return None, "The converted video is missing."

    def _discard():
        try:
            os.remove(plan["dest_abs"])
        except OSError:
            pass

    # The entry may have been edited while the encode ran, so re-resolve rather
    # than trusting the plan's stale manifest.
    info, err = resolve_media_ref(vault_root, entry_id, plan["src_rel"])
    if err:
        _discard()
        return None, f"The original video is no longer available ({err[0].lower()}{err[1:]})"

    if not _repoint_reference(vault_root, info["slug"], info["manifest"],
                              plan["src_rel"], plan["dest_rel"]):
        _discard()
        return None, "Could not update the entry to use the converted video."

    # Carry the source's dates over so the vault keeps sorting by when the
    # media was actually made, not when it happened to be converted.
    try:
        utils.set_file_times(plan["dest_abs"], os.path.getmtime(plan["src_abs"]),
                             ctime=os.path.getctime(plan["src_abs"]))
        before = os.path.getsize(plan["src_abs"])
        after = os.path.getsize(plan["dest_abs"])
    except OSError:
        before = after = 0
    return {"path": plan["dest_rel"], "bytes_before": before, "bytes_after": after}, None
