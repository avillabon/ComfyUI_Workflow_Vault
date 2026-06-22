// Grid view (topbar, sidebar, workflow cards), the empty state, and the
// initial "vault not configured yet" screen.

import { el, formatDateOnly, showToast, confirmDialog, onActivate, toggleField } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";
import { openCurrentVersion } from "./vault_detail.js";
import { buildCompareSlider } from "./vault_compare_slider.js";
import { tagCountsFrom } from "./vault_tag_input.js";

// App version (SemVer). Keep in sync with pyproject.toml; shown in the footer.
export const VAULT_VERSION = "1.0.1";
export const AUTHOR_NAME = "Alex Villabón";
export const AUTHOR_URL = "https://www.youtube.com/@alexvillabon";
export const REPO_URL = "https://github.com/avillabon/ComfyUI_Workflow_Vault";

export const STATUS_LABELS = {
  draft: "Draft",
  experimental: "Experimental",
  stable: "Stable",
  production: "Production",
  archived: "Archived",
};

export const STATUS_ORDER = ["draft", "experimental", "stable", "production", "archived"];

// Single, curated "what this workflow produces" classification — a higher-tier
// axis than free-form tags, surfaced as a sidebar filter and a card badge.
export const GENERATION_TYPES = [
  { id: "image", label: "Image", icon: "pi pi-image" },
  { id: "video", label: "Video", icon: "pi pi-video" },
  { id: "audio", label: "Audio", icon: "pi pi-volume-up" },
  { id: "3d_model", label: "3D Model", icon: "pi pi-box" },
  { id: "llm", label: "LLM", icon: "pi pi-comment" },
  { id: "api_nodes", label: "API nodes", icon: "pi pi-cloud" },
];
export const GENERATION_TYPE_MAP = Object.fromEntries(GENERATION_TYPES.map((t) => [t.id, t]));

// Multi-select picker for generation types: a row of toggle chips (one per
// fixed type). Returns an element exposing getSelected() -> ordered id list.
export function renderGenTypePicker(selected = [], onChange) {
  const chosen = new Set(selected);
  const wrap = el("div", { className: "wv-gentype-picker" });
  for (const t of GENERATION_TYPES) {
    const chip = el(
      "button",
      {
        type: "button",
        className: `wv-gentype-chip${chosen.has(t.id) ? " wv-gentype-chip-active" : ""}`,
        "aria-pressed": chosen.has(t.id) ? "true" : "false",
        title: t.label,
        onclick: () => {
          if (chosen.has(t.id)) chosen.delete(t.id);
          else chosen.add(t.id);
          const on = chosen.has(t.id);
          chip.classList.toggle("wv-gentype-chip-active", on);
          chip.setAttribute("aria-pressed", on ? "true" : "false");
          if (onChange) onChange();
        },
      },
      [el("i", { className: t.icon }), t.label]
    );
    wrap.appendChild(chip);
  }
  // Preserve the canonical GENERATION_TYPES order regardless of click order.
  wrap.getSelected = () => GENERATION_TYPES.map((t) => t.id).filter((id) => chosen.has(id));
  return wrap;
}

// ---------------------------------------------------------------------------
// Loading / init
// ---------------------------------------------------------------------------

export function renderLoading() {
  return el("div", { className: "wv-loading" }, ["Loading vault…"]);
}

