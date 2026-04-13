# BRIEF.md

---
schema: "1.0"
date: 2026-04-14
module: mk-1
session_type: debug
author: interplay
---

## 1. Intent
Connect driftGain and lfoGain modulation routing in the synth engine.
The piano should feel alive — subtle pitch drift and LFO movement,
never static, never mechanical.

## 2. Constraints
- Do not change the synthesis architecture
- Do not change existing FX chain
- Do not change drums or looper
- Modulation must be subtle by default — movement, not vibrato
- Must follow the safe parameter write pattern (no direct .value assignment)
- Must not introduce allocations inside AudioWorklet process()

## 3. Decisions already made
driftGain and lfoGain exist in the code but their outputs
are never connected to any AudioParam destination.

Expected routing (from behavioral-patterns.md):
- driftGain output → oscillator.detune
  (tape wobble: LFO 0.1–0.3 semitones, rate 0.1–0.3 Hz)
- lfoGain output → filter.frequency or oscillator.frequency
  (slow movement, below threshold of obvious vibrato)

These values produce organic movement without being audible
as an effect — the listener experiences texture, not modulation.

## 4. What was deliberately not done
- No new UI controls for drift/LFO depth — invisible by default
- No user-facing parameters exposed yet
- No changes to n0body's parameter surface (separate BRIEF if needed)

## 5. Vocabulary
- driftGain: GainNode controlling pitch drift depth on oscillator
- lfoGain: GainNode controlling LFO modulation depth
- detune: AudioParam on OscillatorNode (in cents, 100 cents = 1 semitone)
- tape wobble: subtle random pitch drift simulating analog imperfection

## 6. Success criterion
1. driftGain output connected to oscillator.detune
2. lfoGain output connected to appropriate destination
3. Playing a sustained note on any wave type produces
   subtle, organic pitch movement
4. Movement is not audible as vibrato — it's felt as texture
5. n0body sessions show more expressive piano behavior

## 7. Do not touch
- bitcrusher-processor.js
- mk-dwell/
- drums engine
- looper slots
- FX chain order

## 8. Resume prompt
Connect the missing modulation routing in mk-1.js synth engine.
driftGain output must connect to oscillator.detune (tape wobble:
0.1-0.3 semitones, LFO rate 0.1-0.3 Hz). lfoGain output must connect
to its intended destination — check the existing LFO source to confirm
the correct target. Modulation must be subtle by default: movement
felt as texture, not heard as vibrato. Do not change synthesis
architecture, FX chain, drums, or looper.
