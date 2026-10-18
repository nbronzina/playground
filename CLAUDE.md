# CLAUDE.md — play·ground

## Identity

play·ground is a browser-native audio project.
Tools to make sound. Spaces to be inside it.
No frameworks. No dependencies. No build step. Just play.

Live: https://nbronzina.github.io/playground/

## Philosophy

> "just play. no manuals. no friction."

Every decision runs through this filter.
If it requires explanation, it's wrong.
If it requires a manual, it's wrong.
If it adds friction, it's wrong.

## Ecosystem

play·ground
├── tools           — to make sound
│   ├── mk-1        — synth with drums, looper and sequencer (mk-1.html, mk-1.js, mk-1.css)
│   └── mk-2        — two decks and a mixer (mk-2.html, mk-2.css)
├── spaces          — to be inside it
│   ├── mk-air      — live radio with no archive (separate repo, https://mk-air.onrender.com/)
│   └── mk-dwell    — field of generative sound you move through (mk-dwell/)
├── airtists        — who plays here when you don't
│   └── n0body      — autonomous agent, plays mk-1 through window.MK1, goes on air at mk-air
│                     (separate repo: github.com/nbronzina/n0body)
└── planned
    └── mk-room     — local sharing (not built, not linked anywhere)

## Repository Structure

Flat. No build step. No bundler. Files served directly via GitHub Pages.

playground/
├── CLAUDE.md                     — this file (not published)
├── README.md                     — repo front page (not published)
├── BRIEF.md                      — session brief template (not published)
├── _config.yml                   — Pages config: excludes the three notes above
├── sitemap.xml                   — the 5 pages, for Search Console
├── og/                           — 1200×630 share images: home, about, mk-1, mk-2, mk-dwell
├── index.html                    — home: playable hero, tools / spaces / airtists
├── about.html
├── playground-core.css           — tokens + shared base (header, footer, buttons, custom select, grain)
├── playground.css                — home + about only
├── mk-1.html
├── mk-1.js
├── mk-1.css
├── drum-engine-processor.js      — mk-1 drums: 8 voices, sample-accurate trigger queue
├── karplus-strong-processor.js   — mk-1 "string" wave
├── bitcrusher-processor.js       — mk-1 crush fx
├── mk-2.html                     — markup + inline JS
├── mk-2.css
├── vinyl-playback-processor.js   — mk-2 deck playback: variable rate, scratch, 4 ms crossfade on jumps
└── mk-dwell/
    ├── index.html
    ├── css/dwell.css
    └── js/
        ├── audio.js              — engine: sources, drone, texture, events, scheduler
        ├── input.js              — cursor / touch position, zone tint
        └── main.js               — entry screen, enter / esc, know how

Serve over http to work locally (`python3 -m http.server`): AudioWorklet does not load from file://.

## Stack

- Web Audio API — native only, no Tone.js, no WebPDLib
- Vanilla JS — no React, no Vue, no frameworks
- CSS — no Tailwind, no preprocessors
- Zero npm dependencies
- AudioWorklet for custom DSP (4 processors)
- OfflineAudioContext only to render mk-2's demo record
- Web MIDI input in mk-1, setSinkId cue output in mk-2
- GitHub Pages for deployment

## Technical Conventions

**Audio**
- One AudioContext per page, created on the first gesture (click, key, tap) — never on load, never per module
- Wait for audioWorklet.addModule() before creating a worklet node; a gesture that arrives first is queued on that promise
- Sequences run on a lookahead scheduler over AudioContext.currentTime: a short timer only wakes the scheduler, every sound gets an exact start time (mk-1: 25 ms tick, 100 ms window; mk-dwell: 50 ms / 200 ms)
- setTimeout only for UI, for waking a scheduler and for closing a MediaRecorder on a loop boundary — never as the clock of a sound
- Limiter at the end of the master: DynamicsCompressor (−2 dB, ratio 14, 2 ms / 120 ms); mk-1 adds a makeup trim and a tanh ceiling that only rounds what passes 0.9
- AudioWorkletProcessor: max 6–10 declared parameters per instance (today: 0–1; the rest goes through port messages)
- Zero allocations inside process() — pre-allocate buffers, queues and outgoing message objects in the constructor
- Sources: stop(), then disconnect() ~100 ms later (setTimeout) or in onended
- Parameter changes via setTargetAtTime() or ramps; setValueAtTime() only at a scheduled time
- Loop lengths stored as integer samples — never float seconds
- Key handlers ignore e.repeat, modifier combos and focus inside a text field

**Code**
- JetBrains Mono for UI text; load only the weights a page uses
- Commit format: [module] description — e.g. [mk-1] fix looper drift
- No comments explaining what code does — only why something non-obvious was done
- window.MK1 is n0body's interface: keep its surface stable (drums, synth, sequencer, fx, tempo, master, looper, utils)

**UI**
- Dark only (#0a0a0a). No theme toggle
- Minimal UI — the sound is the interface
- No onboarding, no tooltips, no modals, no alert()
- Click/keypress/tap to start audio
- Mobile-aware, desktop-first: an instrument fits 1920×1000 without scroll (the footer may sit below the fold) and scales to 2560×1360
- Head on every page: lang="en", canonical, theme-color #0a0a0a, og image from og/, title `piece · what it is · play·ground` (home: `play·ground · what it is`)

## Design system

- Dark only: page #0a0a0a, surfaces #141414 / #0f0f0f, lines #2a2a2a / #444
- Two text levels: --text-primary #fff, --text-secondary #b3b3b3 (mk-2 uses white only)
- One accent per piece, picked with `data-piece` (tokens in playground-core.css):
  mk-1 #ff9500 · mk-2 #d4c5a0 · mk-dwell #8cc7a8 · mk-air #ff5a4a (n0body borrows it).
  Home and about have no accent. The wordmark dot takes the piece's accent
- Contrast: every text ≥ 4.5:1, measured on pixels, grain included
- Text ≥ 12 px inside instruments
- One help pattern: a "know how" button in the header (aria-expanded, aria-controls) opens an overlay panel that does not move the layout and closes with Esc, a click outside or the same button. Sections in this order: play · sound · who · support. No explanatory text outside it
- Common footer: same `.pg-footer` markup on every page (styles in core), `aria-current="page"` on the page itself, `../` paths in mk-dwell
- Instrument header: `<h1>` = wordmark → home + piece name, then "on air ↗" and "know how". One h1 per page, h2 per module
- One grain texture (body::before, soft-light at .06); mk-2 and mk-dwell turn it off

## Voice & glossary

- lowercase in all copy. No exclamation marks. No SaaS voice ("start creating!", "demo loaded!")
- One evocative line per piece, not a feature list
- UPPERCASE only for hardware-style panel labels inside mk-2: MIXER, PITCH, OUTPUT, ON DECK, NEXT, CRATE, MONITOR, SPEAKERS, MIX
- Glossary:
  - browser — not web-based / browser-based
  - synth — not synthesizer
  - two decks — not 2 turntables
  - on air — going out through mk-air
  - nothing kept on a server — not "no saves"
  - free — not "open" (there is no LICENSE)
- Taxonomy: tools = to make sound (mk-1, mk-2). spaces = to be inside it (mk-air, mk-dwell). airtists = who plays here when you don't (n0body)
- External links: `target="_blank" rel="noopener"` and ↗ at the end of the text. Internal links: same tab, no ↗
- The glossary rules the UI copy. Meta descriptions may add the words people search for (playground without the dot, turntables)

## What Not To Do

- Do not add npm packages or a build step
- Do not use frameworks
- Do not add onboarding flows, tooltips, modals, alert() or explanatory UI copy outside "know how"
- Do not create an AudioContext before a gesture, or more than one per page
- Do not use setTimeout/setInterval as the clock of a sound
- Do not allocate inside AudioWorklet process()
- Do not bring back a light theme, a theme toggle or decorative clocks
- Do not give a piece a second accent, or ship text under 4.5:1
- Do not say "open" without a LICENSE
- Do not add robots.txt (project page: nobody reads it there)
- Do not publish notes: anything that is not a page goes in _config.yml `exclude`
- Do not add features that require a manual to understand

## Current State

**home + about**
- Home: the hero plays on the first key or click (one short voice in A minor pentatonic, keys climb by physical row); the wordmark dot lights in a piece's accent. Three shelves (tools / spaces / airtists), one card per piece, a closing line, common footer
- About: the definition, one row per category with links to each piece, "just play." large, signature. The first-person "why" is a `<!-- WHY: -->` comment waiting for Nicolás

**mk-1**
- One-screen console (100dvh): status bar (transport, messages, demo, clear) + 3 columns: pads + pattern · wave + keys · loop + vibe + fx/tempo
- Drums: 8 voices (kick, snare, hat, clap, tom, perc, cymbal, rim) in drum-engine-processor.js; node engine as fallback
- Keys: 13 (C4–C5), qwerty / azerty / qwertz layouts (choice kept in localStorage), attack / release
- Waves: 9 (sine, square, saw, triangle, pulse, noise, string, voice, vocoder). string = Karplus-Strong worklet. vocoder asks for the mic on its first note
- MIDI input after the first gesture: channel 10 → drums (GM map), other channels → keys
- Sequencer: 8 tracks × 16 steps on the lookahead scheduler, undo / redo
- Looper: 4 slots (A/B/C/D), rec manual, play+rec with the pattern, add layer (overdub aligned to the loop, whole cycles), play / play all, clear, mic input. Takes are recorded after the limiter (.webm); download and export all
- FX: reverb, delay, filter, chorus, distortion, bitcrush (AudioWorklet), volume. Tempo 60–200, default 120
- Vibe: 8×4 spectrum matrix; waveform display
- Modulation: driftLFO → subOsc.detune (tape wobble, 0.1–0.3 Hz, ±15 cents)
- Modulation: lfoGain → formant detune (slow organic movement, 1–2 Hz, ±20 cents)
- Node lifecycle: stop() → setTimeout(disconnect, 100) in cleanupVoice and the looper
- on air ↗ → https://mk-air.onrender.com/broadcast?from=mk1
- Gaps: the fx sliders write AudioParam.value directly; the string voice is stopped by a setTimeout message; "on air ↗" and "know how" are 11.2 px

**mk-2**
- Two decks: grab the disc to scratch, let go and it keeps spinning; click the groove or the timeline to drop the needle; motor spin-up and brake; 33 / 45; pitch ±8; restart; « » 10 s; eject; load
- 5 hot cues per deck (1–5 on A, 6–0 on B), shift + number clears; cue marks on the timeline; strobe ring that drifts with pitch
- Mixer: per channel trim, high / mid / low, filter, volume with meter, cue; crossfader; master with limiter
- Cue: a second output through setSinkId (OUTPUT: MONITOR / SPEAKERS) with a cue → master blend. Without setSinkId: one output only, and it says so
- Crate: drop many files or paste an audio url; queues as NEXT when a deck is busy; errors say what failed (404, CORS, offline, can't decode) and never stop a playing deck
- Demo record: "demo · mk-2", pressed in the browser on the first gesture (16 bars, 94 bpm, D minor), on deck A at open and in the crate. Nothing downloaded
- At rest: slipmat and strobe on empty platters, a gold line that breathes in the viz (still with reduced motion, paused in a hidden tab)
- Keys: q/p play, w/o restart, e/i eject, ← → crossfade, double-click resets a knob or fader
- Mobile (≤ 1000 px): one deck at a time with an A/B toggle; ≥ 40 px targets on touch
- on air ↗ → https://mk-air.onrender.com/

**mk-dwell**
- Entry screen (name, one line, enter) → inside, cursor or finger position → spatial field
- 5 positioned sources: bell (top left), rain (top right), sub (bottom left), clicks (bottom right), a breath (center), over a drone, a texture and rare events. Position moves pan, filter, reverb, delay and source gains; the background tints by zone
- Always in key: C pentatonic for every pitched voice
- Generative (seeded xorshift), never the same twice, no play/pause/timeline
- Esc leaves to the entry; entering again reuses the graph, nothing piles up
- Planned, not built: climate variants (dwell:refuge, dwell:extinct)
- Gaps: no limiter (peaks above 1.0 near the sub corner); after Esc the context keeps running silent

## Decisions

- 2026-10-18 · Dark only across the family (index, about, mk-1). No theme toggle. Real #0a0a0a
- 2026-10-18 · Spaces are places to be inside the sound: "tools to make sound. spaces to be inside it." mk-dwell and mk-air are spaces
- 2026-10-18 · Domain: stay on https://nbronzina.github.io/playground/ with canonical. No robots.txt in the repo
- 2026-10-18 · "You can't sound bad" (quantize to a scale) only in mk-dwell. mk-1 stays free
- 2026-10-18 · Sharing (link to mk-air vs a postcard): pending, not implemented
- 2026-10-18 · Copy: apply the audit rewrites (one line per piece, the glossary above)
- 2026-10-18 · About: structure + links to each piece + "just play." large. The first-person why is Nicolás's: a `<!-- WHY: -->` comment, no visible placeholder
- 2026-10-18 · mk-2: a demo record synthesized in the browser (no external files), loaded on A at open; platter and viz alive at rest

## Collaborators

- nbronzina — creator, creative director
- claude — technical implementation (Claude Code)