export function renderInitView(controller) {
  const wrap = el("div", { className: "wv-init" });

  wrap.appendChild(el("h2", {}, ["Welcome to the Workflow Vault"]));
  wrap.appendChild(
    el("p", {}, [
      "Choose a folder on disk where your saved workflows, versions, examples, and notes will live. ",
      "This folder will be used every time you open the vault.",
    ])
  );

  const input = el("input", {
    className: "wv-input wv-init-input",
    type: "text",
    placeholder: "e.g. C:\\Users\\you\\Documents\\ComfyUI Workflow Vault",
  });
  const browseBtn = el(
    "button",
    {
      className: "wv-btn",
      title: "Browse for a folder",
      onclick: async () => {
        browseBtn.disabled = true;
        status.textContent = "";
        try {
          const res = await VaultAPI.browseFolder();
          if (res.path) input.value = res.path;
          // res.path === null → the user cancelled the dialog; leave the field.
        } catch {
          // The picker is a server-side native dialog (tkinter), which is
          // absent on common installs — notably the ComfyUI Windows portable
          // build ships no tkinter — and on headless/remote servers. Guide the
          // user to type the path instead of leaving a dead button.
          status.textContent =
            "Folder picker isn't available on this ComfyUI install — type or paste the full folder path above, then click “Use this folder.”";
          input.focus();
        } finally {
          browseBtn.disabled = false;
        }
      },
    },
    [el("i", { className: "pi pi-folder-open" }), " Browse…"]
  );
  wrap.appendChild(el("div", { className: "wv-init-path-row" }, [input, browseBtn]));

  const status = el("div", { className: "wv-init-status" });
  wrap.appendChild(status);

  const actions = el("div", { className: "wv-init-actions" });
  const initBtn = el(
    "button",
    {
      className: "wv-btn wv-btn-primary",
      onclick: () => submit(input.value),
    },
    ["Use this folder"]
  );
  actions.appendChild(initBtn);

  if (controller.state?.extension_dir) {
    const extensionDir = String(controller.state.extension_dir).replace(/[\\/]+$/, "");
    const sep = extensionDir.includes("\\") ? "\\" : "/";
    const samplePath = `${extensionDir}${sep}sample_vault`;
    actions.appendChild(
      el(
        "button",
        {
          className: "wv-btn",
          onclick: () => {
            input.value = samplePath;
          },
        },
        ["Use included sample vault"]
      )
    );
    wrap.appendChild(
      el("p", { className: "wv-init-hint" }, [
        `Tip: a small sample vault with example entries is included at ${samplePath}. `,
        "Click \"Use included sample vault\" to explore it, or choose your own empty folder to start fresh.",
      ])
    );
  }

  wrap.appendChild(actions);

  async function submit(path, confirm = false) {
    const trimmed = (path || "").trim();
    if (!trimmed) {
      status.textContent = "Please enter a folder path.";
      return;
    }
    initBtn.disabled = true;
    status.textContent = "";
    try {
      const result = await VaultAPI.postSettings({ vault_root: trimmed, confirm });
      controller.state = { ...controller.state, ...result, initialized: true };
      await controller.refresh();
      showToast("Vault ready.", "success");
    } catch (e) {
      if (e.status === 409 && e.data?.needs_confirmation) {
        initBtn.disabled = false;
        const ok = await confirmDialog({ title: "Initialize Vault?", message: e.data.message, confirmText: "Continue" });
        if (ok) await submit(trimmed, true);
        return;
      }
      status.textContent = e.message;
    } finally {
      initBtn.disabled = false;
    }
  }

  setTimeout(() => input.focus(), 0);
  return wrap;
}

// ---------------------------------------------------------------------------
// Topbar
// ---------------------------------------------------------------------------

