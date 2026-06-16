"""Media file copying, type detection, safe path resolution, and optional
image compression (Pillow — already bundled by ComfyUI)."""

import io
import json
import os

from . import storage, utils

# Pillow ships with ComfyUI, but guard the import so the vault still works
# (just without compression) in the rare environment where it's unavailable.
try:
    from PIL import Image

    _PIL_AVAILABLE = True
except Exception:  # pragma: no cover - defensive
    _PIL_AVAILABLE = False

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif"}
VIDEO_EXTS = {"mp4", "mov", "webm"}
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
    """Save the small display thumbnail as thumbnails/cover.<ext>."""
    ext = ext_of(filename)
    if ext not in THUMBNAIL_EXTS:
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

    Returns (rel_path, compressed, error)."""
    ext = ext_of(filename)
    if ext not in THUMBNAIL_EXTS:
        return None, False, "Unsupported thumbnail source type."
    compressed = False
    if compress:
        result = compress_example_image(data, filename, "webp")
        if result:
            data, filename = result
            compressed = True
    tdir = storage.thumbnails_dir(vault_root, slug)
    _clear_prefixed(tdir, "source.")
    final_name = copy_media_bytes(tdir, data, "source." + ext_of(filename), mtime=mtime)
    return f"thumbnails/{final_name}", compressed, None


def _resolve_referenced_path(vault_root, slug, manifest, rel_path):
    """Return the entry-relative path for rel_path if it is referenced by
    this entry's thumbnail or example media, else None.

    rel_path may already be entry-relative (e.g. "thumbnails/cover.png") or,
    for example media, relative to the example's own directory (e.g.
    "outputs/CLIP B.mp4"), since that's how item["file"] is stored and how
    the frontend requests it.
    """
    if (manifest.get("thumbnail") or "").replace("\\", "/") == rel_path:
        return rel_path
    if (manifest.get("thumbnail_source") or "").replace("\\", "/") == rel_path:
        return rel_path
    for example in storage.list_examples(vault_root, slug):
        prefix = f"examples/{example['dir']}/"
        for item in example.get("inputs", []) + example.get("outputs", []):
            item_file = (item.get("file") or "").replace("\\", "/")
            if rel_path == item_file or rel_path == prefix + item_file:
                return prefix + item_file
    return None


def resolve_media_path(vault_root, entry_id, rel_path):
    """Validate entry_id/rel_path and return (abs_path, None) or (None, error)."""
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

    return abs_path, None
