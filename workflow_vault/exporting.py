"""Zip export helpers shared by API routes and tests."""

import os
import re
import tempfile
import zipfile

from . import storage


def download_name(name, fallback):
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name or "").strip()).strip("._")
    return safe or fallback


def build_zip_file(source_root, arc_root, skip_staging=False):
    """Build a zip archive in a temp file and return its path."""
    fd, tmp_path = tempfile.mkstemp(prefix="workflow_vault_", suffix=".zip")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for root, dirs, files in os.walk(source_root):
                if skip_staging:
                    dirs[:] = [d for d in dirs if not d.startswith(storage.staging_entry_prefix())]
                for name in files:
                    abs_path = os.path.join(root, name)
                    rel = os.path.relpath(abs_path, source_root)
                    zf.write(abs_path, os.path.join(arc_root, rel))
        return tmp_path
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