export function renderTopbar(controller) {
  const { filters } = controller;
  const bar = el("div", { className: "wv-topbar" });

  // Brand cell aligns with the sidebar column; controls cell aligns with the
  // main content area (so the search/filters never overlap the sidebar).
  // Logo is a masked element (not <img>) so it tints with --wv-accent like the
  // rail button and the rest of the icons.
  const brand = el("div", { className: "wv-topbar-brand" }, [
    el("span", { className: "wv-topbar-title-logo", role: "img", "aria-label": "Workflow Vault logo" }),
    el("span", { className: "wv-topbar-title-text" }, ["Workflow Vault"]),
  ]);
  const controls = el("div", { className: "wv-topbar-controls" });

  // Always a fixed two-row layout (no reflow on resize):
  //   Row 1: search (left)  ...........  New Entry · settings · close (right)
  //   Row 2: sort · status · favorites · archived (left)  .....  per-row (right)
  const spacer = () => el("div", { className: "wv-topbar-spacer" });

  const search = el("input", {
    className: "wv-input wv-search",
    type: "search",
    placeholder: "Search workflows, tags, descriptions…",
    value: filters.search,
    oninput: (e) => {
      controller.filters.search = e.target.value;
      controller.render();
    },
  });

  const newEntryBtn = el(
    "button",
    {
      className: "wv-btn wv-btn-primary",
      onclick: () => controller.openWizard({ mode: "full" }),
    },
    ["+ New Entry"]
  );
  const settingsBtn = el(
    "button",
    { className: "wv-icon-btn wv-icon-btn-lg", title: "Vault settings", onclick: () => controller.openSettings() },
    [el("i", { className: "pi pi-cog" })]
  );
  const closeBtn = el(
    "button",
    { className: "wv-icon-btn wv-icon-btn-lg", title: "Close", onclick: () => controller.requestClose() },
    [el("i", { className: "pi pi-times" })]
  );

  const currentSort = controller.state.settings?.sort || "updated";
  const SORT_OPTIONS = [
    ["updated", "Recently updated"],
    ["created", "Recently created"],
    ["name", "Name (A–Z)"],
  ];
  const sortSelect = el(
    "select",
    {
      className: "wv-input wv-sort-select",
      title: "Sort workflows",
      "aria-label": "Sort workflows",
      onchange: async (e) => {
        const value = e.target.value;
        controller.state.settings = controller.state.settings || {};
        controller.state.settings.sort = value;
        controller.render();
        try {
          await VaultAPI.postSettings({ sort: value });
        } catch (err) {
          showToast(err.message, "error");
        }
      },
    },
    SORT_OPTIONS.map(([value, label]) => el("option", { value, selected: value === currentSort }, [label]))
  );

  const statusSelect = el(
    "select",
    {
      className: "wv-input wv-status-filter",
      onchange: (e) => {
        controller.filters.status = e.target.value || null;
        controller.render();
      },
    },
    [
      el("option", { value: "", selected: !filters.status }, ["All statuses"]),
      ...STATUS_ORDER.map((value) => el("option", { value, selected: filters.status === value }, [STATUS_LABELS[value]])),
    ]
  );

  const favoritesToggle = toggleField("Favorites", !!filters.favoritesOnly, (checked) => {
    controller.filters.favoritesOnly = checked;
    controller.render();
  });

  const archivedToggle = toggleField("Show archived", !!filters.showArchived, (checked) => {
    controller.filters.showArchived = checked;
    controller.render();
  });

  const row1 = el("div", { className: "wv-topbar-row" }, [search, spacer(), newEntryBtn, settingsBtn, closeBtn]);
  const row2 = el("div", { className: "wv-topbar-row" }, [sortSelect, statusSelect, favoritesToggle, archivedToggle]);
  controls.appendChild(row1);
  controls.appendChild(row2);

  bar.appendChild(brand);
  bar.appendChild(controls);
  return bar;
}

// ---------------------------------------------------------------------------
// Grid body (sidebar + cards)
// ---------------------------------------------------------------------------

export function renderGridBody(controller) {
  const body = el("div", { className: "wv-body" });

  const sidebar = el("div", { className: "wv-sidebar" });
  renderGenerationTypeFilter(sidebar, controller);
  renderTagFilter(sidebar, controller);
  sidebar.appendChild(renderSidebarFooter());
  body.appendChild(sidebar);

  const main = el("div", { className: "wv-main" });
  main.appendChild(renderBreadcrumb(controller));

  const entries = filterEntries(controller);
  if (entries.length === 0) {
    main.appendChild(renderEmptyState(controller));
  } else {
    const gridColumns = controller.state.settings?.grid_columns || 3;
    const grid = el("div", { className: `wv-grid wv-grid-cols-${gridColumns}` });
    for (const entry of entries) {
      grid.appendChild(renderCard(entry, controller));
    }
    main.appendChild(grid);
  }

  body.appendChild(main);
  return body;
}

