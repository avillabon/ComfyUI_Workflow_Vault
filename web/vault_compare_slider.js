// Before/after compare slider for grid thumbnails.
//
// The card stacks two stills: the entry thumbnail is the base ("after"), and a
// second overlay image ("before") sits on top, clipped with `clip-path: inset()`.
// Moving the cursor across the card sweeps the clip line (and the handle) so the
// overlay is revealed up to the pointer — the same technique ComfyUI and
// comfy.org use. Pure hover, no drag state.
//
// initCompareSlider(el) wires the listeners on the `.wv-compare-slider` element
// and returns a cleanup function that removes them (call it when the card is
// torn down / re-rendered).

import { el as makeEl } from "./vault_dom.js";
import { VaultAPI } from "./vault_api.js";

// Builds the two-image compare slider for an entry (base = thumbnail / "after",
// overlay = compare image / "before") and wires the hover wipe. Shared by the
// grid card and the entry overview preview so the markup lives in one place.
// The element is `position:absolute; inset:0`, so the caller just drops it into
// any positioned container (.wv-card-thumb, .wv-overview-thumb, …).
export function buildCompareSlider(entry) {
  const after = makeEl("img", {
    src: VaultAPI.mediaUrl(entry.id, entry.thumbnail, entry.updated_at),
    alt: `${entry.name} — after`,
    loading: "lazy",
    decoding: "async",
    draggable: "false",
  });
  const before = makeEl("img", {
    src: VaultAPI.mediaUrl(entry.id, entry.compare_image, entry.updated_at),
    alt: `${entry.name} — before`,
    loading: "lazy",
    decoding: "async",
    draggable: "false",
  });
  const slider = makeEl("div", { className: "wv-compare-slider", "data-compare-slider": "" }, [
    after,
    makeEl("div", { className: "wv-compare-overlay", style: "clip-path:inset(0 50% 0 0);" }, [before]),
    makeEl("div", { className: "wv-compare-handle", style: "left:50%;", "aria-hidden": "true" }, [
      makeEl("div", { className: "wv-compare-grip" }, [makeEl("i", { className: "pi pi-arrows-h" })]),
    ]),
  ]);
  initCompareSlider(slider);
  return slider;
}

export function initCompareSlider(el) {
  if (!el) return () => {};
  const overlay = el.querySelector(".wv-compare-overlay");
  const handle = el.querySelector(".wv-compare-handle");
  if (!overlay || !handle) return () => {};

  const update = (clientX) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const pct = (x / rect.width) * 100;
    overlay.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    handle.style.left = `${pct}%`;
  };

  const onMouse = (e) => update(e.clientX);
  const onTouch = (e) => {
    e.preventDefault();
    if (e.touches[0]) update(e.touches[0].clientX);
  };
  // Snap back to a centered split when the pointer leaves.
  const onLeave = () => {
    overlay.style.clipPath = "inset(0 50% 0 0)";
    handle.style.left = "50%";
  };

  el.addEventListener("mousemove", onMouse);
  el.addEventListener("mouseleave", onLeave);
  el.addEventListener("touchmove", onTouch, { passive: false });

  return () => {
    el.removeEventListener("mousemove", onMouse);
    el.removeEventListener("mouseleave", onLeave);
    el.removeEventListener("touchmove", onTouch);
  };
}
