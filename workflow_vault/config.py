"""Vault root configuration and vault initialization.

Two layers of settings exist:

- ``vault_config.json`` lives next to this extension and only stores which
  folder the user picked as their vault root, plus the list of named profiles
  (each its own vault root) and which one is active. It must exist outside the
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


# ---------------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------------
#
# A profile is a named vault root (e.g. "Work" and "Personal", each its own
# folder). The UI calls them "vaults"; the code, API routes, and
# vault_config.json keep the name "profiles" so configs need no migration.
# folder with its own entries, tags, and settings). ``vault_root`` in
# vault_config.json always mirrors the *active* profile's root, so everything
# that only needs "the current vault" keeps calling get_vault_root() unchanged.
# Configs written before profiles existed carry just ``vault_root``; they are
# read as a single "Default" profile and rewritten in the new shape on the
# next change.

DEFAULT_PROFILE_NAME = "Default"
MAX_PROFILE_NAME_LEN = 60
PROFILE_NOT_FOUND = "Vault not found."


def _same_path(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def clean_profile_name(name):
    """Collapse whitespace and trim. Returns '' for non-strings."""
    if not isinstance(name, str):
        return ""
    return " ".join(name.split())


def _name_taken(profiles, name, ignore_id=None):
    wanted = name.casefold()
    return any(p["name"].casefold() == wanted and p["id"] != ignore_id for p in profiles)


def _unique_name(profiles, base):
    name, n = base, 2
    while _name_taken(profiles, name):
        name = f"{base} {n}"
        n += 1
    return name


def _resolve_profiles(cfg):
    """Return (profiles, active_id) for a config dict, without writing anything.

    ``vault_root`` is the source of truth for which vault is active: if the
    stored active profile disagrees with it (an older version re-pointed the
    root), the profile that owns that root wins, or one is created for it."""
    profiles = []
    seen_ids = set()
    for p in cfg.get("profiles") or []:
        if not isinstance(p, dict):
            continue
        pid, name, root = p.get("id"), clean_profile_name(p.get("name")), p.get("vault_root")
        if not (isinstance(pid, str) and pid and name and isinstance(root, str) and root):
            continue
        if pid in seen_ids:
            continue
        seen_ids.add(pid)
        profiles.append({"id": pid, "name": name, "vault_root": root})

    root = cfg.get("vault_root")
    active = cfg.get("active_profile")
    if root:
        match = next((p for p in profiles if p["id"] == active and _same_path(p["vault_root"], root)), None)
        if not match:
            match = next((p for p in profiles if _same_path(p["vault_root"], root)), None)
        if not match:
            match = {
                "id": "default" if "default" not in seen_ids else utils.generate_id("profile"),
                "name": _unique_name(profiles, DEFAULT_PROFILE_NAME),
                "vault_root": root,
            }
            profiles.append(match)
        return profiles, match["id"]
    return profiles, (active if active in seen_ids else None)


def _save_profiles(cfg, profiles, active_id):
    cfg["profiles"] = profiles
    cfg["active_profile"] = active_id
    active = next((p for p in profiles if p["id"] == active_id), None)
    if active:
        cfg["vault_root"] = active["vault_root"]
    save_extension_config(cfg)


def list_profiles():
    """Return {"profiles": [{id, name, vault_root}], "active": id or None}."""
    profiles, active = _resolve_profiles(load_extension_config())
    return {"profiles": profiles, "active": active}


def set_vault_root(path):
    """Point the active profile at ``path`` (creating a profile if there is
    none yet). If another profile already uses ``path``, that profile becomes
    active instead of two profiles sharing one folder."""
    cfg = load_extension_config()
    profiles, active = _resolve_profiles(cfg)
    owner = next((p for p in profiles if _same_path(p["vault_root"], path)), None)
    if owner:
        active = owner["id"]
        owner["vault_root"] = path
    elif active:
        next(p for p in profiles if p["id"] == active)["vault_root"] = path
    else:
        active = "default"
        profiles.append({"id": active, "name": DEFAULT_PROFILE_NAME, "vault_root": path})
    _save_profiles(cfg, profiles, active)


def validate_new_profile(name, vault_root):
    """Check a candidate (name, folder) pair. Returns an error message or None."""
    name = clean_profile_name(name)
    if not name:
        return "Vault name is required."
    if len(name) > MAX_PROFILE_NAME_LEN:
        return f"Vault name must be {MAX_PROFILE_NAME_LEN} characters or fewer."
    profiles, _active = _resolve_profiles(load_extension_config())
    if _name_taken(profiles, name):
        return f"A vault named “{name}” already exists."
    if any(_same_path(p["vault_root"], vault_root) for p in profiles):
        return "Another vault already uses that folder."
    return None


def create_profile(name, vault_root, activate=True):
    """Add a profile. The caller validates (validate_new_profile) and
    initializes the folder first. Returns the new profile dict."""
    cfg = load_extension_config()
    profiles, active = _resolve_profiles(cfg)
    profile = {"id": utils.generate_id("profile"), "name": clean_profile_name(name), "vault_root": vault_root}
    profiles.append(profile)
    _save_profiles(cfg, profiles, profile["id"] if activate else active)
    return profile


def activate_profile(profile_id):
    """Make a profile the active one. Returns (profile, error_message).

    A vault folder that has gone missing (unplugged drive, moved install) is
    reported rather than silently recreated, so switching can never fork a
    profile's data into a new empty folder."""
    cfg = load_extension_config()
    profiles, _active = _resolve_profiles(cfg)
    profile = next((p for p in profiles if p["id"] == profile_id), None)
    if not profile:
        return None, PROFILE_NOT_FOUND
    if not os.path.isdir(profile["vault_root"]):
        return None, f"The folder for “{profile['name']}” no longer exists: {profile['vault_root']}"
    if not is_initialized(profile["vault_root"]):
        initialize_vault(profile["vault_root"])
    _save_profiles(cfg, profiles, profile["id"])
    return profile, None


def rename_profile(profile_id, name):
    """Returns (profile, error_message)."""
    name = clean_profile_name(name)
    if not name:
        return None, "Vault name is required."
    if len(name) > MAX_PROFILE_NAME_LEN:
        return None, f"Vault name must be {MAX_PROFILE_NAME_LEN} characters or fewer."
    cfg = load_extension_config()
    profiles, active = _resolve_profiles(cfg)
    profile = next((p for p in profiles if p["id"] == profile_id), None)
    if not profile:
        return None, PROFILE_NOT_FOUND
    if _name_taken(profiles, name, ignore_id=profile_id):
        return None, f"A vault named “{name}” already exists."
    profile["name"] = name
    _save_profiles(cfg, profiles, active)
    return profile, None


def remove_profile(profile_id):
    """Forget a profile. Its folder and contents are left untouched on disk.
    Returns an error message or None."""
    cfg = load_extension_config()
    profiles, active = _resolve_profiles(cfg)
    if not any(p["id"] == profile_id for p in profiles):
        return PROFILE_NOT_FOUND
    if profile_id == active:
        return "Switch to another vault before removing this one."
    _save_profiles(cfg, [p for p in profiles if p["id"] != profile_id], active)
    return None


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
