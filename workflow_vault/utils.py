"""Low-level helpers shared across the vault backend: ids, slugs, atomic
file writes, and path-safety checks."""

import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone


def open_in_file_manager(path):
    """Reveal a folder in the OS file manager (server-side = the user's
    machine for a local ComfyUI). Returns (ok, error)."""
    if not path or not os.path.isdir(path):
        return False, "Folder not found."
    try:
        if sys.platform.startswith("win"):
            os.startfile(os.path.normpath(path))  # noqa: B606 - intentional, local single-user tool
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
        return True, None
    except Exception as e:
        return False, f"Could not open folder: {e}"


def reveal_in_file_manager(path):
    """Open the OS file manager with a specific file selected/highlighted.
    Returns (ok, error)."""
    if not path or not os.path.exists(path):
        return False, "File not found."
    try:
        if sys.platform.startswith("win"):
            # explorer needs the unusual `/select,<path>` form as one argument.
            subprocess.Popen(f'explorer /select,"{os.path.normpath(path)}"')
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
        else:
            # Most Linux file managers can't select a file from the CLI; open
            # the containing folder instead.
            subprocess.Popen(["xdg-open", os.path.dirname(path)])
        return True, None
    except Exception as e:
        return False, f"Could not reveal file: {e}"


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def generate_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:20].upper()}"


_SLUG_INVALID_RE = re.compile(r"[^a-z0-9]+")


def slugify(name):
    slug = (name or "").strip().lower()
    slug = _SLUG_INVALID_RE.sub("_", slug)
    slug = slug.strip("_")
    return slug or "untitled"


def unique_slug(base_slug, existing_slugs):
    if base_slug not in existing_slugs:
        return base_slug
    i = 2
    while f"{base_slug}_{i}" in existing_slugs:
        i += 1
    return f"{base_slug}_{i}"


def atomic_write_text(path, text, encoding="utf-8"):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def atomic_write_json(path, data):
    atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False))


def atomic_write_bytes(path, data):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", dir=directory)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def read_json(path, default=None):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError) as e:
        # A single corrupt/unreadable file shouldn't take down a whole vault
        # scan; skip it and let callers fall back to their default.
        print(f"[Workflow Vault] Skipping unreadable JSON file: {path} ({e})")
        return default


def read_text(path, default=""):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        print(f"[Workflow Vault] Skipping unreadable file: {path} ({e})")
        return default


def is_path_inside(base, target):
    base = os.path.realpath(base)
    target = os.path.realpath(target)
    if base == target:
        return True
    try:
        common = os.path.commonpath([base, target])
    except ValueError:
        return False
    return common == base
