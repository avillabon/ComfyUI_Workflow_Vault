// Window size: how wide the vault modal may grow. "auto" steps up with the
// viewport (the --wv-modal-max breakpoints in workflow_vault.css); the other
// values pin a maximum width. The choice is saved in the vault's settings, so it
// follows the vault to any browser.

// [id, label, max width in px (null = follows the screen), what it's for].
// The pixel values mirror the data-size rules in workflow_vault.css.
export const WINDOW_SIZES = [
  ["auto", "Auto", null, "Adapts to your screen"],
  ["compact", "Compact", 1400, "Smaller footprint"],
  ["comfortable", "Comfortable", 1640, "A little more room"],
  ["wide", "Wide", 2000, "Big monitors"],
  ["ultrawide", "Ultra-wide", 2400, "Ultra-wide monitors"],
];

// Grid card widths per Card size, and the fixed chrome around the grid. These
// mirror .wv-grid-size-* and .wv-sidebar/.wv-main in workflow_vault.css and are
// only used to estimate "cards per row" for the picker.
const CARD_WIDTH = { small: 200, medium: 250, large: 320, xlarge: 400 };
const GRID_GAP = 14;
const SIDEBAR_WIDTH = 248;
const MAIN_PADDING = 40 + 15; // 20px each side, plus a scrollbar
const DRAWER_BREAKPOINT = 900; // below this the sidebar is a drawer, not a column

// The modal never exceeds 92% of the viewport.
export function effectiveWidth(maxPx, viewportWidth) {
  return Math.round(Math.min(viewportWidth * 0.92, maxPx));
}

export function cardsPerRow(modalWidth, cardSize) {
  const card = CARD_WIDTH[cardSize] || CARD_WIDTH.medium;
  const sidebar = modalWidth > DRAWER_BREAKPOINT ? SIDEBAR_WIDTH : 0;
  const room = modalWidth - sidebar - MAIN_PADDING;
  return Math.max(1, Math.floor((room + GRID_GAP) / (card + GRID_GAP)));
}

// What Auto resolves to on this screen. Measured with a hidden, unpinned modal
// so it reads the CSS breakpoints themselves and can never drift from them.
export function autoMaxWidth() {
  const probe = document.createElement("div");
  probe.className = "wv-modal";
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;";
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).getPropertyValue("--wv-modal-max"));
  probe.remove();
  return Number.isFinite(px) ? px : null;
}

// A last-known size, kept in this browser only so the window opens at the right
// width before the vault's settings have loaded (otherwise it would open at Auto
// and then jump). The vault's own setting is the source of truth.
const HINT_KEY = "workflow-vault.window-size-hint";

export function isWindowSize(value) {
  return WINDOW_SIZES.some(([id]) => id === value);
}

export function readWindowSizeHint() {
  try {
    const value = localStorage.getItem(HINT_KEY);
    return isWindowSize(value) ? value : "auto";
  } catch {
    return "auto"; // storage can be unavailable (private mode, blocked site data)
  }
}

export function saveWindowSizeHint(size) {
  try {
    localStorage.setItem(HINT_KEY, size);
  } catch {
    // ignore: the hint only avoids a layout jump on first open
  }
}
