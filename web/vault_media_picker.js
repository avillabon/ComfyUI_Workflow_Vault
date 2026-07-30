// Shared "add media" widget: a themed drag-and-drop zone to pick one or more
// files, then mark each as an input (reference) or output (result) before
// submitting. Returns { element, isEmpty(), getByRole(role) }.
//
// Two layouts:
//   - default (list): a single dropzone with a compact filename list. Used
//     where media is uploaded immediately on drop.
//   - preview (tiles): Inputs/Outputs sections, each a grid of thumbnail tiles
//     with an "Add media" tile. Used in the wizard + add-example form, where
//     files are gathered before a single submit.

import { el, clear, videoEl, showToast, confirmDialog } from "./vault_dom.js";
import { canvasAvailable, detectCanvasMedia, fetchCanvasFile } from "./vault_canvas_media.js";
import { onPasteInto, renderPasteButton } from "./vault_clipboard.js";
import { probeVideoCodec } from "./vault_codec_probe.js";
import { VaultAPI } from "./vault_api.js";

export const MEDIA_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,.wav,.mp3,.m4a,.flac,.ogg";
const MEDIA_EXTS = MEDIA_ACCEPT.split(",").map((e) => e.replace(".", "").trim());
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXTS = ["mp4", "mov", "webm"];
const MAX_MEDIA_BYTES = 256 * 1024 * 1024; // hard limit, matches backend MAX_UPLOAD_BYTES
const WARN_MEDIA_BYTES = 50 * 1024 * 1024; // soft limit: warn before adding

