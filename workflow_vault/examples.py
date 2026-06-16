"""Reference-only examples: input/output media for an entry."""

import os
import shutil

from . import media, storage, utils


def _next_example_dir(vault_root, slug):
    nums = []
    for e in storage.list_examples(vault_root, slug):
        d = e.get("dir", "")
        if d.startswith("example_"):
            try:
                nums.append(int(d.split("_")[1]))
            except (IndexError, ValueError):
                pass
    n = (max(nums) + 1) if nums else 1
    return f"example_{n:03d}"


def _save_media_list(dest_dir, files, subdir_name):
    """Returns (items, skipped_filenames). Files with an unsupported
    extension are skipped rather than copied."""
    items = []
    skipped = []
    for f in files or []:
        ext = media.ext_of(f.get("filename"))
        mtype = media.media_type_for_ext(ext)
        if not mtype:
            skipped.append(f.get("filename") or "(unnamed file)")
            continue
        final_name = media.copy_media_bytes(dest_dir, f["bytes"], f["filename"])
        items.append({
            "id": utils.generate_id("media"),
            "type": mtype,
            "label": (f.get("label") or "").strip() or os.path.splitext(f["filename"])[0],
            "file": f"{subdir_name}/{final_name}",
            "original_filename": f["filename"],
        })
    return items, skipped


def create_example(vault_root, manifest, slug, data, input_files=None, output_files=None):
    """data: title, notes. Returns (example, error, skipped_filenames)."""
    example_dir_name = _next_example_dir(vault_root, slug)
    edir = storage.example_dir(vault_root, slug, example_dir_name)
    inputs_dir = os.path.join(edir, "inputs")
    outputs_dir = os.path.join(edir, "outputs")
    os.makedirs(inputs_dir, exist_ok=True)
    os.makedirs(outputs_dir, exist_ok=True)

    inputs, skipped_in = _save_media_list(inputs_dir, input_files, "inputs")
    outputs, skipped_out = _save_media_list(outputs_dir, output_files, "outputs")

    example = {
        "id": utils.generate_id("example"),
        "label": example_dir_name,
        "title": (data.get("title") or "").strip(),
        "notes": data.get("notes") or "",
        "inputs": inputs,
        "outputs": outputs,
    }
    # If siblings already carry an explicit order, keep this one last so it
    # doesn't jump ahead of an existing custom arrangement.
    sibling_orders = [e["order"] for e in storage.list_examples(vault_root, slug) if e.get("order") is not None]
    if sibling_orders:
        example["order"] = max(sibling_orders) + 1
    utils.atomic_write_json(os.path.join(edir, "example.json"), example)
    manifest["updated_at"] = utils.now_iso()
    example["dir"] = example_dir_name
    return example, None, skipped_in + skipped_out


def _find_example(vault_root, slug, example_id):
    for e in storage.list_examples(vault_root, slug):
        if e.get("id") == example_id:
            return e
    return None


def _apply_media_layout(edir, example, new_inputs, new_outputs):
    """Reconcile the example's inputs/outputs to the given ordered specs.

    Items may move between the two sections (their file is relocated between
    the inputs/ and outputs/ folders); items absent from both specs are
    deleted. Each spec is {id, label?}."""
    current = {}
    for role in ("inputs", "outputs"):
        for item in example.get(role, []):
            current[item["id"]] = [role, item]

    kept = set()

    def build(specs, target_role):
        result = []
        for spec in specs or []:
            ref = current.get(spec.get("id"))
            if not ref:
                continue
            cur_role, item = ref
            if spec.get("label") is not None:
                item["label"] = (spec["label"] or "").strip() or item["label"]
            if cur_role != target_role:
                target_dir = os.path.join(edir, target_role)
                os.makedirs(target_dir, exist_ok=True)
                final_name = media._unique_filename(target_dir, os.path.basename(item["file"]))
                new_rel = f"{target_role}/{final_name}"
                try:
                    os.rename(os.path.join(edir, item["file"]), os.path.join(edir, new_rel))
                    item["file"] = new_rel
                    ref[0] = target_role
                except OSError:
                    pass  # leave the file where it is if the move fails
            result.append(item)
            kept.add(item["id"])
        return result

    inputs = build(new_inputs, "inputs")
    outputs = build(new_outputs, "outputs")

    for iid, (role, item) in current.items():
        if iid not in kept:
            fpath = os.path.join(edir, item["file"])
            if os.path.isfile(fpath):
                try:
                    os.remove(fpath)
                except OSError:
                    pass

    example["inputs"] = inputs
    example["outputs"] = outputs


def update_example(vault_root, manifest, slug, example_id, data,
                    new_input_files=None, new_output_files=None):
    """Returns (example, error, skipped_filenames)."""
    example = _find_example(vault_root, slug, example_id)
    if not example:
        return None, "Example not found.", []

    edir = storage.example_dir(vault_root, slug, example["dir"])

    if "title" in data:
        example["title"] = (data["title"] or "").strip()
    if "notes" in data:
        example["notes"] = data["notes"] or ""

    if "inputs" in data or "outputs" in data:
        cur_inputs = [{"id": it["id"], "label": it.get("label")} for it in example.get("inputs", [])]
        cur_outputs = [{"id": it["id"], "label": it.get("label")} for it in example.get("outputs", [])]
        _apply_media_layout(edir, example, data.get("inputs", cur_inputs), data.get("outputs", cur_outputs))

    skipped = []
    if new_input_files:
        new_items, skipped_in = _save_media_list(os.path.join(edir, "inputs"), new_input_files, "inputs")
        example["inputs"] = example.get("inputs", []) + new_items
        skipped += skipped_in
    if new_output_files:
        new_items, skipped_out = _save_media_list(os.path.join(edir, "outputs"), new_output_files, "outputs")
        example["outputs"] = example.get("outputs", []) + new_items
        skipped += skipped_out

    saved = {k: v for k, v in example.items() if k != "dir"}
    utils.atomic_write_json(os.path.join(edir, "example.json"), saved)
    manifest["updated_at"] = utils.now_iso()
    example["dir"] = example["dir"]
    return example, None, skipped


def reorder_examples(vault_root, manifest, slug, ordered_ids):
    """Persist a new example order. ordered_ids is the full list of example
    ids in the desired order; any examples not listed are appended after,
    keeping their current relative order. Returns (ok, error)."""
    existing = storage.list_examples(vault_root, slug)
    by_id = {e["id"]: e for e in existing}
    sequence = [eid for eid in (ordered_ids or []) if eid in by_id]
    for e in existing:
        if e["id"] not in sequence:
            sequence.append(e["id"])

    for order, eid in enumerate(sequence):
        e = by_id[eid]
        edir = storage.example_dir(vault_root, slug, e["dir"])
        saved = {k: v for k, v in e.items() if k != "dir"}
        saved["order"] = order
        utils.atomic_write_json(os.path.join(edir, "example.json"), saved)

    manifest["updated_at"] = utils.now_iso()
    return True, None


def delete_example(vault_root, manifest, slug, example_id):
    example = _find_example(vault_root, slug, example_id)
    if not example:
        return False, "Example not found."
    edir = storage.example_dir(vault_root, slug, example["dir"])
    shutil.rmtree(edir, ignore_errors=True)
    manifest["updated_at"] = utils.now_iso()
    return True, None