// Bottom-of-sidebar credit: version, author link, and repo link (new tab).
function renderSidebarFooter() {
  const footerLink = (href, children) =>
    el("a", { className: "wv-sidebar-footer-link", href, target: "_blank", rel: "noopener noreferrer" }, children);
  return el("div", { className: "wv-sidebar-footer" }, [
    el("div", { className: "wv-sidebar-footer-version" }, [`Workflow Vault v${VAULT_VERSION}`]),
    el("div", { className: "wv-sidebar-footer-links" }, [
      footerLink(AUTHOR_URL, [`by ${AUTHOR_NAME} `, el("i", { className: "pi pi-external-link" })]),
      footerLink(REPO_URL, [el("i", { className: "pi pi-github" }), "GitHub"]),
    ]),
  ]);
}

function renderGenerationTypeFilter(container, controller) {
  const { state, filters } = controller;
  const entries = state.entries || [];

  container.appendChild(
    el("div", { className: "wv-sidebar-heading-row" }, [
      el("div", { className: "wv-sidebar-heading" }, ["Generation Type"]),
    ])
  );

  const list = el("div", { className: "wv-folder-tree" });
  const sortedTypes = [...GENERATION_TYPES].sort((a, b) => a.label.localeCompare(b.label));
  for (const t of sortedTypes) {
    const count = entries.filter((e) => (e.generation_types || []).includes(t.id)).length;
    const active = filters.generationType === t.id;
    const toggle = () => {
      controller.filters.generationType = active ? null : t.id;
      controller.render();
    };
    list.appendChild(
      el(
        "div",
        {
          className: `wv-folder-row wv-gentype-row${active ? " wv-folder-row-active" : ""}`,
          role: "button",
          tabindex: "0",
          onclick: toggle,
          onkeydown: onActivate(toggle),
        },
        [
          el("i", { className: `${t.icon} wv-gentype-icon` }),
          el("span", { className: "wv-folder-label" }, [t.label]),
          el("span", { className: "wv-folder-count" }, [String(count)]),
        ]
      )
    );
  }
  container.appendChild(list);
}

// Add or remove a tag from the active tag filter, then re-render. Shared by the
// sidebar facet, the breadcrumb chips, and the clickable card tag pills.
function toggleTagFilter(controller, tag) {
  const tags = controller.filters.tags || [];
  controller.filters.tags = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
  controller.render();
}

// Sidebar tag facet: a multi-select list of every tag in the vault with usage
// counts, mirroring the Generation Type filter. Adds the pieces tags need that
// a single-select gen-type list doesn't: an All/Any match toggle (shown once
// two or more tags are picked) and a local filter box for large vaults.
function renderTagFilter(container, controller) {
  const { state, filters } = controller;
  const counts = tagCountsFrom(state.entries || []);
  const selected = filters.tags || [];
  // Selected tags float to the top (so they stay visible in the scroll area),
  // then most-used first, then alphabetical.
  const tags = Object.keys(counts).sort((a, b) => {
    const sa = selected.includes(a);
    const sb = selected.includes(b);
    if (sa !== sb) return sa ? -1 : 1;
    return counts[b] - counts[a] || a.localeCompare(b);
  });

  controller.ui = controller.ui || {};

  const heading = el("div", { className: "wv-sidebar-heading-row wv-sidebar-section-gap" }, [
    el("div", { className: "wv-sidebar-heading" }, ["Tags"]),
  ]);
  if (selected.length) {
    const clear = () => {
      controller.filters.tags = [];
      controller.render();
    };
    heading.appendChild(
      el(
        "button",
        { className: "wv-tagfilter-clear", type: "button", title: "Clear selected tags", onclick: clear },
        ["Clear"]
      )
    );
  }
  container.appendChild(heading);

  if (!tags.length) {
    container.appendChild(el("div", { className: "wv-tagfilter-empty" }, ["No tags yet."]));
    return;
  }

  const list = el("div", { className: "wv-folder-tree wv-tagfilter-list" });
  const rows = [];
  for (const tag of tags) {
    const active = selected.includes(tag);
    const toggle = () => toggleTagFilter(controller, tag);
    const row = el(
      "div",
      {
        className: `wv-folder-row wv-tagfilter-row${active ? " wv-folder-row-active" : ""}`,
        role: "button",
        tabindex: "0",
        "aria-pressed": active ? "true" : "false",
        onclick: toggle,
        onkeydown: onActivate(toggle),
      },
      [
        el("i", { className: `pi ${active ? "pi-check-square" : "pi-stop"} wv-gentype-icon` }),
        el("span", { className: "wv-folder-label" }, [tag]),
        el("span", { className: "wv-folder-count" }, [String(counts[tag])]),
      ]
    );
    rows.push({ tag, row });
  }

  // Local filter box (no app re-render, so typing keeps focus): just hides rows
  // that don't match. The query persists on controller.ui so it survives the
  // re-render triggered by toggling a tag. Only worth showing for longer lists.
  const applyQuery = () => {
    const q = (controller.ui.tagQuery || "").trim().toLowerCase();
    for (const { tag, row } of rows) {
      row.style.display = !q || tag.includes(q) ? "" : "none";
    }
  };
  if (tags.length > 8) {
    const search = el("input", {
      className: "wv-input wv-tagfilter-search",
      type: "text",
      placeholder: "Filter tags…",
      "aria-label": "Filter tags",
      value: controller.ui.tagQuery || "",
    });
    search.addEventListener("input", () => {
      controller.ui.tagQuery = search.value;
      applyQuery();
    });
    container.appendChild(el("div", { className: "wv-tagfilter-search-wrap" }, [search]));
  }

  for (const { row } of rows) list.appendChild(row);
  container.appendChild(list);
  applyQuery();
}

