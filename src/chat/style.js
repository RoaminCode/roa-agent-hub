'use strict';

// The look every Basecamp card shares (Blake approved the mockups, 2026-11-07): Chat's own
// font and tiles, plain bold section labels, outlined buttons in Chat's colors, and one
// filled button per card in ROA cyan for its main action. No orange anywhere; urgency and
// quiet deals are bold text and an icon. Text keeps Chat's default color, so it reads in
// light and dark mode.

// White text on this cyan passes contrast in both modes.
const ACCENT = '#00799a';

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255, alpha: 1 };
}

// The card's main action.
const primary = (text, onClick) => ({ text, type: 'FILLED', color: rgb(ACCENT), onClick });

// Everything else.
const secondary = (text, onClick) => ({ text, type: 'OUTLINED', onClick });

// A section label, as the mockups draw it.
const label = (text) => `<b>${text}</b>`;

module.exports = { ACCENT, rgb, primary, secondary, label };
