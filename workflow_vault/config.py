"""Vault root configuration and vault initialization.

Two layers of settings exist:

- ``vault_config.json`` lives next to this extension and only stores which
  folder the user picked as their vault root. It must exist outside the
  vault itself, since it is needed before a vault root has been chosen.
- ``vault_settings.json`` lives inside the vault root and stores
  vault-level preferences (show archived, default status, etc).
"""

import os

from . import utils

EXTENSION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION_CONFIG_PATH = os.path.join(EXTENSION_DIR, "vault_config.json")

DEFAULT_VAULT_SETTINGS = {
    "schema_version": "1.0",
    "show_archived": False,
    "default_thumbnail_behavior": "placeholder",
    "grid_columns": 3,
    "sort": "updated",
    # Accent color applied to icons and the brand logo (CSS --wv-accent).
    "accent_color": "#4d9fff",
    # Auto-compress example images to smaller files as they're uploaded.
    "compress_examples_on_upload": True,
    "example_compress_format": "webp",  # "webp" | "jpeg"
    # Re-encode the archival full-resolution thumbnail source to WebP (keeps
    # full resolution and the embedded ComfyUI workflow; just smaller on disk).
    "compress_thumbnail_source": True,
    # Which optional fields appear on grid cards (cosmetic only).
    "card_fields": {
        "description": True,
        "tags": True,
        "versions": True,
        "examples": True,
        "date": True,
    },
}

VALID_SORTS = ("updated", "created", "name")
CARD_FIELD_KEYS = ("description", "tags", "versions", "examples", "date")
VALID_COMPRESS_FORMATS = ("webp", "jpeg")


def load_extension_config():
    return utils.read_json(EXTENSION_CONFIG_PATH, default={}) or {}


def save_extension_config(cfg):
    utils.atomic_write_json(EXTENSION_CONFIG_PATH, cfg)


def get_vault_root():
    cfg = load_extension_config()
    root = cfg.get("vault_root")
    if root and os.path.isdir(root):
        return root
    return None


def set_vault_root(path):
    cfg = load_extension_config()
    cfg["vault_root"] = path
    save_extension_config(cfg)


def validate_vault_root(path):
    """Validate a candidate vault root path. Returns (ok, error_message)."""
    if not path or not path.strip():
        return False, "Path is required."
    path = path.strip()
    if os.path.exists(path):
        if not os.path.isdir(path):
            return False, "Path exists but is not a directory."
        if not os.access(path, os.W_OK):
            return False, "Path is not writable."
        return True, None
    parent = os.path.dirname(os.path.abspath(path)) or path
    if not os.path.isdir(parent):
        return False, "Parent directory does not exist."
    if not os.access(parent, os.W_OK):
        return False, "Parent directory is not writable."
    return True, None


def entries_dir(vault_root):
    return os.path.join(vault_root, "entries")


def is_initialized(vault_root):
    settings_path = os.path.join(vault_root, "vault_settings.json")
    folders_path = os.path.join(vault_root, "folders.json")
    return (
        os.path.isfile(settings_path)
        and os.path.isfile(folders_path)
        and os.path.isdir(entries_dir(vault_root))
    )


def is_empty(vault_root):
    if not os.path.isdir(vault_root):
        return True
    return len(os.listdir(vault_root)) == 0


def initialize_vault(vault_root):
    os.makedirs(vault_root, exist_ok=True)
    os.makedirs(entries_dir(vault_root), exist_ok=True)
    settings_path = os.path.join(vault_root, "vault_settings.json")
    folders_path = os.path.join(vault_root, "folders.json")
    if not os.path.isfile(settings_path):
        utils.atomic_write_json(settings_path, dict(DEFAULT_VAULT_SETTINGS))
    if not os.path.isfile(folders_path):
        utils.atomic_write_json(folders_path, {"folders": []})


def load_vault_settings(vault_root):
    settings = utils.read_json(os.path.join(vault_root, "vault_settings.json"), default={})
    merged = dict(DEFAULT_VAULT_SETTINGS)
    merged.update(settings or {})
    # Deep-merge card_fields so a partial stored value still carries defaults
    # for any keys added in later versions.
    card_fields = dict(DEFAULT_VAULT_SETTINGS["card_fields"])
    stored = (settings or {}).get("card_fields")
    if isinstance(stored, dict):
        card_fields.update({k: bool(v) for k, v in stored.items() if k in CARD_FIELD_KEYS})
    merged["card_fields"] = card_fields
    return merged


def save_vault_settings(vault_root, updates):
    current = load_vault_settings(vault_root)
    current.update(updates)
    utils.atomic_write_json(os.path.join(vault_root, "vault_settings.json"), current)
    return current
