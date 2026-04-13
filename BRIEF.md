# BRIEF.md

---
schema: "1.0"
date: 2026-04-14
module: mk-1
session_type: refactor
author: interplay
---

## 1. Intent
Replace string wave Karplus-Strong implementation with a proper
AudioWorklet circular buffer. Unlock sub-344Hz range for the full
instrument. Make the string voice feel like a real physical string —
not a buffer playback.

## 2. Constraints
- New implementation must cover at minimum C2-C5 range (65Hz-523Hz)
- Zero allocations inside AudioWorkletProcessor process()
- Must follow existing voice registration pattern (registerSynthVoice)
- Teardown pattern: stop() -> setTimeout(disconnect, 100)
- safeSetParam() pattern for any AudioParam writes
- Must work in both Chrome and Firefox

## 3. Decisions already made

Current implementation (playNote, wave === 'string') uses
AudioBuffer + BufferSource with pre-computed Karplus-Strong data.
Works but is limited to C4-C5 and cannot go lower.

New implementation: custom AudioWorkletProcessor with circular buffer.

Architecture:
- New file: karplus-strong-processor.js
- Registered as 'karplus-strong-processor'
- Constructor receives frequency via processorOptions
- Circular buffer size = Math.round(sampleRate / frequency)
- Initial excitation: white noise burst in constructor
- process() loop: averaging filter (damping coefficient 0.996,
  brightness 0.5) -- no allocations, reuse pre-allocated buffer
- Processor exposes one AudioParam: damping (0.990-0.999)

Integration in playNote():
- Replace the existing 'string' wave branch entirely
- Create AudioWorkletNode with processorOptions: { frequency: freq }
- Connect: karplusNode -> bodyFilter -> stringGain -> saturator
- Keep existing bodyFilter (peaking at freq*2, Q:1, gain:3)
- Keep existing stringGain envelope
- Register nodes via registerSynthVoice

Fallback: if AudioWorklet unavailable, keep existing BufferSource
implementation as fallback (already works for C4-C5).

## 4. What was deliberately not done
- No granular synthesis -- separate future BRIEF
- No 4-op FM -- separate future BRIEF
- No changes to other wave types
- No changes to drum engine in this BRIEF

## 5. Vocabulary
- circular buffer: fixed-size array where write position wraps around
- damping: the coefficient controlling decay rate (0.990 = fast, 0.999 = slow)
- brightness: low-pass filter coefficient (0.5 = balanced)
- excitation: initial noise burst that sets the string vibrating

## 6. Success criterion
1. String wave plays C2 (65Hz) without artifacts
2. String wave plays C4 (261Hz) -- same quality as before or better
3. No buffer overruns or clicks on rapid note repetition
4. Voice cleanup works -- no memory accumulation after 30+ notes
5. Fallback activates silently if AudioWorklet unavailable

## 7. Do not touch
- All other wave types in playNote()
- Drum engine
- MK1 API surface
- Looper
- playground-core.css and mk-1.css

## 8. Resume prompt
Replace the 'string' wave implementation in mk-1.js with a proper
AudioWorklet Karplus-Strong circular buffer synthesis.
Create karplus-strong-processor.js with a circular buffer in the
constructor (size = sampleRate/frequency), white noise excitation,
and averaging filter in process() with zero allocations.
Register as 'karplus-strong-processor'. In playNote() string branch,
replace the BufferSource implementation with AudioWorkletNode using
processorOptions: { frequency: freq }. Keep existing bodyFilter and
stringGain. Keep BufferSource as fallback if AudioWorklet unavailable.
Follow existing voice registration and teardown patterns.
