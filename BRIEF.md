# BRIEF.md

---
schema: "1.0"
date: 2026-04-14
module: mk-1
session_type: new-feature
author: interplay
---

## 1. Intent
Redesign mk-1 UI to match Teenage Engineering / AIAIAI aesthetic register.
Functional, engineered, minimal — not decorative.
Every change should feel like it belongs on a physical instrument.

## 2. Constraints
- Zero changes to mk-1.js or audio engine
- Zero changes to HTML structure or element IDs (n0body depends on them)
- All changes in playground-core.css and mk-1.css only
- Both light and dark modes must work correctly after changes
- Mobile layout must remain functional

## 3. Decisions already made

**playground-core.css:**
Add to :root and :root.dark-mode:
  --accent: #ff9500;
  --accent-bg: rgba(255, 149, 0, 0.08);
  --accent-text: #cc7700 (light mode) / #ff9500 (dark mode)

**mk-1.css — three specific changes:**

1. SLIDER THUMB — square, not circle (border-radius: 0)
2. WAVE SELECTOR — 3x3 button grid replacing custom-select dropdown
3. VIBE MODULE — 8x4 LED matrix replacing SVG face

## 4. What was deliberately not done
- No layout changes — existing grid structure unchanged
- No typography changes — JetBrains Mono stays
- No color palette changes beyond adding --accent variable
- No changes to pad design — grain texture stays
- No changes to sequencer steps

## 5. Vocabulary
- accent: #ff9500, the single color that marks active/selected state
- wave-grid: the new 3x3 button matrix replacing the wave dropdown
- vibe-matrix: the 8x4 LED grid replacing the animated SVG face
- lit: active cell state (full accent color)
- dim: near-active cell state (30% accent opacity)

## 6. Success criterion
1. Wave type selection visible at a glance without opening a dropdown
2. All active states (pads, steps, slots, wave buttons) use --accent
3. Vibe matrix animates in sync with audio — reacts within 1 render frame
4. Slider thumbs are square in both light and dark mode
5. No visual regressions in dark mode
6. n0body sessions unaffected — MK1 API still works identically

## 7. Do not touch
- mk-1.js MK1 API surface (window.MK1)
- All element IDs referenced by n0body
- Audio engine initialization
- Looper, drums, sequencer, FX behavior
- playground-core.css variables other than adding --accent

## 8. Resume prompt
Redesign mk-1 visual layer to match Teenage Engineering / AIAIAI aesthetic.
Add --accent: #ff9500 to playground-core.css. Apply --accent to all
active/selected states in mk-1.css. Square slider thumbs. Replace wave
type dropdown with 3x3 button grid. Replace vibe SVG face with 8x4 LED
matrix driven by analyser frequency data. Do not touch MK1 API, element
IDs, or audio engine.
