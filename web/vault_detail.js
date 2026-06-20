// Entry detail view: header, tab router, plus the Overview and Settings
// tabs (the others live in their own modules to keep files manageable).

import { el, clear, formatDate, showToast, confirmDialog, promptDialog, openImageLightbox, toggleField } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { STATUS_LABELS, STATUS_ORDER, renderGenTypePicker, GENERATION_TYPE_MAP } from "./vault_modal.js";
import { renderFolderSelect } from "./vault_folders.js";
import { openWorkflowInGraph } from "./vault_workflow.js";
import { renderVersionsTab } from "./vault_versions_tab.js";
import { renderExamplesTab } from "./vault_examples_tab.js";
import { renderDocsTab } from "./vault_docs_tab.js";
import { renderTagInput, tagCountsFrom } from "./vault_tag_input.js";
import { renderThumbnailField } from "./vault_thumbnail_input.js";
import { buildCompareSlider } from "./vault_compare_slider.js";
import { renderMarkdown } from "./vault_markdown.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "notes", label: "Notes" },
  { id: "settings", label: "Settings" },
];

export function renderDetailView(controller) {
  const entry = controller.getEntry(controller.selectedEntryId);
  const wrap = el("div", { className: "wv-detail" });

  const header = el("div", { className: "wv-detail-header" });
  header.appendChild(
    el("button", { className: "wv-icon-btn wv-icon-btn-lg", title: "Back to vault", onclick: () => controller.backToGrid() }, [el("i", { className: "pi pi-arrow-left" })])
  );

  const titleArea = el("div", { className: "wv-detail-title-area" });
  titleArea.appendChild(el("div", { className: "wv-detail-title" }, [entry.name]));
  titleArea.appendChild(el("span", { className: `wv-status-badge wv-status-${entry.status}` }, [STATUS_LABELS[entry.status] || entry.status]));
  if (entry.favorite) titleArea.appendChild(el("span", { className: "wv-fav-active wv-detail-fav", title: "Favorite" }, [el("i", { className: "pi pi-star-fill" })]));
  header.appendChild(titleArea);

  header.appendChild(el("div", { className: "wv-topbar-spacer" }));
  header.appendChild(
    el("button", { className: "wv-btn wv-btn-primary", onclick: () => openCurrentVersion(controller, entry) }, [
      el("i", { className: "pi pi-play" }),
      "Open Workflow",
    ])
  );
  header.appendChild(el("button", { className: "wv-icon-btn wv-icon-btn-lg", title: "Close", onclick: () => controller.requestClose() }, [el("i", { className: "pi pi-times" })]));
  wrap.appendChild(header);

  const tabBar = el("div", { className: "wv-tab-bar" });
  for (const tab of TABS) {
    tabBar.appendChild(
      el(
        "button",
        {
          className: `wv-tab${controller.selectedTab === tab.id ? " wv-tab-active" : ""}`,
          onclick: () => controller.setTab(tab.id),
        },
        [tab.label]
      )
    );
  }
  wrap.appendChild(tabBar);

  const content = el("div", { className: "wv-tab-content" });
  switch (controller.selectedTab) {
    case "notes":
      content.appendChild(renderDocsTab(controller, entry));
      break;
    case "settings":
      content.appendChild(renderSettingsTab(controller, entry));
      break;
    default:
      content.appendChild(renderOverviewTab(controller, entry));
      break;
  }
  wrap.appendChild(content);

  return wrap;
}

export async function openCurrentVersion(controller, entry) {
  if (!entry.current_version_id) {
    showToast("This entry has no versions yet.", "error");
    return false;
  }
  return openVersionById(controller, entry, entry.current_version_id);
}

export async function openVersionById(controller, entry, versionId) {
  try {
    const workflow = await VaultAPI.getVersionWorkflow(entry.id, versionId);
    await openWorkflowInGraph(workflow, entry.name, { entry_id: entry.id, version_id: versionId });
    showToast(`Opened "${entry.name}".`, "success");
    return true;
  } catch (e) {
    showToast(e.message, "error");
    return false;
  }
}