function renderBreadcrumb(controller) {
  const row = el("div", { className: "wv-breadcrumb" });

  row.appendChild(el("span", { className: "wv-breadcrumb-item wv-breadcrumb-active" }, ["All Workflows"]));

  // Active tag filters show as removable chips after the page title, spaced by
  // the breadcrumb's flex gap. Tags always combine with AND.
  const selectedTags = controller.filters.tags || [];
  selectedTags.forEach((tag, i) => {
    if (i === 0) {
      row.appendChild(el("span", { className: "wv-breadcrumb-sep" }, ["·"]));
    }
    const remove = () => toggleTagFilter(controller, tag);
    row.appendChild(
      el("span", { className: "wv-tagchip" }, [
        el("span", { className: "wv-tagchip-label" }, [tag]),
        el(
          "button",
          {
            className: "wv-tagchip-remove",
            type: "button",
            title: `Remove tag ${tag}`,
            "aria-label": `Remove tag ${tag}`,
            onclick: remove,
          },
          ["×"]
        ),
      ])
    );
  });

  // Per-row (grid density) control lives on the breadcrumb line, pushed to the
  // right edge by a flexible spacer.
  const gridColumns = controller.state.settings?.grid_columns || 3;
  const densitySelect = el(
    "select",
    {
      className: "wv-input wv-grid-density",
      title: "Workflows per row",
      "aria-label": "Workflows per row",
      onchange: async (e) => {
        const value = Number(e.target.value);
        controller.state.settings = controller.state.settings || {};
        controller.state.settings.grid_columns = value;
        controller.render();
        try {
          await VaultAPI.postSettings({ grid_columns: value });
        } catch (err) {
          showToast(err.message, "error");
        }
      },
    },
    [2, 3, 4].map((n) => el("option", { value: n, selected: n === gridColumns }, [`${n} per row`]))
  );
  row.appendChild(el("div", { className: "wv-topbar-spacer" }));
  row.appendChild(densitySelect);

  return row;
}