function extOf(name) {
  const i = (name || "").lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function kindOf(name) {
  const ext = extOf(name);
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  return "audio";
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDuration(seconds) {
  if (!isFinite(seconds)) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function renderMediaPicker({ accept = MEDIA_ACCEPT, onChange, preview = false, role = "output", label } = {}) {
  const media = [];

  const wrap = el("div", { className: "wv-media-picker" });
  const fileInput = el("input", { type: "file", multiple: true, accept, className: "wv-visually-hidden" });

  // Role to assign to files chosen via the hidden input (set just before the
  // input is opened by whichever "Add media" affordance was clicked).
  let pendingRole = role;

  function validate(file) {
    if (!MEDIA_EXTS.includes(extOf(file.name))) {
      showToast(`"${file.name}" is an unsupported file type.`, "error");
      return false;
    }
    if (file.size > MAX_MEDIA_BYTES) {
      showToast(`"${file.name}" exceeds the ${MAX_MEDIA_BYTES / (1024 * 1024)} MB limit.`, "error");
      return false;
    }
    return true;
  }

  function isProbeCandidate(entry) {
    return kindOf(entry.file.name) === "video" && ["mp4", "mov"].includes(extOf(entry.file.name));
  }

  // Probes a freshly-added video for H.265/HEVC in the background and
  // re-renders once known. Silently no-ops for images/audio, non-MP4/MOV
  // containers, and anything that fails to parse. Callers that auto-commit on
  // a debounce (the examples ghost slot, per-example add zones, the wizard)
  // treat any onChange while a probe is still pending — or once one comes
  // back positive — as a request for a much longer delay via { longDelay:
  // true }. A plain 400ms coalescing delay would otherwise race the probe:
  // if it lost, the batch would auto-upload before the codec was even known,
  // let alone before the warning badge and its convert toggle were visible
  // long enough to click.
  function probeIfVideo(entry) {
    if (!isProbeCandidate(entry)) return;
    entry.probeDone = probeVideoCodec(entry.file).then((codec) => {
      if (!media.includes(entry)) return; // removed before the probe resolved
      if (codec === "hevc") {
        entry.hevc = true;
        renderUI();
        onChange?.({ longDelay: true });
      }
    });
  }

  async function addFiles(fileList, role = "output") {
    const big = [];
    let added = 0;
    const newlyAdded = [];
    for (const file of Array.from(fileList || [])) {
      if (!validate(file)) continue; // rejects wrong type / over the hard limit
      if (file.size > WARN_MEDIA_BYTES) {
        big.push(file);
        continue;
      }
      const entry = { file, role };
      media.push(entry);
      newlyAdded.push(entry);
      added++;
    }
    if (added) {
      renderUI();
      onChange?.(newlyAdded.some(isProbeCandidate) ? { longDelay: true } : undefined);
      newlyAdded.forEach(probeIfVideo);
    }

    if (big.length) {
      const message =
        big.length === 1
          ? `"${big[0].name}" is ${formatSize(big[0].size)}.\nFiles over 50 MB can bloat your vault and slow loading.\nAdd it anyway?`
          : `These files are over 50 MB:\n${big.map((f) => `• ${f.name} — ${formatSize(f.size)}`).join("\n")}\nLarge media can bloat your vault and slow loading.\nAdd them anyway?`;
      const ok = await confirmDialog({
        title: big.length === 1 ? "Large file" : "Large files",
        message,
        confirmText: "Add anyway",
        cancelText: "Skip",
      });
      if (ok) {
        const bigEntries = big.map((f) => ({ file: f, role }));
        media.push(...bigEntries);
        renderUI();
        onChange?.(bigEntries.some(isProbeCandidate) ? { longDelay: true } : undefined);
        bigEntries.forEach(probeIfVideo);
      }
    }
  }

  function removeEntry(entry) {
    const idx = media.indexOf(entry);
    if (idx < 0) return;
    if (entry.url) URL.revokeObjectURL(entry.url);
    media.splice(idx, 1);
    renderUI();
    onChange?.();
  }

  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files, pendingRole);
    fileInput.value = "";
  });

  // ---- list layout (simple dropzone + rows) ----------------------------

  const list = el("div", { className: "wv-media-picker-list" });

  function renderList() {
    clear(list);
    media.forEach((entry) => {
      const row = el("div", { className: "wv-media-picker-row" });
      row.appendChild(el("span", { className: "wv-media-picker-name" }, [entry.file.name]));
      const sizeClass = entry.file.size > WARN_MEDIA_BYTES ? "wv-media-picker-size wv-media-picker-size-big" : "wv-media-picker-size";
      row.appendChild(el("span", { className: sizeClass }, [formatSize(entry.file.size)]));

      const roleSelect = el("select", { className: "wv-input wv-media-picker-role", "aria-label": "Media role" }, [
        el("option", { value: "output", selected: entry.role === "output" }, ["Output"]),
        el("option", { value: "input", selected: entry.role === "input" }, ["Input"]),
      ]);
      roleSelect.addEventListener("change", () => {
        entry.role = roleSelect.value;
        onChange?.();
      });
      row.appendChild(roleSelect);

      row.appendChild(
        el(
          "button",
          { type: "button", className: "wv-icon-btn", title: "Remove", "aria-label": `Remove ${entry.file.name}`, onclick: () => removeEntry(entry) },
          [el("i", { className: "pi pi-trash" })]
        )
      );

      list.appendChild(row);
      if (entry.hevc) list.appendChild(buildCodecWarning(entry));
    });
  }

  function buildListLayout() {
    const zone = el("div", {
      className: "wv-dropzone wv-media-dropzone",
      role: "button",
      tabindex: "0",
      "aria-label": "Choose or drop media files",
      onclick: () => { pendingRole = role; fileInput.click(); },
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pendingRole = role;
          fileInput.click();
        }
      },
    }, [
      el("i", { className: "pi pi-upload wv-dropzone-icon" }),
      el("div", { className: "wv-dropzone-text" }, [label ? `${label} ` : "Drag files here, paste, or ", el("span", { className: "wv-dropzone-browse" }, ["browse"])]),
      el("div", { className: "wv-dropzone-hint" }, ["Images · video · audio"]),
    ]);
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("wv-dropzone-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("wv-dropzone-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("wv-dropzone-over");
      addFiles(e.dataTransfer?.files, role);
    });
    onPasteInto(zone, (files) => addFiles(files, role));

    wrap.appendChild(zone);
    wrap.appendChild(fileInput);
    const pasteBtn = renderPasteButton({
      className: "wv-btn-link wv-mp-paste",
      title: `Paste copied media as ${role === "input" ? "an input" : "an output"} (or press Ctrl+V over the box)`,
      onFiles: (files) => addFiles(files, role),
    });
    if (pasteBtn) wrap.appendChild(el("div", { className: "wv-mp-paste-row" }, [pasteBtn]));
    wrap.appendChild(list);
  }

  // ---- preview layout (Inputs/Outputs tile grids) ----------------------

  let inputsGrid = null;
  let outputsGrid = null;

  function buildTile(entry) {
    const tile = el("div", { className: "wv-mp-tile" });
    const kind = kindOf(entry.file.name);
    entry.url = entry.url || URL.createObjectURL(entry.file);

    const thumb = el("div", { className: "wv-mp-thumb" });
    if (kind === "image") {
      thumb.appendChild(el("img", { className: "wv-mp-media", src: entry.url, alt: entry.file.name }));
    } else if (kind === "video") {
      const video = videoEl({ className: "wv-mp-media", src: entry.url, muted: true, preload: "metadata", playsinline: true }, { compact: true });
      const dur = el("span", { className: "wv-mp-dur" });
      video.addEventListener("loadedmetadata", () => { dur.textContent = formatDuration(video.duration); });
      thumb.appendChild(video);
      thumb.appendChild(el("span", { className: "wv-mp-play" }, [el("i", { className: "pi pi-play" })]));
      thumb.appendChild(dur);
    } else {
      thumb.classList.add("wv-mp-thumb-audio");
      thumb.appendChild(el("i", { className: "pi pi-volume-up wv-mp-audio-icon" }));
    }

    thumb.appendChild(
      el("button", {
        type: "button",
        className: "wv-mp-remove",
        title: "Remove",
        "aria-label": `Remove ${entry.file.name}`,
        onclick: () => removeEntry(entry),
      }, [el("i", { className: "pi pi-times" })])
    );
    tile.appendChild(thumb);

    const meta = el("div", { className: "wv-mp-meta" });
    meta.appendChild(el("div", { className: "wv-mp-name", title: entry.file.name }, [entry.file.name]));

    const foot = el("div", { className: "wv-mp-foot" });
    const sizeClass = entry.file.size > WARN_MEDIA_BYTES ? "wv-mp-size wv-mp-size-big" : "wv-mp-size";
    foot.appendChild(el("span", { className: sizeClass }, [formatSize(entry.file.size)]));

    const toggle = el("div", { className: "wv-mp-toggle", role: "group", "aria-label": "Media role" });
    const mkBtn = (role, label) => {
      const btn = el("button", {
        type: "button",
        className: `wv-mp-toggle-btn${entry.role === role ? " wv-mp-toggle-btn-active" : ""}`,
        "aria-pressed": entry.role === role ? "true" : "false",
        onclick: () => {
          if (entry.role === role) return;
          entry.role = role;
          renderUI();
          onChange?.();
        },
      }, [label]);
      return btn;
    };
    toggle.appendChild(mkBtn("input", "In"));
    toggle.appendChild(mkBtn("output", "Out"));
    foot.appendChild(toggle);
    meta.appendChild(foot);
    if (entry.hevc) meta.appendChild(buildCodecWarning(entry));
    tile.appendChild(meta);

    return tile;
  }

  // Small non-blocking notice for a video the client-side probe flagged as
  // H.265/HEVC. Doesn't stop the add — just offers to also save a browser-safe
  // copy once the file actually lands in the vault (conversion needs the file
  // on disk, so it can't happen until then).
  function buildCodecWarning(entry) {
    const warn = el("div", { className: "wv-mp-codec-warn" }, [
      el("i", {
        className: "pi pi-exclamation-triangle",
        title: "H.265/HEVC: Firefox on Windows plays this only via a hardware decoder, with no software fallback.",
      }),
      el("span", {}, ["H.265"]),
    ]);
    warn.appendChild(
      el(
        "button",
        {
          type: "button",
          className: `wv-mp-convert-toggle${entry.convertToH264 ? " wv-mp-convert-toggle-active" : ""}`,
          "aria-pressed": entry.convertToH264 ? "true" : "false",
          title: "Also save a browser-safe H.264 copy alongside the original once this is added",
          onclick: () => {
            entry.convertToH264 = !entry.convertToH264;
            renderUI();
            onChange?.();
          },
        },
        [el("i", { className: "pi pi-check" }), "Convert to H.264"]
      )
    );
    return warn;
  }

  function buildAddTile(role) {
    const tile = el("div", {
      className: "wv-mp-add",
      role: "button",
      tabindex: "0",
      "aria-label": `Add ${role === "input" ? "input" : "output"} media`,
      onclick: () => { pendingRole = role; fileInput.click(); },
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pendingRole = role; fileInput.click(); }
      },
    }, [
      el("i", { className: "pi pi-plus wv-mp-add-icon" }),
      el("span", { className: "wv-mp-add-text" }, ["Add media"]),
    ]);
    tile.addEventListener("dragover", (e) => { e.preventDefault(); tile.classList.add("wv-dropzone-over"); });
    tile.addEventListener("dragleave", () => tile.classList.remove("wv-dropzone-over"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      tile.classList.remove("wv-dropzone-over");
      addFiles(e.dataTransfer?.files, role);
    });
    return tile;
  }

  function renderSection(grid, role) {
    clear(grid);
    media.filter((m) => m.role === role).forEach((entry) => grid.appendChild(buildTile(entry)));
    grid.appendChild(buildAddTile(role));
  }

  function renderSections() {
    renderSection(inputsGrid, "input");
    renderSection(outputsGrid, "output");
  }

  // Pull input + output media straight off the live ComfyUI canvas so the user
  // doesn't re-pick files they just ran. Detected inputs land under Inputs,
  // outputs under Outputs — then flow through the same add path as a manual pick.
  async function importFromCanvas(btn) {
    const items = detectCanvasMedia();
    if (!items.length) {
      showToast("No media found on the canvas — load or generate something first.", "info");
      return;
    }
    const label = btn?.querySelector(".wv-mp-import-label");
    const prevLabel = label?.textContent;
    if (btn) btn.disabled = true;
    if (label) label.textContent = "Importing…";
    try {
      const results = await Promise.allSettled(items.map((it) => fetchCanvasFile(it)));
      const inputs = [];
      const outputs = [];
      let failed = 0;
      results.forEach((res, i) => {
        if (res.status === "fulfilled") (items[i].role === "input" ? inputs : outputs).push(res.value);
        else failed++;
      });
      if (inputs.length) await addFiles(inputs, "input");
      if (outputs.length) await addFiles(outputs, "output");
      if (failed) showToast(`Couldn't import ${failed} canvas file${failed === 1 ? "" : "s"}.`, "warn");
    } catch (e) {
      showToast(`Import from workflow failed: ${e.message}`, "error");
    } finally {
      if (btn) btn.disabled = false;
      if (label && prevLabel != null) label.textContent = prevLabel;
    }
  }

  function buildImportButton() {
    const btn = el(
      "button",
      { type: "button", className: "wv-btn-link wv-mp-import", title: "Import media from the current ComfyUI canvas" },
      [el("i", { className: "pi pi-sitemap" }), el("span", { className: "wv-mp-import-label" }, ["Import from workflow"])]
    );
    btn.addEventListener("click", () => importFromCanvas(btn));
    return btn;
  }

  // Inputs and Outputs are separate paste targets: a paste lands in whichever
  // section holds focus or the cursor, so it needs no role fix-up afterwards.
  function buildSection(role, title, icon, grid) {
    const head = el("div", { className: "wv-mp-section-head" }, [el("i", { className: icon }), el("span", {}, [title])]);
    const pasteBtn = renderPasteButton({
      className: "wv-btn-link wv-mp-section-paste",
      title: `Paste copied media into ${title} (or press Ctrl+V over this section)`,
      onFiles: (files) => addFiles(files, role),
    });
    if (pasteBtn) head.appendChild(pasteBtn);
    const section = el("div", { className: "wv-mp-section" }, [head, grid]);
    onPasteInto(section, (files) => addFiles(files, role));
    return section;
  }

  function buildPreviewLayout() {
    inputsGrid = el("div", { className: "wv-mp-grid" });
    outputsGrid = el("div", { className: "wv-mp-grid" });

    const inputsSection = buildSection("input", "Inputs", "pi pi-arrow-down-left", inputsGrid);
    const outputsSection = buildSection("output", "Outputs", "pi pi-arrow-up-right", outputsGrid);

    wrap.classList.add("wv-media-picker-preview");
    wrap.appendChild(fileInput);
    if (canvasAvailable()) {
      wrap.appendChild(el("div", { className: "wv-mp-toolbar" }, [buildImportButton()]));
    }
    wrap.appendChild(inputsSection);
    wrap.appendChild(outputsSection);
    renderSections();
  }

  // ---- wire up ---------------------------------------------------------

  const renderUI = preview ? renderSections : renderList;

  if (preview) buildPreviewLayout();
  else buildListLayout();

  return {
    element: wrap,
    isEmpty: () => media.length === 0,
    getByRole: (role) => media.filter((m) => m.role === role).map((m) => m.file),
    // Parallel to getByRole(role) — same filter/order — so callers can zip
    // files[i] with flags[i] to know which uploaded files should be converted
    // to H.264 once they're actually saved.
    getConvertFlags: (role) => media.filter((m) => m.role === role).map((m) => !!m.convertToH264),
    // Belt-and-suspenders alongside the { longDelay } onChange signal: a
    // caller committing on a timer should await this immediately before
    // building the upload, so a slow probe can never lose a race against the
    // debounce and upload a file whose codec (and convert choice) was never
    // actually resolved.
    awaitPendingProbes: () => Promise.all(media.map((m) => m.probeDone).filter(Boolean)),
  };
}

// After a save that included files flagged via the picker's "Convert to
// H.264" toggle, call the same /convert-media endpoint the reactive
// playback-failure button uses. `files`/`flags` come from a matching
// getByRole(role)/getConvertFlags(role) pair; `mediaItems` is the set of
// newly-created media entries (with .file and .original_filename) to search
// for a match — callers are responsible for scoping that set to only the
// items that were actually just created, so a same-named pre-existing file
// elsewhere in the entry is never mistaken for the one just flagged.
export async function convertFlaggedMedia(entryId, mediaItems, files, flags) {
  const used = new Set();
  const targets = [];
  files.forEach((file, i) => {
    if (!flags[i]) return;
    const match = mediaItems.find((m) => !used.has(m) && m.original_filename === file.name);
    if (match) {
      used.add(match);
      targets.push(match);
    }
  });
  for (const item of targets) {
    try {
      const result = await VaultAPI.convertMedia(entryId, item.file);
      showToast(`Converted ${result.codec} to H.264 (${formatSize(result.bytes_before)} → ${formatSize(result.bytes_after)}). The original was kept.`, "success");
    } catch (e) {
      showToast(`Couldn't convert "${item.original_filename}": ${e.message}`, "error");
    }
  }
  return targets.length > 0;
}
