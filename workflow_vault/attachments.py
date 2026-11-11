"""Entry-level archival files. Originals are stored unchanged beside the entry."""

import asyncio
import hashlib
import os
import re
import tempfile

from . import storage, utils

MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB per file
MAX_ATTACHMENT_NOTE_CHARS = 2000


def _normalize_note(note):
    if isinstance(note, str):
        note = note.replace("\r\n", "\n").replace("\r", "\n")
        if len(note) <= MAX_ATTACHMENT_NOTE_CHARS:
            return note.strip()
    raise ValueError("File note must be at most 2,000 characters.")


def _directory(vault_root, slug):
    directory = os.path.join(storage.entry_dir(vault_root, slug), "attachments")
    if os.path.islink(directory):
        raise ValueError("Attachment folder cannot be a link.")
    return directory


def _filename(raw):
    name = str(raw or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(c for c in name if c.isprintable() and c not in '<>:"/\\|?*').strip(" .")
    if not name or len(name) > 255:
        raise ValueError("File name is empty or too long.")
    return name


def _path(vault_root, slug, record):
    filename = record.get("file", "")
    if not isinstance(filename, str) or not re.fullmatch(r"attachment_[A-F0-9]{20}(?:\.[a-z0-9]{1,20})?", filename):
        raise ValueError("Invalid attachment record.")
    directory = _directory(vault_root, slug)
    path = os.path.join(directory, filename)
    if os.path.islink(path):
        raise ValueError("Attachment cannot be a link.")
    return path


def find(vault_root, slug, attachment_id):
    record = next((a for a in storage.read_attachments(vault_root, slug) if a.get("id") == attachment_id), None)
    if record is None:
        return None, None
    return record, _path(vault_root, slug, record)


async def save_upload(vault_root, slug, part, note=""):
    """Stream one multipart file to a temporary file, then publish metadata."""
    note = _normalize_note(note)
    name = _filename(part.filename)
    directory = _directory(vault_root, slug)
    os.makedirs(directory, exist_ok=True)
    attachment_id = utils.generate_id("attachment")
    extension = os.path.splitext(name)[1].lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,20}", extension):
        extension = ""
    filename = attachment_id + extension
    final_path = os.path.join(directory, filename)
    fd, temp_path = tempfile.mkstemp(prefix=".upload_", dir=directory)
    digest = hashlib.sha256()
    size = 0
    published = False
    try:
        with os.fdopen(fd, "wb") as output:
            while True:
                chunk = await part.read_chunk(size=1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES:
                    raise ValueError("File exceeds the 2 GiB attachment limit.")
                await asyncio.to_thread(output.write, chunk)
                digest.update(chunk)
            await asyncio.to_thread(output.flush)
            await asyncio.to_thread(os.fsync, output.fileno())
        if not size:
            raise ValueError("Empty files cannot be attached.")
        record = {
            "id": attachment_id,
            "name": name,
            "file": filename,
            "size": size,
            "sha256": digest.hexdigest(),
            "note": note,
            "added_at": utils.now_iso(),
        }
        os.replace(temp_path, final_path)
        published = True
        records = storage.read_attachments(vault_root, slug)
        storage.write_attachments(vault_root, slug, records + [record])
        return record
    except Exception:
        if published:
            try:
                os.remove(final_path)
            except OSError:
                pass
        raise
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def update_note(vault_root, slug, attachment_id, note):
    note = _normalize_note(note)
    records = storage.read_attachments(vault_root, slug)
    record = next((a for a in records if a.get("id") == attachment_id), None)
    if record is None:
        return False
    record["note"] = note
    storage.write_attachments(vault_root, slug, records)
    return True


def remove(vault_root, slug, attachment_id):
    records = storage.read_attachments(vault_root, slug)
    record = next((a for a in records if a.get("id") == attachment_id), None)
    if record is None:
        return None
    path = _path(vault_root, slug, record)
    storage.write_attachments(vault_root, slug, [a for a in records if a.get("id") != attachment_id])
    try:
        if os.path.isfile(path):
            utils.send_to_trash(path)
    except Exception:
        storage.write_attachments(vault_root, slug, records)
        raise
    return record
