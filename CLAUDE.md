# CLAUDE.md — play·ground

## Identity

play·ground is a browser-native audio project.
Tools for making sound. Spaces for sharing it.
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
├── tools
│   ├── mk-1        — browser synth (mk-1.html, mk-1.js, mk-1.css)
│   └── mk-room     — local sharing (not deployed yet)
├── spaces
│   ├── mk-air      — ephemeral live broadcast (separate repo, Vercel)
│   └── mk-dwell    — cursor-driven spatial soundscape (mk-dwell/)
└── airtists
    └── n0body      — autonomous agent, plays mk-1, broadcasts on mk-air
                      (separate repo: github.com/nbronzina/n0body)

## Repository Structure

Flat. No build step. No bundler. Files served directly via GitHub Pages.

playground/
├── CLAUDE.md
├── index.html
├── about.html
├── mk-1.html
├── mk-1.js
├── mk-1.css
├── bitcrusher-processor.js
├── playground-core.css
├── playground.css
└── mk-dwell/

## Stack

- Web Audio API — native only, no Tone.js, no WebPDLib
- Vanilla JS — no React, no Vue, no frameworks
- CSS — no Tailwind, no preprocessors
- Zero npm dependencies
- AudioWorklet for custom DSP
- GitHub Pages for deployment

## Technical Conventions

**Audio**
- AudioContext is a singleton — never instantiate per module
- All scheduling via AudioContext.currentTime — never setTimeout for audio events
- AudioWorkletProcessor: max 6–10 declared parameters per instance
- Zero allocations inside process() — pre-allocate all buffers in constructor
- Always stop() then setTimeout(() => disconnect(), 100) on AudioBufferSourceNode
- Parameter changes via setTargetAtTime() or exponentialRampToValueAtTime()
- Loop lengths stored as integer samples — never float seconds

**Code**
- JetBrains Mono for UI text
- Commit format: [module] description — e.g. [mk-1] fix looper drift
- No comments explaining what code does — only why something non-obvious was done

**UI**
- Dark background (#0a0a0a)
- Minimal UI — the sound is the interface
- No onboarding, no tooltips, no modals
- Click/keypress to activate AudioContext
- Mobile-aware, desktop-first

## What Not To Do

- Do not add npm packages or a build step
- Do not use frameworks
- Do not add onboarding flows or explanatory UI copy
- Do not instantiate multiple AudioContexts
- Do not use setTimeout/setInterval for audio scheduling
- Do not allocate inside AudioWorklet process()
- Do not add features that require a manual to understand

## Current State

**mk-1**
- Drums: 8 voices (kick, snare, hat, clap, tom, perc, cymbal, rim)
- Keys: 9 wave types (sine, square, saw, triangle, pulse, noise, string, voice, vocoder)
- Looper: 4 slots (A/B/C/D) + mic input, overdub by layers
- FX: reverb, delay, filter, chorus, distortion, bitcrush (AudioWorklet)
- Sequencer: 8-track × 16-step
- Tempo: 120 BPM master clock
- Broadcast: direct link to mk-air

**mk-dwell**
- Cursor position → spatial audio field
- Climate variants: dwell:refuge, dwell:extinct
- Generative, never repeats, no play/pause/timeline

## Collaborators

- nbronzina — creator, creative director
- claude — technical implementation (Claude Code)