function formRow(label, input) {
  return el("div", { className: "wv-form-row" }, [el("label", {}, [label]), input]);
}

function dateOnly(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? formatDate(iso) : d.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Overview tab: read-only summary + example media carousel/gallery
// ---------------------------------------------------------------------------

function renderOverviewTab(controller, entry) {
  const wrap = el("div", { className: "wv-overview" });
  wrap.appendChild(renderOverviewSummary(controller, entry));
  wrap.appendChild(renderExampleGallerySection(entry));
  return wrap;
}

function renderOverviewSummary(controller, entry) {
  const wrap = el("div", { className: "wv-overview-summary" });

  // Thumbnail leads as the visual anchor.
  const thumb = el("div", { className: "wv-overview-thumb" });
  if (entry.thumbnail) {
    if (entry.compare_image) {
      // Same interactive before/after wipe as the grid card.
      thumb.classList.add("wv-overview-thumb-compare");
      thumb.appendChild(buildCompareSlider(entry));
    } else {
      thumb.appendChild(el("img", { src: VaultAPI.mediaUrl(entry.id, entry.thumbnail, entry.updated_at), alt: entry.name, loading: "lazy", decoding: "async" }));
    }
    // Reveal the thumbnail (and its archived original) in the OS file manager,
    // matching the per-media button in the examples gallery.
    thumb.appendChild(
      el(
        "button",
        {
          type: "button",
          className: "wv-ex-copy-btn",
          title: "Reveal thumbnail in folder",
          "aria-label": "Reveal thumbnail in folder",
          onclick: async (e) => {
            e.stopPropagation();
            try {
              await VaultAPI.revealMedia(entry.id, entry.thumbnail);
            } catch (err) {
              showToast(err.message, "error");
            }
          },
        },
        [el("i", { className: "pi pi-folder-open" })]
      )
    );
  } else {
    thumb.appendChild(el("div", { className: "wv-overview-thumb-empty" }, [el("i", { className: "pi pi-image" })]));
  }
  wrap.appendChild(thumb);

  const info = el("div", { className: "wv-overview-info" });

  info.appendChild(
    el("p", { className: `wv-overview-description${entry.description ? "" : " wv-muted"}` }, [entry.description || "No description yet."])
  );

  // Metadata tiles fill the panel with useful, scannable info.
  const versionCount = (entry.versions || []).length;
  const exampleCount = (entry.examples || []).length;
  const genTypes = (entry.generation_types || []).map((id) => GENERATION_TYPE_MAP[id]).filter(Boolean);
  const genTypeValue = genTypes.length
    ? el(
        "span",
        { className: "wv-meta-tile-gentypes", title: genTypes.map((t) => t.label).join(", ") },
        genTypes.map((t) => el("span", { className: "wv-meta-tile-gentype" }, [el("i", { className: t.icon }), t.label]))
      )
    : el("span", { className: "wv-muted" }, ["None"]);

  const updatedLabel = dateOnly(entry.updated_at);

  const tile = (label, valueNode) =>
    el("div", { className: "wv-meta-tile" }, [
      el("div", { className: "wv-meta-tile-label" }, [label]),
      el("div", { className: "wv-meta-tile-value" }, [valueNode]),
    ]);

  info.appendChild(
    el("div", { className: "wv-meta-tiles" }, [
      tile("Versions", String(versionCount)),
      tile("Examples", String(exampleCount)),
      tile("Generation type", genTypeValue),
      tile("Updated", updatedLabel),
    ])
  );

  if (entry.tags && entry.tags.length) {
    info.appendChild(
      el("div", { className: "wv-overview-tags-block" }, [
        el("div", { className: "wv-overview-section-label" }, ["Tags"]),
        el("div", { className: "wv-overview-tags" }, entry.tags.map((t) => el("span", { className: "wv-tag" }, [t]))),
      ])
    );
  }

  info.appendChild(
    el("div", { className: "wv-overview-actions" }, [
      el(
        "button",
        {
          className: "wv-btn",
          onclick: async () => {
            try {
              await VaultAPI.openEntryFolder(entry.id);
              showToast("Opening folder…", "success");
            } catch (e) {
              showToast(e.message, "error");
            }
          },
        },
        [el("i", { className: "pi pi-folder-open" }), "Open folder"]
      ),
      el(
        "a",
        { className: "wv-btn", href: VaultAPI.exportUrl(entry.id), download: "", title: "Download this entry as a .zip" },
        [el("i", { className: "pi pi-download" }), "Export (.zip)"]
      ),
    ])
  );

  wrap.appendChild(info);
  return wrap;
}

function renderEntryMetadataForm(controller, entry) {
  const wrap = el("div", { className: "wv-metadata-form" });

  const nameInput = el("input", { className: "wv-input", type: "text", value: entry.name });
  const descInput = el("textarea", { className: "wv-input wv-textarea" });
  descInput.value = entry.description || "";

  const tagInput = renderTagInput({
    tags: entry.tags || [],
    allTags: controller.state.tags || [],
    tagCounts: tagCountsFrom(controller.state.entries),
  });

  const statusSelect = el(
    "select",
    { className: "wv-input" },
    STATUS_ORDER.filter((s) => s !== "archived").map((s) => el("option", { value: s, selected: entry.status === s }, [STATUS_LABELS[s]]))
  );
  if (entry.status === "archived") {
    statusSelect.appendChild(el("option", { value: "archived", selected: true }, [STATUS_LABELS.archived]));
  }

  const genTypePicker = renderGenTypePicker(entry.generation_types || [], () => controller.setDirty(true));

  const favSwitch = toggleField("Favorite", !!entry.favorite, () => controller.setDirty(true));

  controller.state.folders = controller.state.folders || [];
  const folderSelect = renderFolderSelect({ folders: controller.state.folders, selectedId: entry.folder_id || "" });

  const thumbField = renderThumbnailField({
    currentUrl: entry.thumbnail ? VaultAPI.mediaUrl(entry.id, entry.thumbnail, entry.updated_at) : null,
  });
  const compareField = renderThumbnailField({
    currentUrl: entry.compare_image ? VaultAPI.mediaUrl(entry.id, entry.compare_image, entry.updated_at) : null,
    clearable: true,
    noun: "compare image",
  });

  const markDirty = () => controller.setDirty(true);
  for (const input of [nameInput, descInput, statusSelect, folderSelect, thumbField.fileInput, compareField.fileInput]) {
    input.addEventListener("input", markDirty);
    input.addEventListener("change", markDirty);
  }
  tagInput.addEventListener("change", markDirty);

  const grid = el("div", { className: "wv-settings-info-grid" });

  const leftCol = el("div", { className: "wv-settings-form-col" });
  leftCol.appendChild(formRow("Name", nameInput));
  leftCol.appendChild(formRow("Description", descInput));
  leftCol.appendChild(formRow("Status", statusSelect));
  leftCol.appendChild(formRow("Generation types", genTypePicker));
  leftCol.appendChild(formRow("Folder", folderSelect));
  leftCol.appendChild(formRow("Tags", tagInput));
  leftCol.appendChild(el("div", { className: "wv-form-row" }, [favSwitch]));

  const rightCol = el("div", { className: "wv-settings-side-col" });
  rightCol.appendChild(formRow("Thumbnail", thumbField));
  rightCol.appendChild(formRow("Compare image", compareField));
  rightCol.appendChild(renderStatsTiles(entry));

  grid.appendChild(leftCol);
  grid.appendChild(rightCol);
  wrap.appendChild(grid);

  const actions = el("div", { className: "wv-settings-actions" });
  const saveBtn = el(
    "button",
    {
      className: "wv-btn wv-btn-primary",
      onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) {
          showToast("Name is required.", "error");
          return;
        }
        saveBtn.disabled = true;
        try {
          const formData = new FormData();
          const data = {
            name,
            description: descInput.value,
            tags: tagInput.getTags(),
            status: statusSelect.value,
            generation_types: genTypePicker.getSelected(),
            favorite: favSwitch.input.checked,
            folder_id: folderSelect.value === "__new__" ? null : folderSelect.value || null,
          };
          // Display thumbnail + untouched original (archival), both stamped
          // with the source date. For a video the picker yields an animated
          // WebP (converted server-side) or a still frame; for an image, a
          // downscaled cover. See renderThumbnailField().getUpload().
          const up = await thumbField.getUpload();
          if (up?.file) {
            formData.append("thumbnail", up.file);
            if (up.source) formData.append("thumbnail_source", up.source);
            data.file_mtimes = { thumbnail: up.mtime, thumbnail_source: up.mtime };
          }
          // Optional before/after compare overlay (same image/video picker): a
          // new asset, or an explicit removal (clear) of an existing one.
          const cmp = await compareField.getUpload();
          if (cmp?.file) {
            formData.append("compare_image", cmp.file);
            if (cmp.source) formData.append("compare_image_source", cmp.source);
            data.file_mtimes = { ...(data.file_mtimes || {}), compare_image: cmp.mtime, compare_image_source: cmp.mtime };
          } else if (cmp?.clear) {
            data.compare_image_clear = true;
          }
          formData.append("data", JSON.stringify(data));
          await VaultAPI.updateEntryMetadata(entry.id, formData);
          controller.setDirty(false);
          await controller.refresh();
          showToast("Entry updated.", "success");
        } catch (e) {
          showToast(e.message, "error");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    ["Save Changes"]
  );
  actions.appendChild(saveBtn);

  actions.appendChild(
    el(
      "button",
      {
        className: "wv-btn",
        onclick: () => {
          controller.setDirty(false);
          controller.render();
        },
      },
      ["Discard Changes"]
    )
  );

  const archiveBtn =
    entry.status === "archived"
      ? el(
          "button",
          {
            className: "wv-btn",
            onclick: async () => {
              try {
                await VaultAPI.archiveEntry(entry.id, { archived: false });
                await controller.refresh();
                showToast("Entry restored.", "success");
              } catch (e) {
                showToast(e.message, "error");
              }
            },
          },
          [el("i", { className: "pi pi-undo" }), "Restore from Archive"]
        )
      : el(
          "button",
          {
            className: "wv-btn wv-btn-danger",
            onclick: async () => {
              const ok = await confirmDialog({
                title: "Archive this entry?",
                message: `"${entry.name}" will be marked as archived and hidden from the main view by default. You can restore it later from Overview or by enabling "Show archived".`,
                confirmText: "Archive",
                danger: true,
              });
              if (!ok) return;
              try {
                await VaultAPI.archiveEntry(entry.id, { archived: true });
                await controller.refresh();
                showToast("Entry archived.", "success");
              } catch (e) {
                showToast(e.message, "error");
              }
            },
          },
          [el("i", { className: "pi pi-inbox" }), "Archive Entry"]
        );

  const deleteBtn = el(
    "button",
    {
      className: "wv-btn wv-btn-danger",
      onclick: async () => {
        const trash = controller.state?.trash_label || "Trash";
        const ok = await confirmDialog({
          title: "Delete this entry?",
          message: `"${entry.name}" and all its versions, examples, notes, and media will be removed from your vault and moved to the ${trash}. This can't be undone from inside the vault — you'd restore it from the ${trash}.`,
          confirmText: "Delete",
          danger: true,
        });
        if (!ok) return;
        try {
          const res = await VaultAPI.deleteEntry(entry.id);
          controller.setDirty(false);
          controller.selectedEntryId = null;
          controller.view = "grid";
          await controller.refresh();
          showToast(
            res.method === "permanent" ? "Entry permanently deleted." : `Entry moved to the ${trash}.`,
            "success"
          );
        } catch (e) {
          showToast(e.message, "error");
        }
      },
    },
    [el("i", { className: "pi pi-trash" }), "Delete Entry"]
  );

  const duplicateBtn = el(
    "button",
    {
      className: "wv-btn",
      onclick: async () => {
        const name = await promptDialog({
          title: "Duplicate entry",
          message:
            "Creates a new entry with the same thumbnail, tags, generation types, examples, and notes — plus just the current version. Give it a unique name:",
          defaultValue: `${entry.name} copy`,
          placeholder: "New entry name",
          confirmText: "Duplicate",
        });
        if (name === null) return; // cancelled
        const trimmed = name.trim();
        if (!trimmed) {
          showToast("Name is required.", "error");
          return;
        }
        try {
          const newEntry = await VaultAPI.duplicateEntry(entry.id, trimmed);
          controller.setDirty(false);
          await controller.refresh();
          await controller.openEntry(newEntry.id);
          showToast(`Duplicated as "${newEntry.name}".`, "success");
        } catch (e) {
          showToast(e.message, "error");
        }
      },
    },
    [el("i", { className: "pi pi-clone" }), "Duplicate"]
  );

  actions.appendChild(el("div", { className: "wv-topbar-spacer" }));
  actions.appendChild(duplicateBtn);
  actions.appendChild(archiveBtn);
  actions.appendChild(deleteBtn);

  wrap.appendChild(actions);
  return wrap;
}

function renderStatsTiles(entry) {
  const tiles = el("div", { className: "wv-meta-tiles" });
  const tile = (label, value, wide) => {
    const t = el("div", { className: `wv-meta-tile${wide ? " wv-meta-tile-wide" : ""}` }, [
      el("div", { className: "wv-meta-tile-label" }, [label]),
      el("div", { className: "wv-meta-tile-value" }, [value]),
    ]);
    return t;
  };
  tiles.appendChild(tile("Created", dateOnly(entry.created_at)));
  tiles.appendChild(tile("Updated", dateOnly(entry.updated_at)));
  const currentVersion = (entry.versions || []).find((v) => v.id === entry.current_version_id);
  tiles.appendChild(tile("Current version", currentVersion ? currentVersion.custom_label || currentVersion.label : "—", true));
  return tiles;
}

// ---------------------------------------------------------------------------
// Example gallery: one card per example, media shown with a per-card mini
// filmstrip and a collapsible notes drawer (placement adapts to media type).
// ---------------------------------------------------------------------------

function exampleMediaItems(example) {
  const items = [];
  for (const item of example.inputs || []) items.push({ item, role: "Input" });
  for (const item of example.outputs || []) items.push({ item, role: "Output" });
  return items;
}

function renderExampleGallerySection(entry) {
  const section = el("div", { className: "wv-overview-gallery-section" });
  const examples = (entry.examples || []).filter((ex) => (ex.inputs?.length || ex.outputs?.length));

  const header = el("div", { className: "wv-section-header" }, [el("h3", {}, ["Examples"])]);
  if (examples.length) header.appendChild(el("span", { className: "wv-count-badge" }, [String(examples.length)]));
  section.appendChild(header);

  if (!examples.length) {
    section.appendChild(el("p", { className: "wv-muted" }, ["No example media yet. Add some in the Settings tab."]));
    return section;
  }

  const grid = el("div", { className: "wv-ex-gallery" });
  for (const example of examples) {
    grid.appendChild(renderExampleGalleryCard(entry, example));
  }
  section.appendChild(grid);
  return section;
}

// Collapsible notes: collapsed shows a one-line teaser, expanded shows the
// full Markdown. The same element is positioned as an overlay (over image
// media) or as a plain block (below video/audio) by the card's render().
function renderExampleNotes(markdownText) {
  const root = el("div", { className: "wv-ex-notes" });

  const chevron = el("i", { className: "pi pi-chevron-up" });
  const teaser = (markdownText.split("\n").find((l) => l.trim()) || "").replace(/[#>*_`~-]/g, "").trim();
  const teaserText = el("span", { className: "wv-ex-notes-teaser" }, [teaser]);
  const bar = el("div", { className: "wv-ex-notes-bar" }, [el("i", { className: "pi pi-comment" }), teaserText, chevron]);

  const body = el("div", { className: "wv-markdown wv-ex-notes-body" });
  body.innerHTML = renderMarkdown(markdownText);
  body.style.display = "none";

  let expanded = false;
  bar.onclick = (e) => {
    e.stopPropagation();
    expanded = !expanded;
    body.style.display = expanded ? "" : "none";
    teaserText.textContent = expanded ? "Notes" : teaser;
    chevron.className = expanded ? "pi pi-chevron-down" : "pi pi-chevron-up";
    root.classList.toggle("wv-ex-notes-open", expanded);
  };

  root.appendChild(bar);
  root.appendChild(body);
  return root;
}

function renderExampleGalleryCard(entry, example) {
  const items = exampleMediaItems(example);
  const card = el("div", { className: "wv-ex-card" });

  // Only show a heading when the user gave the example a real title — the
  // auto "example_NNN" label is noise on the Overview gallery.
  if (example.title && example.title.trim()) {
    card.appendChild(el("div", { className: "wv-ex-card-head", title: example.title }, [example.title]));
  }

  const mediaWrap = el("div", { className: "wv-ex-media" });
  const main = el("div", { className: "wv-ex-main" });
  const roleLabel = el("span", { className: "wv-ex-role" });

  // Per-item action: images copy to the clipboard; video/audio (which the
  // clipboard can't hold) download instead. Icon/behavior set in show().
  let mediaAction = null;
  const actionBtn = el("button", {
    type: "button",
    className: "wv-ex-copy-btn",
    onclick: (e) => {
      e.stopPropagation();
      if (mediaAction) mediaAction();
    },
  });

  // Before/after compare is available when the example has both an image
  // input and an image output.
  const imgInput = (example.inputs || []).find((it) => it.type === "image");
  const imgOutput = (example.outputs || []).find((it) => it.type === "image");
  let comparing = false;
  const compareBtn = (imgInput && imgOutput)
    ? el(
        "button",
        {
          type: "button",
          className: "wv-ex-compare-btn",
          title: "Compare input / output",
          "aria-label": "Compare input and output",
          onclick: (e) => {
            e.stopPropagation();
            setCompare(!comparing);
          },
        },
        [el("i", { className: "pi pi-arrows-h" })]
      )
    : null;

  mediaWrap.appendChild(main);
  mediaWrap.appendChild(roleLabel);
  mediaWrap.appendChild(actionBtn);
  if (compareBtn) mediaWrap.appendChild(compareBtn);
  card.appendChild(mediaWrap);

  // Slot that holds notes when the current media isn't an image.
  const belowSlot = el("div", { className: "wv-ex-below" });
  card.appendChild(belowSlot);

  const hasNotes = !!(example.notes && example.notes.trim());
  const notesEl = hasNotes ? renderExampleNotes(example.notes) : null;

  const filmstrip = el("div", { className: "wv-ex-filmstrip" });
  const filmButtons = [];
  let currentIdx = 0;

  function show(idx) {
    comparing = false;
    if (compareBtn) compareBtn.classList.remove("wv-ex-compare-active");
    if (notesEl) notesEl.style.display = "";
    currentIdx = (idx + items.length) % items.length;
    const { item, role } = items[currentIdx];
    clear(main);
    main.appendChild(renderCarouselMedia(entry, item));
    roleLabel.style.display = "";
    roleLabel.textContent = role;
    // The file already lives on disk in the vault — reveal it in the OS file
    // manager rather than copying/downloading a duplicate.
    actionBtn.style.display = "";
    actionBtn.title = "Reveal file in folder";
    actionBtn.setAttribute("aria-label", "Reveal file in folder");
    actionBtn.replaceChildren(el("i", { className: "pi pi-folder-open" }));
    mediaAction = async () => {
      try {
        await VaultAPI.revealMedia(entry.id, item.file);
      } catch (err) {
        showToast(err.message, "error");
      }
    };
    if (notesEl) {
      // Always render the note as the below-media bar (matching the compare
      // view), never as an on-image overlay.
      notesEl.style.display = "";
      notesEl.classList.remove("wv-ex-notes-overlay");
      belowSlot.appendChild(notesEl);
    }
    filmButtons.forEach((btn, i) => btn.classList.toggle("wv-gallery-item-active", i === currentIdx));
  }

  function setCompare(on) {
    if (!on) {
      show(currentIdx);
      return;
    }
    comparing = true;
    clear(main);
    main.appendChild(renderCompareSlider(entry, imgInput, imgOutput));
    // The compare slider has its own Input/Output labels, so the carousel's
    // role pill would just overlap them — hide it while comparing.
    roleLabel.style.display = "none";
    actionBtn.style.display = "none";
    // Keep the per-example note visible while comparing, but render it BELOW the
    // slider (not overlaid) so it never covers the wipe area or the slider's own
    // Input/Output labels — same placement non-image media already uses.
    if (notesEl) {
      notesEl.style.display = "";
      notesEl.classList.remove("wv-ex-notes-overlay");
      belowSlot.appendChild(notesEl);
    }
    if (compareBtn) compareBtn.classList.add("wv-ex-compare-active");
    filmButtons.forEach((btn) => btn.classList.remove("wv-gallery-item-active"));
  }

  if (items.length > 1) {
    items.forEach((it, idx) => {
      const btn = el(
        "button",
        { type: "button", className: "wv-gallery-item", title: it.item.label, onclick: () => show(idx) },
        [renderGalleryThumb(entry, it.item)]
      );
      filmButtons.push(btn);
      filmstrip.appendChild(btn);
    });
    card.appendChild(filmstrip);
  }

  // Default to the before/after compare view when the example has a comparable
  // image pair; the toggle button or any filmstrip thumbnail switches to single
  // items. Otherwise just show the first media item.
  if (imgInput && imgOutput) setCompare(true);
  else show(0);
  return card;
}

// Before/after comparison: two images stacked, the top (input) revealed up to a
// hover-following divider via clip-path so both stay pixel-aligned. Matches the
// thumbnail compare slider — move the cursor to wipe, no click needed.
function renderCompareSlider(entry, inputItem, outputItem) {
  const wrap = el("div", { className: "wv-compare" });
  const base = el("img", { className: "wv-compare-img", src: VaultAPI.mediaUrl(entry.id, outputItem.file), alt: "Output", draggable: "false" });
  const overlay = el("div", { className: "wv-compare-overlay" }, [
    el("img", { className: "wv-compare-img", src: VaultAPI.mediaUrl(entry.id, inputItem.file), alt: "Input", draggable: "false" }),
  ]);
  const handle = el(
    "div",
    { className: "wv-compare-handle", tabindex: "0", role: "slider", "aria-label": "Comparison position", "aria-valuemin": "0", "aria-valuemax": "100" },
    // Wrap the icon in an absolutely-positioned grip (same as the thumbnail
    // slider) so it isn't flex-shrunk by the thin handle bar into a flat oval.
    [el("div", { className: "wv-compare-grip" }, [el("i", { className: "pi pi-arrows-h" })])]
  );

  wrap.appendChild(base);
  wrap.appendChild(overlay);
  wrap.appendChild(el("span", { className: "wv-compare-label wv-compare-label-l" }, ["Input"]));
  wrap.appendChild(el("span", { className: "wv-compare-label wv-compare-label-r" }, ["Output"]));
  wrap.appendChild(handle);

  let pos = 50;
  function setPos(p) {
    pos = Math.max(0, Math.min(100, p));
    overlay.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
    handle.style.left = `${pos}%`;
    handle.setAttribute("aria-valuenow", String(Math.round(pos)));
  }
  function fromX(clientX) {
    const rect = wrap.getBoundingClientRect();
    if (rect.width) setPos(((clientX - rect.left) / rect.width) * 100);
  }

  // Follow the cursor on hover (no click/drag needed); snap back to centre when
  // the pointer leaves, matching the thumbnail compare slider.
  const move = (e) => fromX((e.touches ? e.touches[0] : e).clientX);
  const onTouch = (e) => {
    e.preventDefault();
    if (e.touches[0]) fromX(e.touches[0].clientX);
  };
  wrap.addEventListener("mousemove", move);
  wrap.addEventListener("mouseleave", () => setPos(50));
  wrap.addEventListener("touchmove", onTouch, { passive: false });
  handle.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPos(pos - 5);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setPos(pos + 5);
    }
  });

  setPos(50);
  return wrap;
}

function renderCarouselMedia(entry, item) {
  const url = VaultAPI.mediaUrl(entry.id, item.file);
  if (item.type === "image") {
    return el("img", { src: url, alt: item.label, className: "wv-carousel-image", onclick: () => openImageLightbox(url, item.label) });
  }
  if (item.type === "video") return el("video", { src: url, controls: true });
  if (item.type === "audio") return el("audio", { src: url, controls: true });
  return el("div", { className: "wv-gallery-item-icon" }, [el("i", { className: "pi pi-file" })]);
}

function renderGalleryThumb(entry, item) {
  const url = VaultAPI.mediaUrl(entry.id, item.file);
  if (item.type === "image") return el("img", { src: url, alt: item.label });
  if (item.type === "video") return el("video", { src: url, muted: true, preload: "metadata" });
  if (item.type === "audio") return el("div", { className: "wv-gallery-item-icon" }, [el("i", { className: "pi pi-volume-up" })]);
  return el("div", { className: "wv-gallery-item-icon" }, [el("i", { className: "pi pi-file" })]);
}

// ---------------------------------------------------------------------------
// Settings tab: editable workflow details, versions, and examples, shown one
// section at a time via a segmented control.
// ---------------------------------------------------------------------------

const SETTINGS_SECTIONS = [
  { id: "info", label: "Workflow Details" },
  { id: "versions", label: "Versions" },
  { id: "examples", label: "Examples" },
];

function renderSettingsTab(controller, entry) {
  const wrap = el("div", { className: "wv-settings-tab" });
  controller.settingsSection = controller.settingsSection || "info";

  const counts = { versions: (entry.versions || []).length, examples: (entry.examples || []).length };

  const seg = el("div", { className: "wv-segmented" });
  for (const section of SETTINGS_SECTIONS) {
    const btn = el(
      "button",
      {
        className: `wv-segmented-btn${controller.settingsSection === section.id ? " wv-segmented-btn-active" : ""}`,
        onclick: async () => {
          if (controller.settingsSection === section.id) return;
          const proceed = await controller.checkDirty();
          if (!proceed) return;
          controller.settingsSection = section.id;
          controller.render();
        },
      },
      [section.label]
    );
    if (counts[section.id] != null) btn.appendChild(el("span", { className: "wv-count-badge" }, [String(counts[section.id])]));
    seg.appendChild(btn);
  }
  wrap.appendChild(seg);

  const content = el("div", { className: "wv-settings-section" });
  switch (controller.settingsSection) {
    case "versions":
      content.appendChild(renderVersionsTab(controller, entry));
      break;
    case "examples":
      content.appendChild(renderExamplesTab(controller, entry));
      break;
    default:
      content.appendChild(renderEntryMetadataForm(controller, entry));
      break;
  }
  wrap.appendChild(content);

  return wrap;
}
