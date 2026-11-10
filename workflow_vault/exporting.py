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
                    if os.path.basename(root) == "attachments" and name.startswith(".upload_"):
                        continue  # an upload still in progress is not part of the entry
                    abs_path = os.path.join(root, name)
                    rel = os.path.relpath(abs_path, source_root)
                    compression = zipfile.ZIP_STORED if "attachments" in rel.split(os.sep) else zipfile.ZIP_DEFLATED
                    zf.write(abs_path, os.path.join(arc_root, rel), compress_type=compression)
        return tmp_path
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
