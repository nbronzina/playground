# BRIEF.md

---
schema: "1.0"
date: 2026-04-14
module: mk-1
session_type: debug
author: interplay
---

## 1. Intent
Diagnostic + fix. Confirm whether MK1.utils.forceCleanup() properly
disconnects AudioNodes or only silences them. If nodes are orphaned,
implement the correct teardown pattern.

## 2. Constraints
- Do not change synthesis behavior
- Do not change the FX chain
- Do not change the looper
- Audio must sound identical before and after the fix
- Fix must not introduce new allocations inside AudioWorklet process()

## 3. Decisions already made
n0body calls MK1.drums.hit() and MK1.synth.play() continuously.
Each call creates transient OscillatorNode + GainNode pairs.
In a 60-minute session this generates 1,200–6,000+ nodes.

Correct teardown pattern (from audio engine research):
  node.stop()
  setTimeout(() => node.disconnect(), 100)

This must be applied to every transient node created in drums and synth.

forceCleanup() is called reactively every 60s by n0body's health monitor.
If it only silences nodes (gain to 0) without disconnecting them,
the AudioContext graph grows unbounded and degrades.

## 4. What was deliberately not done
- No changes to n0body — mk-1 owns its own node lifecycle
- No SharedArrayBuffer — deployment complexity not justified yet
- No AudioWorklet refactor for drum engine — separate future BRIEF

## 5. Vocabulary
- zombie nodes: AudioNodes connected to the graph but silent,
  never disconnected after playback ends
- forceCleanup(): MK1.utils method called by n0body's health monitor
- teardown pattern: stop() → setTimeout(disconnect, 100)

## 6. Success criterion
1. Confirm whether forceCleanup() calls disconnect() on completed nodes
2. If not: add disconnect() to all transient node teardowns in
   drums and synth
3. After fix: a 90-minute n0body session shows no AudioContext degradation
4. forceCleanup() explicitly disconnects all tracked nodes, not just stops them

## 7. Do not touch
- bitcrusher-processor.js
- mk-dwell/
- playground-core.css
- The looper slots (A/B/C/D)

## 8. Resume prompt
Audit mk-1.js for AudioNode lifecycle management. Confirm whether
MK1.utils.forceCleanup() disconnects nodes or only silences them.
Check drums.hit() and synth.play() — every transient OscillatorNode
and GainNode must call stop() then setTimeout(() => disconnect(), 100)
after playback. If zombie nodes exist, implement the teardown pattern
throughout. Do not change synthesis behavior, FX chain, or looper.
