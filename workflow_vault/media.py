"""Media file copying, type detection, and safe media path resolution."""

import os

from . import storage, utils

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif"}
VIDEO_EXTS = {"mp4", "mov", "webm"}
AUDIO_EXTS = {"wav", "mp3", "m4a", "flac", "ogg"}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS
THUMBNAIL_EXTS = IMAGE_EXTS


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


def copy_media_bytes(dest_dir, data, filename):
    """Copy bytes into dest_dir using a safe filename, returning the final
    filename used (renamed on collision)."""
    os.makedirs(dest_dir, exist_ok=True)
    safe_name = os.path.basename(filename or "").strip() or "file"
    final_name = _unique_filename(dest_dir, safe_name)
    dest_path = os.path.join(dest_dir, final_name)
    utils.atomic_write_bytes(dest_path, data)
    return final_name


def save_thumbnail(vault_root, slug, data, filename):
    ext = ext_of(filename)
    if ext not in THUMBNAIL_EXTS:
        return None, "Unsupported thumbnail type."
    tdir = storage.thumbnails_dir(vault_root, slug)
    if os.path.isdir(tdir):
        for old in os.listdir(tdir):
            try:
                os.remove(os.path.join(tdir, old))
            except OSError:
                pass
    final_name = copy_media_bytes(tdir, data, "cover." + ext)
    return f"thumbnails/{final_name}", None


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
