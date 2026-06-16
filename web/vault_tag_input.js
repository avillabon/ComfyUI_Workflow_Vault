// Tag input: pill-style tags with autocomplete drawn from existing vault tags.
// Returns a container element with a getTags() method and a "change" event
// fired whenever the tag list changes.

import { el, clear } from "./vault_dom.js";

/** Build a { tag: usageCount } map from a list of entries. */
export function tagCountsFrom(entries) {
  const counts = {};
  for (const e of entries || []) {
    for (const t of e.tags || []) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

export function renderTagInput({ tags = [], allTags = [], tagCounts = null } = {}) {
  let current = [...tags];

  const wrap = el("div", { className: "wv-tag-input" });
  const pills = el("div", { className: "wv-tag-pills" });
  const input = el("input", {
    className: "wv-input wv-tag-input-field",
    type: "text",
    placeholder: "Add tag…",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
  });
  const suggestions = el("div", { className: "wv-tag-suggestions", role: "listbox" });
  suggestions.style.display = "none";

  function renderPills() {
    clear(pills);
    for (const tag of current) {
      pills.appendChild(
        el("span", { className: "wv-tag-pill" }, [
          `#${tag}`,
          el(
            "button",
            { type: "button", className: "wv-tag-pill-remove", title: "Remove tag", onclick: () => removeTag(tag) },
            ["×"]
          ),
        ])
      );
    }
  }

  function addTag(raw) {
    // Normalize: lowercase, drop a leading '#', collapse inner whitespace.
    const tag = (raw || "").trim().toLowerCase().replace(/^#+/, "").trim();
    if (!tag || current.includes(tag)) return;
    current.push(tag);
    renderPills();
    wrap.dispatchEvent(new Event("change"));
  }

  function removeTag(tag) {
    current = current.filter((t) => t !== tag);
    renderPills();
    wrap.dispatchEvent(new Event("change"));
  }

  let matches = [];
  let activeIndex = -1;
  let popularMode = false;

  function hideSuggestions() {
    matches = [];
    activeIndex = -1;
    popularMode = false;
    suggestions.style.display = "none";
    input.setAttribute("aria-expanded", "false");
  }

  // Top tags by usage (falls back to alphabetical if no counts were passed).
  function computePopular() {
    const pool = allTags.filter((t) => !current.includes(t.toLowerCase()));
    if (tagCounts) {
      return [...pool]
        .sort((a, b) => (tagCounts[b] || 0) - (tagCounts[a] || 0) || a.localeCompare(b))
        .slice(0, 24);
    }
    return pool.slice(0, 24);
  }

  function renderSuggestions() {
    clear(suggestions);
    if (!matches.length) {
      hideSuggestions();
      return;
    }
    suggestions.appendChild(
      el("div", { className: "wv-tag-suggestions-label" }, [popularMode ? "Popular tags" : "Matching tags"])
    );
    const grid = el("div", { className: "wv-tag-suggestion-grid" });
    matches.forEach((m, i) => {
      grid.appendChild(
        el(
          "button",
          {
            type: "button",
            className: `wv-tag-suggestion-pill${i === activeIndex ? " wv-tag-suggestion-active" : ""}`,
            role: "option",
            "aria-selected": i === activeIndex ? "true" : "false",
            // mousedown (not click) fires before the input's blur, and
            // preventDefault keeps focus, so selection works without a timer.
            onmousedown: (e) => {
              e.preventDefault();
              selectMatch(m);
            },
          },
          [`#${m}`]
        )
      );
    });
    suggestions.appendChild(grid);
    suggestions.style.display = "";
    input.setAttribute("aria-expanded", "true");
  }

  function selectMatch(m) {
    addTag(m);
    input.value = "";
    // Keep the dropdown open so several tags can be added in one go; refresh
    // it so the just-added tag drops off the list.
    updateSuggestions();
    input.focus();
  }

  function updateSuggestions() {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      popularMode = true;
      matches = computePopular();
      activeIndex = -1;
      renderSuggestions();
      return;
    }
    popularMode = false;
    matches = allTags
      .filter((t) => t.toLowerCase().includes(query) && !current.includes(t.toLowerCase()))
      .slice(0, 16);
    activeIndex = -1;
    renderSuggestions();
  }

  input.addEventListener("input", updateSuggestions);
  input.addEventListener("focus", updateSuggestions);
  input.addEventListener("blur", hideSuggestions);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && matches.length) {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % matches.length;
      renderSuggestions();
    } else if (e.key === "ArrowUp" && matches.length) {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + matches.length) % matches.length;
      renderSuggestions();
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (activeIndex >= 0 && matches[activeIndex]) {
        selectMatch(matches[activeIndex]);
      } else if (input.value.trim()) {
        addTag(input.value);
        input.value = "";
        updateSuggestions();
      }
    } else if (e.key === " ") {
      // Space commits the typed-out tag (the user's own word), rather than a
      // highlighted suggestion — so you can type "video colorize " quickly.
      if (input.value.trim()) {
        e.preventDefault();
        addTag(input.value);
        input.value = "";
        updateSuggestions();
      } else {
        e.preventDefault(); // swallow stray leading spaces
      }
    } else if (e.key === "Backspace" && !input.value && current.length) {
      removeTag(current[current.length - 1]);
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  renderPills();

  wrap.appendChild(pills);
  wrap.appendChild(el("div", { className: "wv-tag-input-field-wrap" }, [input, suggestions]));

  wrap.getTags = () => [...current];
  return wrap;
}
