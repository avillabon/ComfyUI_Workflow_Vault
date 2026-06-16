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


def set_file_times(path, mtime, ctime=None):
    """Stamp a file's modified/access time (and, on Windows, its creation time)
    so a converted file keeps its source file's date. Best-effort: never raises.

    `mtime`/`ctime` are POSIX timestamps (seconds). `ctime` defaults to `mtime`
    (uploads only know one date); the batch path passes the real creation time.
    """
    if mtime is None:
        return
    try:
        os.utime(path, (mtime, mtime))
    except OSError:
        pass
    if os.name == "nt":
        _set_windows_creation_time(path, mtime if ctime is None else ctime)


def _set_windows_creation_time(path, ctime):
    try:
        import ctypes
        from ctypes import wintypes

        # POSIX seconds -> Windows FILETIME (100ns ticks since 1601-01-01).
        ticks = int((ctime + 11644473600) * 10_000_000)
        if ticks < 0:
            return
        ft = wintypes.FILETIME(ticks & 0xFFFFFFFF, (ticks >> 32) & 0xFFFFFFFF)

        kernel32 = ctypes.windll.kernel32
        kernel32.CreateFileW.restype = wintypes.HANDLE
        GENERIC_WRITE = 0x40000000
        OPEN_EXISTING = 3
        FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
        INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

        handle = kernel32.CreateFileW(
            ctypes.c_wchar_p(str(path)), GENERIC_WRITE, 0, None,
            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, None,
        )
        if not handle or handle == INVALID_HANDLE_VALUE:
            return
        try:
            kernel32.SetFileTime(handle, ctypes.byref(ft), None, None)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        pass


def trash_label():
    """The user-facing name of the OS trash, for UI copy."""
    if sys.platform.startswith("win"):
        return "Recycle Bin"
    return "Trash"


def send_to_trash(path):
    """Delete a file/folder, preferring the OS trash so the delete is
    recoverable. Returns "trash" if it reached the trash, or "permanent" if no
    trash mechanism was available on this platform and it was removed for good
    instead. Raises OSError if the path can't be removed at all.

    Trash support is best-effort and dependency-free, per platform:
      - Windows: SHFileOperationW          -> Recycle Bin
      - macOS:   Finder via osascript      -> Trash
      - Linux:   `gio trash` / `trash-put` -> XDG Trash
    The cross-platform `send2trash` package, if it happens to be installed, is
    tried first since it handles every platform correctly."""
    path = os.path.normpath(path)
    if not os.path.exists(path):
        raise OSError("Path not found.")

    if _move_to_trash(path):
        return "trash"

    # Fallback: permanent removal (no trash available on this platform/setup).
    import shutil

    if os.path.isdir(path):
        shutil.rmtree(path)
    else:
        os.remove(path)
    return "permanent"


def _move_to_trash(path):
    """Best-effort move to the OS trash. Returns True on success, False if no
    trash mechanism worked (caller then falls back to a permanent delete)."""
    # 1. send2trash when available — correct on every platform it supports.
    try:
        from send2trash import send2trash as _s2t

        _s2t(path)
        return not os.path.exists(path)
    except ImportError:
        pass
    except Exception:
        # Installed but failed (e.g. unsupported filesystem); try OS natives.
        pass

    # 2. Platform-native, no extra dependencies.
    if sys.platform.startswith("win"):
        return _windows_recycle(path)
    if sys.platform == "darwin":
        return _macos_trash(path)
    return _linux_trash(path)


def _macos_trash(path):
    """Move a path to the macOS Trash by asking Finder via osascript. The path
    is passed as an argument (not interpolated) to avoid quoting/injection."""
    script = (
        "on run argv\n"
        "tell application \"Finder\" to delete (POSIX file (item 1 of argv) as alias)\n"
        "end run"
    )
    try:
        res = subprocess.run(
            ["osascript", "-e", script, os.path.abspath(path)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
        return res.returncode == 0 and not os.path.exists(path)
    except Exception:
        return False


def _linux_trash(path):
    """Move a path to the XDG Trash using whichever helper is installed. `gio`
    (glib) is near-universal on desktop Linux and implements the freedesktop
    Trash spec correctly, including cross-filesystem handling."""
    import shutil as _shutil

    candidates = (
        ["gio", "trash", "--", path],
        ["trash-put", "--", path],
        ["trash", "--", path],
    )
    for argv in candidates:
        if not _shutil.which(argv[0]):
            continue
        try:
            res = subprocess.run(
                argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30
            )
            if res.returncode == 0 and not os.path.exists(path):
                return True
        except Exception:
            continue
    return False


def _windows_recycle(path):
    """Send a path to the Windows Recycle Bin via SHFileOperationW. Returns
    True on success, False if the shell call failed (caller then falls back to
    a permanent delete)."""
    try:
        import ctypes
        from ctypes import wintypes

        FO_DELETE = 3
        FOF_SILENT = 0x0004
        FOF_NOCONFIRMATION = 0x0010
        FOF_ALLOWUNDO = 0x0040  # this is what routes it to the Recycle Bin
        FOF_NOERRORUI = 0x0400

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [
                ("hwnd", wintypes.HWND),
                ("wFunc", wintypes.UINT),
                ("pFrom", wintypes.LPCWSTR),
                ("pTo", wintypes.LPCWSTR),
                ("fFlags", ctypes.c_uint16),
                ("fAnyOperationsAborted", wintypes.BOOL),
                ("hNameMappings", ctypes.c_void_p),
                ("lpszProgressTitle", wintypes.LPCWSTR),
            ]

        op = SHFILEOPSTRUCTW()
        op.hwnd = None
        op.wFunc = FO_DELETE
        # pFrom must be a double-null-terminated list of paths.
        op.pFrom = os.path.abspath(path) + "\0\0"
        op.pTo = None
        op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI

        shell32 = ctypes.windll.shell32
        shell32.SHFileOperationW.argtypes = [ctypes.c_void_p]
        shell32.SHFileOperationW.restype = ctypes.c_int
        res = shell32.SHFileOperationW(ctypes.byref(op))
        return res == 0 and not op.fAnyOperationsAborted
    except Exception:
        return False


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