function filterEntries(controller) {
  const { state, filters } = controller;
  let entries = state.entries || [];

  if (filters.status) {
    entries = entries.filter((e) => e.status === filters.status);
  } else if (!filters.showArchived) {
    entries = entries.filter((e) => e.status !== "archived");
  }

  if (filters.favoritesOnly) {
    entries = entries.filter((e) => e.favorite);
  }

  if (filters.generationType) {
    entries = entries.filter((e) => (e.generation_types || []).includes(filters.generationType));
  }

  const tagFilters = filters.tags || [];
  if (tagFilters.length) {
    // Narrow to entries carrying every selected tag. Tags are stored normalized
    // (lowercased) and the selected tags come straight from entry data, so a
    // plain Set membership check is exact.
    entries = entries.filter((e) => {
      const have = new Set(e.tags || []);
      return tagFilters.every((t) => have.has(t));
    });
  }

  const search = (filters.search || "").trim().toLowerCase();
  if (search) {
    entries = entries.filter((e) => {
      const haystack = [e.name, e.description, ...(e.tags || [])].join(" ").toLowerCase();
      return haystack.includes(search);
    });
  }

  const sort = state.settings?.sort || "updated";
  const sorted = [...entries];
  if (sort === "name") {
    sorted.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } else if (sort === "created") {
    sorted.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  } else {
    // "updated" (default): favorites pinned first, then most-recently updated.
    sorted.sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
  }
  return sorted;
}

function renderCard(entry, controller) {
  const card = el("div", {
    className: "wv-card",
    role: "button",
    tabindex: "0",
    "aria-label": `Open ${entry.name}`,
    onclick: () => controller.openEntry(entry.id),
    onkeydown: onActivate(() => controller.openEntry(entry.id)),
  });

  const thumb = el("div", { className: "wv-card-thumb" });
  if (entry.thumbnail && entry.compare_image) {
    // Before/after compare slider: thumbnail is the base ("after"), the compare
    // image the revealed overlay ("before"). Hover sweeps the wipe.
    thumb.classList.add("wv-card-thumb-compare");
    thumb.appendChild(buildCompareSlider(entry));
  } else if (entry.thumbnail) {
    thumb.appendChild(el("img", { src: VaultAPI.mediaUrl(entry.id, entry.thumbnail, entry.updated_at), alt: entry.name, loading: "lazy", decoding: "async" }));
  } else if (controller.state.settings?.default_thumbnail_behavior !== "blank") {
    thumb.appendChild(el("div", { className: "wv-card-thumb-placeholder" }, [el("i", { className: "pi pi-image" })]));
  }

  thumb.appendChild(el("div", { className: "wv-card-thumb-scrim" }));
  thumb.appendChild(
    el(
      "span",
      { className: `wv-card-status wv-status-badge wv-status-${entry.status}`, title: STATUS_LABELS[entry.status] || entry.status },
      [STATUS_LABELS[entry.status] || entry.status]
    )
  );
  thumb.appendChild(
    el(
      "button",
      {
        className: `wv-card-fav${entry.favorite ? " wv-fav-active" : ""}`,
        title: entry.favorite ? "Remove from favorites" : "Add to favorites",
        onclick: (e) => {
          e.stopPropagation();
          toggleFavorite(controller, entry);
        },
      },
      [el("i", { className: entry.favorite ? "pi pi-star-fill" : "pi pi-star" })]
    )
  );
  thumb.appendChild(
    el(
      "button",
      {
        className: "wv-card-open",
        title: "Open workflow",
        "aria-label": `Open ${entry.name} workflow`,
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await openCurrentVersion(controller, entry);
          if (ok) controller.close();
        },
      },
      [el("i", { className: "pi pi-play" })]
    )
  );
  const genTypes = (entry.generation_types || []).map((id) => GENERATION_TYPE_MAP[id]).filter(Boolean);
  if (genTypes.length) {
    const MAX_BADGES = 2;
    const shown = genTypes.slice(0, MAX_BADGES);
    const badges = el("div", { className: "wv-card-gentypes" });
    for (const t of shown) {
      badges.appendChild(
        el("span", { className: "wv-card-gentype", title: `Generation type: ${t.label}` }, [el("i", { className: t.icon }), t.label])
      );
    }
    const extra = genTypes.length - shown.length;
    if (extra > 0) {
      badges.appendChild(
        el(
          "span",
          { className: "wv-card-gentype wv-card-gentype-more", title: genTypes.map((t) => t.label).join(", ") },
          [`+${extra}`]
        )
      );
    }
    thumb.appendChild(badges);
  }
  card.appendChild(thumb);

  const body = el("div", { className: "wv-card-body" });
  body.appendChild(el("div", { className: "wv-card-title", title: entry.name }, [entry.name]));

  // Cosmetic field visibility — these toggles only hide/show, they never change
  // the underlying entry data. Missing/undefined keys default to visible.
  const cf = controller.state.settings?.card_fields || {};
  const show = (key) => cf[key] !== false;

  if (show("description") && entry.description) {
    body.appendChild(el("div", { className: "wv-card-desc" }, [entry.description]));
  }

  if (show("tags") && entry.tags && entry.tags.length) {
    const activeTags = controller.filters.tags || [];
    body.appendChild(
      el(
        "div",
        { className: "wv-card-tags" },
        entry.tags.map((t) => {
          const active = activeTags.includes(t);
          const toggle = (e) => {
            e.stopPropagation(); // don't open the entry — just filter by the tag
            toggleTagFilter(controller, t);
          };
          return el(
            "span",
            {
              className: `wv-tag wv-tag-clickable${active ? " wv-tag-active" : ""}`,
              role: "button",
              tabindex: "0",
              title: active ? `Remove tag filter: ${t}` : `Filter by tag: ${t}`,
              onclick: toggle,
              onkeydown: (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(e);
                }
              },
            },
            [t]
          );
        })
      )
    );
  }

  const versionCount = (entry.versions || []).length;
  const exampleCount = (entry.examples || []).length;
  const footerItems = [];
  if (show("versions")) {
    footerItems.push(
      el("span", { className: "wv-card-footer-item" }, [
        el("i", { className: "pi pi-clone" }),
        `${versionCount} version${versionCount === 1 ? "" : "s"}`,
      ])
    );
  }
  if (show("examples")) {
    footerItems.push(
      el("span", { className: "wv-card-footer-item" }, [
        el("i", { className: "pi pi-images" }),
        `${exampleCount} example${exampleCount === 1 ? "" : "s"}`,
      ])
    );
  }
  if (show("date")) {
    footerItems.push(
      el("span", { className: "wv-card-footer-item" }, [el("i", { className: "pi pi-clock" }), formatDateOnly(entry.updated_at)])
    );
  }
  if (footerItems.length) {
    body.appendChild(el("div", { className: "wv-card-footer" }, footerItems));
  }

  card.appendChild(body);
  return card;
}

