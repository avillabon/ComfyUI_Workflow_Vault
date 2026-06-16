// Reusable multi-note editor: segmented subtabs (one per note) with
// add / rename / delete, a Markdown toolbar, and an Edit/Preview toggle.
// Used by both the Notes tab and the Save-Workflow wizard so they behave
// identically. Manages its own working copy; call .getNotes() to read it.

import { el, clear, confirmDialog, promptDialog } from "./vault_dom.js";
import { renderMarkdown } from "./vault_markdown.js";

const MD_TOOLS = [
  { kind: "bold", label: "B", title: "Bold", style: "font-weight:700;" },
  { kind: "italic", label: "I", title: "Italic", style: "font-style:italic;" },
  { kind: "heading", label: "H", title: "Heading" },
  { kind: "ul", label: "•", title: "Bullet list" },
  { kind: "code", label: "</>", title: "Code", style: "font-size:11px;" },
  { kind: "link", icon: "pi pi-link", title: "Link" },
];

function renderPreview(preview, value) {
  if (value && value.trim()) {
    preview.innerHTML = renderMarkdown(value);
    preview.classList.remove("wv-doc-preview-empty");
  } else {
    preview.textContent = "Nothing here yet — switch to Edit to write this note.";
    preview.classList.add("wv-doc-preview-empty");
  }
}

function applyMarkdown(textarea, kind, onChange) {
  const { selectionStart: s, selectionEnd: e, value } = textarea;
  const sel = value.slice(s, e);
  let replacement = sel;
  let selStart = s;
  let selEnd = e;

  const wrap = (mark, placeholder) => {
    const text = sel || placeholder;
    replacement = `${mark}${text}${mark}`;
    selStart = s + mark.length;
    selEnd = selStart + text.length;
  };
  const prefixLines = (mk) => {
    if (!sel) {
      replacement = mk;
      selStart = selEnd = s + mk.length;
      return;
    }
    replacement = sel.split("\n").map((line) => `${mk}${line}`).join("\n");
    selStart = s;
    selEnd = s + replacement.length;
  };

  switch (kind) {
    case "bold": wrap("**", "bold text"); break;
    case "italic": wrap("*", "italic text"); break;
    case "heading": prefixLines("## "); break;
    case "ul": prefixLines("- "); break;
    case "link": {
      const text = sel || "text";
      replacement = `[${text}](url)`;
      selStart = s + 1;
      selEnd = s + 1 + text.length;
      break;
    }
    case "code": {
      if (sel.includes("\n")) {
        const text = sel || "code";
        replacement = "```\n" + text + "\n```";
        selStart = s + 4;
        selEnd = selStart + text.length;
      } else {
        wrap("`", "code");
      }
      break;
    }
    default: break;
  }

  textarea.value = value.slice(0, s) + replacement + value.slice(e);
  textarea.focus();
  textarea.setSelectionRange(selStart, selEnd);
  onChange();
}

/**
 * Returns a DOM element with a `.getNotes()` method returning the current
 * notes as [{id?, title, content}]. `onChange` fires on any edit.
 */
