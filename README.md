# ComfyUI Workflow Vault

A local, single-user workflow library built into ComfyUI. Save workflows as
structured "vault entries" with versions, example media, and Markdown
documentation — then browse, search, and reopen them later.

Everything is stored as plain files (JSON, Markdown, images/video/audio) in a
folder you choose on disk. No database, no account, no cloud sync.

## Installation

1. Copy (or clone) this folder into your ComfyUI `custom_nodes` directory, so
   you end up with `ComfyUI/custom_nodes/Comfy_Workflow_Vault/`.
2. Restart ComfyUI.
3. No extra Python dependencies are required — the backend uses only the
   standard library plus `aiohttp`, which ComfyUI already bundles.

## First run

Two **Workflow Vault** buttons appear in the left sidebar rail:

- 🗄 **Vault** — opens the vault to browse and manage your saved workflows.
- 💾 **Save** — saves the current canvas to the vault. The Save wizard lets you
  create a new entry or update an existing one (overwrite the current version,
  or add a new version). If the canvas was opened from a vault entry, Save
  defaults to updating that entry.

The first time you open the vault, you'll be asked to choose a folder on disk
to use as your vault root. This folder is remembered for future sessions.

If you just want to explore the UI without setting anything up, click
**"Use included sample vault"** on that screen — it points the vault at the
`sample_vault/` folder bundled with this extension, which contains a few
example entries (image, video, and audio workflows) with versions, docs, and
example media already filled in. You can switch to your own folder later from
**Vault Settings** (⚙).

## Features

- **Grid view** with search, a status filter, Favorites / Show-archived
  toggles, a nested folder tree and a **Generation Type** filter in the
  sidebar, sort controls, and a per-row density control (2, 3, or 4 across).
  Each card shows the status, generation type, a favorite toggle, and a
  one-click "open workflow" button.
- **Entry detail view** with tabs:
  - **Overview** — a read-only summary (description, tags, status, folder,
    thumbnail) plus "Open folder" / "Export (.zip)" actions, followed by a
    gallery of all example media (images, video, audio). Each example supports
    a before/after compare slider for image input/output pairs and a
    "reveal in folder" action; notes show alongside the media.
  - **Notes** — one or more Markdown notes per entry (stored together in a
    single `notes.json`), shown as sub-tabs you can add, rename, and delete,
    rendered as Markdown with an Edit toggle for in-place editing.
  - **Settings** — segmented sub-tabs:
    - **Workflow Details** — editable metadata (name, description, tags with
      autocomplete, status, generation type, folder, a favorite switch, and a
      thumbnail) plus stats (created/updated dates, version/example counts).
    - **Versions** — full version history (add a new version, overwrite the
      current one, promote, edit notes).
    - **Examples** — add/edit/delete examples and their input/output media,
      with previews, drag to move media within or between Inputs/Outputs, and
      up/down reordering of examples.
- **Folder management** — create, rename, move, and delete nested folders
  from the sidebar, including inline "create new folder" from any folder
  picker.
- **Global vault settings** — change the vault root folder, set defaults for
  new entries (status, thumbnail behavior), and view basic vault stats.
- **Save wizard** — save the current canvas as a new entry, or as a new
  version / overwrite of an existing entry, optionally attaching notes and one
  or more examples (input/output media) in the same step.

## On-disk layout

```
<vault root>/
  vault_settings.json
  folders.json
  entries/
    <entry_slug>/
      manifest.json
      notes.json
      thumbnails/cover.<ext>
      versions/
        v001/{version.json, workflow.json}
        ...
      examples/
        example_001/{example.json, inputs/, outputs/}
        ...
```

## Notes

All vault data is plain files on disk, so it's easy to back up, move, or
inspect. The bundled `sample_vault/` is just example data — your own entries
live in whichever vault root you choose, separate from this extension.