async function toggleFavorite(controller, entry) {
  try {
    const formData = new FormData();
    formData.append("data", JSON.stringify({ favorite: !entry.favorite }));
    await VaultAPI.updateEntryMetadata(entry.id, formData);
    await controller.refresh();
  } catch (e) {
    showToast(e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function renderEmptyState(controller) {
  const { state, filters } = controller;
  const hasAnyEntries = (state.entries || []).length > 0;
  const wrap = el("div", { className: "wv-empty" });

  if (!hasAnyEntries) {
    wrap.appendChild(el("div", { className: "wv-empty-icon" }, [el("i", { className: "pi pi-inbox" })]));
    wrap.appendChild(el("div", { className: "wv-empty-title" }, ["Your vault is empty"]));
    wrap.appendChild(
      el("div", { className: "wv-empty-text" }, [
        "Save your current workflow to get started. You can add tags, status, documentation, and examples now or later.",
      ])
    );
    wrap.appendChild(
      el(
        "button",
        { className: "wv-btn wv-btn-primary", onclick: () => controller.openWizard({ mode: "full" }) },
        ["Save Current Workflow"]
      )
    );
  } else {
    wrap.appendChild(el("div", { className: "wv-empty-icon" }, [el("i", { className: "pi pi-search" })]));
    wrap.appendChild(el("div", { className: "wv-empty-title" }, ["No workflows match your filters"]));
    wrap.appendChild(
      el(
        "button",
        {
          className: "wv-btn",
          onclick: () => {
            const showArchived = controller.filters.showArchived;
            controller.filters = { search: "", status: null, favoritesOnly: false, showArchived, generationType: null, tags: [] };
            controller.ui = controller.ui || {};
            controller.ui.tagQuery = "";
            controller.render();
          },
        },
        ["Clear filters"]
      )
    );
  }

  return wrap;
}