export function renderNotesEditor({ notes = [], onChange = () => {} } = {}) {
  const data = (notes && notes.length)
    ? notes.map((n) => ({ id: n.id || null, title: n.title || "Notes", content: n.content || "" }))
    : [{ id: null, title: "Notes", content: "" }];
  let activeIndex = 0;
  let previewMode = false;

  const root = el("div", { className: "wv-notes-editor" });
  const subtabRow = el("div", { className: "wv-docs-subtab-row" });
  const editorWrap = el("div", { className: "wv-docs-editor" });
  root.appendChild(subtabRow);
  root.appendChild(editorWrap);

  function addNote() {
    let n = data.length + 1;
    let title = `Note ${n}`;
    while (data.some((x) => x.title === title)) title = `Note ${++n}`;
    data.push({ id: null, title, content: "" });
    activeIndex = data.length - 1;
    previewMode = false;
    onChange();
    renderSubtabs();
    renderEditor();
  }

  async function renameActive() {
    const note = data[activeIndex];
    const next = await promptDialog({ title: "Rename note", message: "Note name", defaultValue: note.title, confirmText: "Rename" });
    if (next == null) return;
    const title = next.trim();
    if (!title) return;
    note.title = title;
    onChange();
    renderSubtabs();
    renderEditor();
  }

  async function deleteActive() {
    const note = data[activeIndex];
    const ok = await confirmDialog({
      title: `Delete note "${note.title}"?`,
      message: "This note will be removed when you save.",
      confirmText: "Delete note",
      danger: true,
    });
    if (!ok) return;
    data.splice(activeIndex, 1);
    if (activeIndex >= data.length) activeIndex = data.length - 1;
    previewMode = false;
    onChange();
    renderSubtabs();
    renderEditor();
  }

  function renderSubtabs() {
    clear(subtabRow);
    const seg = el("div", { className: "wv-segmented" });
    data.forEach((note, i) => {
      seg.appendChild(
        el(
          "button",
          {
            type: "button",
            className: `wv-segmented-btn${i === activeIndex ? " wv-segmented-btn-active" : ""}`,
            onclick: () => {
              activeIndex = i;
              previewMode = false;
              renderSubtabs();
              renderEditor();
            },
          },
          [note.title]
        )
      );
    });
    if (data.length) subtabRow.appendChild(seg);
    subtabRow.appendChild(
      el("button", { type: "button", className: "wv-btn-link", onclick: addNote }, [el("i", { className: "pi pi-plus" }), "Add note"])
    );
  }

  function renderEditor() {
    clear(editorWrap);
    if (!data.length) {
      editorWrap.appendChild(
        el("div", { className: "wv-docs-empty" }, [
          el("p", { className: "wv-muted" }, ["No notes yet."]),
          el("button", { type: "button", className: "wv-btn", onclick: addNote }, [el("i", { className: "pi pi-plus" }), "Add note"]),
        ])
      );
      return;
    }

    const note = data[activeIndex];
    const card = el("div", { className: "wv-docs-note-card" });

    const textarea = el("textarea", { className: "wv-input wv-textarea wv-doc-textarea", placeholder: "Start typing…" });
    textarea.value = note.content;
    textarea.addEventListener("input", () => {
      note.content = textarea.value;
      onChange();
    });
    const preview = el("div", { className: "wv-markdown wv-doc-preview" });

    const toolbar = el(
      "div",
      { className: "wv-md-toolbar" },
      MD_TOOLS.map((t) =>
        el(
          "button",
          {
            className: "wv-md-btn",
            type: "button",
            title: t.title,
            "aria-label": t.title,
            onclick: () => applyMarkdown(textarea, t.kind, () => {
              note.content = textarea.value;
              onChange();
            }),
          },
          t.icon ? [el("i", { className: t.icon })] : [el("span", { style: t.style || "" }, [t.label])]
        )
      )
    );

    const toggleBtn = el("button", { className: "wv-btn wv-btn-small", type: "button" });
    const applyView = () => {
      if (previewMode) {
        renderPreview(preview, textarea.value);
        preview.style.display = "";
        textarea.style.display = "none";
        toolbar.style.display = "none";
        toggleBtn.replaceChildren(el("i", { className: "pi pi-pencil" }), document.createTextNode("Edit"));
      } else {
        preview.style.display = "none";
        textarea.style.display = "";
        toolbar.style.display = "";
        toggleBtn.replaceChildren(el("i", { className: "pi pi-eye" }), document.createTextNode("Preview"));
      }
    };
    toggleBtn.onclick = () => {
      previewMode = !previewMode;
      applyView();
    };

    card.appendChild(
      el("div", { className: "wv-doc-section-header" }, [
        el("div", { className: "wv-doc-header-text" }, [el("h3", {}, [note.title])]),
        el("div", { className: "wv-docs-note-actions" }, [
          el("button", { className: "wv-icon-btn", type: "button", title: "Rename note", "aria-label": "Rename note", onclick: renameActive }, [el("i", { className: "pi pi-pencil" })]),
          el("button", { className: "wv-icon-btn wv-icon-btn-danger", type: "button", title: "Delete note", "aria-label": "Delete note", onclick: deleteActive }, [el("i", { className: "pi pi-trash" })]),
          toggleBtn,
        ]),
      ])
    );
    card.appendChild(toolbar);
    card.appendChild(textarea);
    card.appendChild(preview);
    editorWrap.appendChild(card);
    applyView();
  }

  renderSubtabs();
  renderEditor();

  root.getNotes = () => data.map((n) => ({ ...(n.id ? { id: n.id } : {}), title: n.title, content: n.content }));
  return root;
}
