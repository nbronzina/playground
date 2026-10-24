// ============================================
// CUSTOM SELECT COMPONENT
// ============================================
class CustomSelect {
    constructor(element) {
        this.element = element;
        this.trigger = element.querySelector('.custom-select-trigger');
        this.dropdown = element.querySelector('.custom-select-dropdown');
        this.options = element.querySelectorAll('.custom-select-option');
        this.valueDisplay = element.querySelector('.custom-select-value');

        this.init();
    }

    init() {
        // Toggle dropdown
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        // Select option
        this.options.forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                this.select(option);
            });
        });

        // Close on outside click
        document.addEventListener('click', () => {
            this.close();
        });

        // Keyboard navigation
        this.trigger.addEventListener('keydown', (e) => {
            this.handleKeydown(e);
        });

        this.element.addEventListener('keydown', (e) => {
            if (this.isOpen()) {
                this.handleDropdownKeydown(e);
            }
        });
    }

    toggle() {
        if (this.isOpen()) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        // Close any other open selects
        document.querySelectorAll('.custom-select.open').forEach(select => {
            if (select !== this.element) {
                select.classList.remove('open');
                select.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
            }
        });
        this.element.classList.add('open');
        this.trigger.setAttribute('aria-expanded', 'true');
    }

    close() {
        this.element.classList.remove('open');
        this.trigger.setAttribute('aria-expanded', 'false');
    }

    isOpen() {
        return this.element.classList.contains('open');
    }

    select(option) {
        // Remove selected from all
        this.options.forEach(opt => opt.classList.remove('selected'));

        // Add selected to clicked
        option.classList.add('selected');

        // Update value
        const value = option.dataset.value;
        this.element.dataset.value = value;
        this.valueDisplay.textContent = option.textContent;

        // Close dropdown
        this.close();

        // Dispatch change event
        this.element.dispatchEvent(new CustomEvent('change', {
            detail: { value }
        }));
    }

    handleKeydown(e) {
        switch(e.key) {
            case 'Enter':
            case ' ':
            case 'ArrowDown':
                e.preventDefault();
                this.open();
                break;
            case 'Escape':
                this.close();
                break;
        }
    }

    handleDropdownKeydown(e) {
        const currentIndex = Array.from(this.options).findIndex(opt =>
            opt.classList.contains('selected')
        );

        switch(e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (currentIndex < this.options.length - 1) {
                    this.options[currentIndex + 1].focus();
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (currentIndex > 0) {
                    this.options[currentIndex - 1].focus();
                }
                break;
            case 'Enter':
                e.preventDefault();
                const focused = this.dropdown.querySelector(':focus');
                if (focused) {
                    this.select(focused);
                }
                break;
            case 'Escape':
                e.preventDefault();
                this.close();
                this.trigger.focus();
                break;
        }
    }
}

// Store CustomSelect instances
const customSelectInstances = {};

// ============================================
// CONSTANTS
// ============================================
const AUDIO_CONSTANTS = {
    MASTER_VOLUME: 0.7,
    ANALYSER_FFT_SIZE: 2048,
    DELAY_FEEDBACK: 0.5,
    REVERB_TIME: 2.2,
    DEFAULT_FILTER_FREQ: 10000
};

const SYNTH_DEFAULTS = {
    ATTACK_MS: 10,
    RELEASE_MS: 300
};

const ANIMATION_CONSTANTS = {
    VIZ_LINE_WIDTH: 2
};

const SCHEDULER = {
    TICK_MS: 25,
    LOOKAHEAD: 0.1,
    LATE: 0.05
};

const LIMITER = {
    THRESHOLD: -2,
    KNEE: 0,
    RATIO: 14,
    ATTACK: 0.002,
    RELEASE: 0.12,
    CEILING: 0.9
};


// ============================================
// AUDIO ENGINE
// ============================================
let audioContext;
let masterGain;
let analyser;
let loopBus;
let isActive = false;
let audioReady = null;
let audioLoaded = false;
// cents, into every synth oscillator's detune: MIDI pitch bend plus the mod wheel's vibrato
let pitchBus = null;
let pitchBend = null;
let vibratoDepth = null;
// two seconds of noise, looped by a held noise note
let noiseLoop = null;
let octaveShift = 0;

// ============================================
// VOICE MANAGEMENT (Memory Leak Prevention)
// ============================================
const VOICE_LIMITS = {
    MAX_DRUM_VOICES: 8,
    MAX_SYNTH_VOICES: 16,
    CLEANUP_INTERVAL: 30000 // 30 seconds
};

// Active voice tracking
let activeDrumVoices = [];
let activeSynthVoices = [];
let cleanupIntervalId = null;

// Pre-generated curves (reused instead of creating new ones each time)
let sharedCurves = null;

function initSharedCurves() {
    if (sharedCurves) return sharedCurves;

    sharedCurves = {
        // Tanh curves for saturation
        tanh18: createTanhCurve(1.8),
        tanh25: createTanhCurve(2.5),
        tanh40: createTanhCurve(4.0),
        // Hard clip curve
        hardClip: createHardClipCurve(0.8, 3),
        // vocoder envelope follower: full-wave rectifier, then a ceiling that keeps the band's gain in 0–1
        rectify: Float32Array.from({ length: 1025 }, (_, i) => Math.abs((2 * i) / 1024 - 1)),
        unit: Float32Array.from({ length: 1025 }, (_, i) => Math.max(0, (2 * i) / 1024 - 1))
    };

    return sharedCurves;
}

function createTanhCurve(drive) {
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const x = (i / 128) - 1;
        curve[i] = Math.tanh(x * drive);
    }
    return curve;
}

// Identity up to the knee, then rounds into 1; odd size keeps 0 on a sample so the straight part stays exact
function createCeilingCurve(knee) {
    const size = 4097;
    const curve = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        const x = (2 * i) / (size - 1) - 1;
        const over = Math.abs(x) - knee;
        curve[i] = over > 0 ? Math.sign(x) * (knee + (1 - knee) * Math.tanh(over / (1 - knee))) : x;
    }
    return curve;
}

function createHardClipCurve(limit, gain) {
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const x = (i / 128) - 1;
        curve[i] = Math.max(-limit, Math.min(limit, x * gain));
    }
    return curve;
}

// Voice cleanup helper - disconnects all nodes in a voice
function cleanupVoice(voice) {
    if (!voice || !voice.nodes) return;

    const nodesToDisconnect = voice.nodes;
    voice.nodes = null;

    // connections into this voice from nodes that outlive it (pitch bend, the mic) would keep it alive
    if (voice.links) {
        voice.links.forEach(([from, to]) => { try { from.disconnect(to); } catch (e) {} });
        voice.links = null;
    }

    // Cancel any animation frames
    if (voice.animationIds) {
        voice.animationIds.forEach(id => cancelAnimationFrame(id));
    }
    voice.animationIds = null;

    // stop() first, then disconnect() after 100ms
    // — gives the audio thread time to finish its current render quantum
    nodesToDisconnect.forEach(node => {
        try {
            if (node.stop && typeof node.stop === 'function') {
                try { node.stop(); } catch(e) {}
            }
        } catch(e) {}
    });

    setTimeout(() => {
        nodesToDisconnect.forEach(node => {
            try {
                if (node.disconnect && typeof node.disconnect === 'function') {
                    node.disconnect();
                }
                if (node.buffer) {
                    node.buffer = null;
                }
            } catch(e) {}
        });
    }, 100);
}

// Register a new drum voice and limit active voices
function registerDrumVoice(nodes, duration) {
    const voice = {
        nodes: nodes,
        endTime: audioContext.currentTime + duration,
        animationIds: []
    };

    activeDrumVoices.push(voice);

    // If over limit, cleanup oldest voice
    while (activeDrumVoices.length > VOICE_LIMITS.MAX_DRUM_VOICES) {
        const oldest = activeDrumVoices.shift();
        cleanupVoice(oldest);
    }

    // Schedule cleanup
    setTimeout(() => {
        const index = activeDrumVoices.indexOf(voice);
        if (index > -1) {
            activeDrumVoices.splice(index, 1);
            cleanupVoice(voice);
        }
    }, duration * 1000 + 100);

    return voice;
}

// A held voice has no end yet; endSynthVoice gives it one when it's released
function registerSynthVoice(voice) {
    activeSynthVoices.push(voice);

    while (activeSynthVoices.length > VOICE_LIMITS.MAX_SYNTH_VOICES) {
        const oldest = activeSynthVoices.shift();
        oldest.released = true;
        cleanupVoice(oldest);
    }
    return voice;
}

function endSynthVoice(voice, end) {
    voice.endTime = end;
    setTimeout(() => {
        const index = activeSynthVoices.indexOf(voice);
        if (index > -1) activeSynthVoices.splice(index, 1);
        cleanupVoice(voice);
    }, Math.max(0, end - audioContext.currentTime) * 1000 + 100);
}

function releaseSynthVoices() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const voices = activeSynthVoices;
    activeSynthVoices = [];

    voices.forEach(voice => {
        voice.released = true;
        if (voice.out) {
            const gain = voice.out.gain;
            gain.cancelScheduledValues(now);
            gain.setValueAtTime(gain.value, now);
            gain.setTargetAtTime(0, now, 0.01);
        }
        setTimeout(() => cleanupVoice(voice), 60);
    });
}

// Periodic cleanup of any orphaned voices
function startVoiceCleanup() {
    if (cleanupIntervalId) return;

    cleanupIntervalId = setInterval(() => {
        if (!audioContext) return;

        const now = audioContext.currentTime;

        // Cleanup expired drum voices
        activeDrumVoices = activeDrumVoices.filter(voice => {
            if (voice.endTime < now) {
                cleanupVoice(voice);
                return false;
            }
            return true;
        });

        // Cleanup expired synth voices
        activeSynthVoices = activeSynthVoices.filter(voice => {
            if (voice.endTime < now) {
                cleanupVoice(voice);
                return false;
            }
            return true;
        });

        // Check AudioContext health
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }

    }, VOICE_LIMITS.CLEANUP_INTERVAL);
}

// A room's tail: −60 dB at `seconds`, highs dying first (a one-pole lowpass closing from 12 kHz toward 1 kHz),
// 20 ms of silence before it so the dry hit stays clear. The convolver normalizes its loudness
function makeImpulse(context, seconds) {
    const rate = context.sampleRate;
    const pre = Math.round(0.02 * rate);
    const length = pre + Math.round(seconds * rate);
    const impulse = context.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        let lp = 0;
        for (let i = pre; i < length; i++) {
            const t = (i - pre) / rate;
            const amp = Math.exp(-6.9 * t / seconds) * Math.min(1, t / 0.004);
            const a = Math.exp(-2 * Math.PI * (1000 + 11000 * Math.exp(-3 * t / seconds)) / rate);
            lp = (1 - a) * (Math.random() * 2 - 1) + a * lp;
            data[i] = lp * amp;
        }
    }
    return impulse;
}

let delayL = null;
let delayR = null;

// input → dry → output, input → (the effect) → wet → output
function makeInsert() {
    const input = audioContext.createGain();
    const dry = audioContext.createGain();
    const wet = audioContext.createGain();
    const output = audioContext.createGain();
    wet.gain.value = 0;
    input.connect(dry);
    dry.connect(output);
    wet.connect(output);
    return { input, dry, wet, output };
}

// distorted, the signal sits near 0.35 whatever comes in; this brings it back to about the dry level
const DISTORTION_MAKEUP = 0.6;

function applyDistortion(amount) {
    if (!window.distortionNode) return;
    window.distortionNode.curve = makeDistortionCurve(amount * 400);
    setParam(window.distortionDry.gain, 1 - amount);
    setParam(window.distortionMix.gain, amount * DISTORTION_MAKEUP);
}

// crush has no mix: from 1 up the sound is crushed, faded in over a few ms
function applyCrush(amount) {
    if (!window.setCrushAmount) return;
    window.setCrushAmount(amount);
    setParam(window.bitcrusherDry.gain, amount > 0 ? 0 : 1);
    setParam(window.bitcrusherMix.gain, amount > 0 ? 1 : 0);
}

// chorus keeps some dry: at full it's an even blend, about as loud as dry alone
function applyChorus(amount) {
    if (!window.chorusMix) return;
    setParam(window.chorusDry.gain, 1 - 0.4 * amount);
    setParam(window.chorusMix.gain, 0.6 * amount);
    setParam(window.chorusLFOGain.gain, 0.002 + amount * 0.003);
}

function syncDelay() {
    if (!delayL) return;
    const time = Math.min(1.9, 0.75 * 60 / parseInt(document.getElementById('tempo').value));
    delayL.delayTime.setTargetAtTime(time, audioContext.currentTime, 0.08);
    delayR.delayTime.setTargetAtTime(time, audioContext.currentTime, 0.08);
}

// sliders glide instead of stepping, so dragging one doesn't zipper
function setParam(param, value) {
    param.setTargetAtTime(value, audioContext.currentTime, 0.02);
}

// the filter slider is 0–100 on a log scale, 100 Hz to 10 kHz, so the lows get as much travel as the highs
const filterHz = position => Math.round(100 * Math.pow(100, position / 100));
const filterPosition = hz => Math.round(100 * Math.log(Math.max(100, Math.min(10000, hz)) / 100) / Math.log(100));

// Distortion curve generator
function makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; i++) {
        const x = (i * 2) / n_samples - 1;
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

let micStream = null;
let micSource = null;
let micGain = null;
let isMicActive = false;
let micPending = false;

let loopSlots = {
    A: { loop: [], audioBuffer: null, history: [], duration: 0, loopSamples: 0, isPlaying: false, playback: null },
    B: { loop: [], audioBuffer: null, history: [], duration: 0, loopSamples: 0, isPlaying: false, playback: null },
    C: { loop: [], audioBuffer: null, history: [], duration: 0, loopSamples: 0, isPlaying: false, playback: null },
    D: { loop: [], audioBuffer: null, history: [], duration: 0, loopSamples: 0, isPlaying: false, playback: null }
};
let activeSlot = 'A';
let isRecording = false;
let recordingStart = 0;
let recordingSlot = 'A';
let isOverdub = false;
let overdubLength = 0;
let overdubStop = null;
let demoSlot = null;

let mediaStreamDestination;

// Drum steps are 0 off, 1 on, 2 accent; the keys row holds a MIDI note or null
let sequencerSteps = {
    kick: Array(16).fill(0),
    snare: Array(16).fill(0),
    hihat: Array(16).fill(0),
    clap: Array(16).fill(0),
    tom1: Array(16).fill(0),
    perc: Array(16).fill(0),
    cymbal: Array(16).fill(0),
    rim: Array(16).fill(0),
    keys: Array(16).fill(null)
};
// an accented step hits about 3 dB harder
const ACCENT = 1.4;
// the last note played on the keys, keyboard or MIDI: what a tap on the keys row writes
let lastNote = 60;
let currentStep = 0;
let isPlaying = false;
// 0–1: how far the off-beat 16ths lean back, up to half a step (an MPC's 75%)
let swing = 0;
let nextStepTime = 0;
let seqRun = 0;
let clockId = null;

// Undo/Redo history for sequencer
let sequencerHistory = [];
let sequencerHistoryIndex = -1;
const MAX_HISTORY = 50;

function saveSequencerState() {
    // Remove any future states if we're not at the end
    if (sequencerHistoryIndex < sequencerHistory.length - 1) {
        sequencerHistory = sequencerHistory.slice(0, sequencerHistoryIndex + 1);
    }

    // Deep copy current state
    const state = {};
    for (const drum in sequencerSteps) {
        state[drum] = [...sequencerSteps[drum]];
    }

    sequencerHistory.push(state);

    // Limit history size
    if (sequencerHistory.length > MAX_HISTORY) {
        sequencerHistory.shift();
    } else {
        sequencerHistoryIndex++;
    }
}

function undoSequencer() {
    if (sequencerHistoryIndex > 0) {
        sequencerHistoryIndex--;
        restoreSequencerState(sequencerHistory[sequencerHistoryIndex]);
        showMessage('undo');
    }
}

function redoSequencer() {
    if (sequencerHistoryIndex < sequencerHistory.length - 1) {
        sequencerHistoryIndex++;
        restoreSequencerState(sequencerHistory[sequencerHistoryIndex]);
        showMessage('redo');
    }
}

function restoreSequencerState(state) {
    for (const drum in state) {
        sequencerSteps[drum] = [...state[drum]];
    }
    updateSequencerUI();
    updatePatternCount();
}

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const noteName = midi => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
const midiFreq = midi => 440 * Math.pow(2, (midi - 69) / 12);
const freqMidi = freq => Math.round(69 + 12 * Math.log2(freq / 440));

function paintStep(el, value) {
    if (el.dataset.drum === 'keys') {
        el.classList.toggle('active', value !== null && value !== undefined);
        el.textContent = value === null || value === undefined ? '' : noteName(value);
        return;
    }
    el.classList.toggle('active', !!value);
    el.classList.toggle('accent', value === 2);
}

function updateSequencerUI() {
    document.querySelectorAll('.step').forEach(step => {
        paintStep(step, sequencerSteps[step.dataset.drum][parseInt(step.dataset.index)]);
    });
}

function clearPattern() {
    drums.forEach(drum => {
        sequencerSteps[drum] = Array(16).fill(0);
    });
    sequencerSteps.keys = Array(16).fill(null);
    updateSequencerUI();
}

const statusMessage = document.getElementById('statusMessage');
let messageTimeout = null;

function showMessage(msg, duration = 1000) {
    clearTimeout(messageTimeout);
    statusMessage.textContent = msg;
    messageTimeout = setTimeout(() => {
        statusMessage.textContent = '';
    }, duration);
}

// Initialize history with empty state
saveSequencerState();

let attackTime = SYNTH_DEFAULTS.ATTACK_MS;
let releaseTime = SYNTH_DEFAULTS.RELEASE_MS;

const canvas = document.getElementById('viz');
const ctx = canvas.getContext('2d');
canvas.width = canvas.offsetWidth;
canvas.height = canvas.offsetHeight;

const notes = {
    'C4': 261.63, 'C#4': 277.18, 'D4': 293.66, 'D#4': 311.13,
    'E4': 329.63, 'F4': 349.23, 'F#4': 369.99, 'G4': 392.00,
    'G#4': 415.30, 'A4': 440.00, 'A#4': 466.16, 'B4': 493.88,
    'C5': 523.25
};
const KEY_NOTES = Object.keys(notes);
const OCTAVE_MIN = -2;
const OCTAVE_MAX = 2;

// a key's note at the current octave
function keyFreq(name) {
    return 440 * Math.pow(2, (KEY_NOTES.indexOf(name) + 12 * octaveShift - 9) / 12);
}

// Vibe Matrix Animation
const vibeMatrix = document.getElementById('vibeMatrix');
const vibeCells = [];
for (let i = 0; i < 32; i++) {
    const cell = document.createElement('div');
    cell.className = 'vibe-cell';
    vibeMatrix.appendChild(cell);
    vibeCells.push(cell);
}
let vibeDataArray = null;

// ============================================
// HELPER FUNCTIONS
// ============================================
// ============================================
// LOOPER RECORDING
// ============================================
// The recorder worklet captures what goes into the limiter, uncompressed, from one exact frame to another.
// A take is a promise of an AudioBuffer exactly as long as asked
let recorder = null;
let takeCount = 0;
const takes = new Map();

function recordFrom(time) {
    if (!recorder) return null;
    const id = ++takeCount;
    const start = Math.round(time * audioContext.sampleRate);
    takes.set(id, { L: [], R: [], frames: 0, start, done: null });
    recorder.port.postMessage({ type: 'start', take: id, frame: start });
    return id;
}

// ends the take after exactly `frames` samples
function recordFor(id, frames) {
    const take = takes.get(id);
    if (!take) return Promise.resolve(null);
    recorder.port.postMessage({ type: 'stop', take: id, frame: take.start + frames });
    return new Promise(resolve => { take.done = resolve; });
}

function onRecorderMessage(e) {
    const d = e.data;
    const take = takes.get(d.take);
    if (d.type === 'chunk') {
        if (take) {
            take.L.push(d.L.slice(0, d.frames));
            take.R.push(d.R.slice(0, d.frames));
            take.frames += d.frames;
        }
        recorder.port.postMessage({ type: 'return', chunk: d }, [d.L.buffer, d.R.buffer]);
    } else if (d.type === 'end' && take) {
        takes.delete(d.take);
        if (d.lost) console.warn('looper: ' + d.lost + ' frames could not be kept');
        const buffer = audioContext.createBuffer(2, Math.max(1, take.frames), audioContext.sampleRate);
        [take.L, take.R].forEach((parts, ch) => {
            const data = buffer.getChannelData(ch);
            let offset = 0;
            parts.forEach(part => { data.set(part, offset); offset += part.length; });
        });
        if (take.done) take.done(take.frames ? buffer : null);
    }
}

// The layer joins the loop sample for sample; the loop repeats under it for as many whole cycles as the layer lasted
function addLayerTo(under, underLength, layer) {
    const length = layer.length;
    const out = audioContext.createBuffer(2, length, audioContext.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const target = out.getChannelData(ch);
        const top = layer.getChannelData(Math.min(ch, layer.numberOfChannels - 1));
        const below = under && underLength > 0 ? under.getChannelData(Math.min(ch, under.numberOfChannels - 1)) : null;
        for (let i = 0; i < length; i++) target[i] = top[i] + (below ? below[i % underLength] : 0);
    }
    return out;
}

// A slot remembers the takes it replaced, so the last layer can be taken back
const SLOT_HISTORY = 4;

function keepForUndo(slot) {
    if (!slot.audioBuffer) return;
    slot.history.push({ audioBuffer: slot.audioBuffer, loopSamples: slot.loopSamples });
    if (slot.history.length > SLOT_HISTORY) slot.history.shift();
}

function setSlotAudio(key, buffer, loopSamples) {
    const slot = loopSlots[key];
    keepForUndo(slot);
    slot.audioBuffer = buffer;
    slot.loopSamples = loopSamples;
    slot.duration = loopSamples / audioContext.sampleRate;
    if (slot.playback) swapSlotPlayback(key);
    updateSlotUI();
}

// 16-bit WAV of the loop, with the master's ceiling so peaks round off the way they did when heard
function slotWav(slot) {
    const length = slot.loopSamples || slot.audioBuffer.length;
    const rate = slot.audioBuffer.sampleRate;
    const bytes = new DataView(new ArrayBuffer(44 + length * 4));
    const text = (o, t) => { for (let i = 0; i < t.length; i++) bytes.setUint8(o + i, t.charCodeAt(i)); };
    text(0, 'RIFF'); bytes.setUint32(4, 36 + length * 4, true); text(8, 'WAVE');
    text(12, 'fmt '); bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 2, true);
    bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 4, true); bytes.setUint16(32, 4, true); bytes.setUint16(34, 16, true);
    text(36, 'data'); bytes.setUint32(40, length * 4, true);
    const knee = LIMITER.CEILING;
    const round = x => {
        const over = Math.abs(x) - knee;
        const y = over > 0 ? Math.sign(x) * (knee + (1 - knee) * Math.tanh(over / (1 - knee))) : x;
        return Math.max(-32768, Math.min(32767, Math.round(y * 32767)));
    };
    const L = slot.audioBuffer.getChannelData(0);
    const R = slot.audioBuffer.getChannelData(Math.min(1, slot.audioBuffer.numberOfChannels - 1));
    for (let i = 0; i < length; i++) {
        bytes.setInt16(44 + i * 4, round(L[i]), true);
        bytes.setInt16(46 + i * 4, round(R[i]), true);
    }
    return new Blob([bytes], { type: 'audio/wav' });
}

function addPressHandler(element, handler) {
    element.addEventListener('pointerdown', function(e) {
        if (e.button !== 0) return;
        handler.call(this, e);
    });
    element.addEventListener('touchstart', function(e) {
        e.preventDefault();
    }, { passive: false });
}

function animateVibeMatrix() {
    requestAnimationFrame(animateVibeMatrix);

    if (!isActive || !analyser) {
        for (let i = 0; i < 32; i++) {
            vibeCells[i].className = 'vibe-cell';
        }
        return;
    }

    if (!vibeDataArray) {
        vibeDataArray = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(vibeDataArray);

    const bandSize = Math.floor(vibeDataArray.length / 8);
    for (let col = 0; col < 8; col++) {
        let sum = 0;
        const start = col * bandSize;
        for (let i = start; i < start + bandSize; i++) {
            sum += vibeDataArray[i];
        }
        const level = Math.min(4, Math.floor((sum / bandSize) / 40));

        for (let row = 0; row < 4; row++) {
            const cellIndex = row * 8 + col;
            const rowFromBottom = 3 - row;

            if (rowFromBottom < level) {
                vibeCells[cellIndex].className = rowFromBottom === level - 1 ? 'vibe-cell lit' : 'vibe-cell dim';
            } else {
                vibeCells[cellIndex].className = 'vibe-cell';
            }
        }
    }
}

animateVibeMatrix();

function initSystem() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        masterGain = audioContext.createGain();
        masterGain.gain.value = AUDIO_CONSTANTS.MASTER_VOLUME;

        pitchBus = audioContext.createGain();
        pitchBend = audioContext.createConstantSource();
        pitchBend.offset.value = 0;
        pitchBend.connect(pitchBus);
        pitchBend.start();
        const vibrato = audioContext.createOscillator();
        vibrato.frequency.value = 5.5;
        vibratoDepth = audioContext.createGain();
        vibratoDepth.gain.value = 0;
        vibrato.connect(vibratoDepth);
        vibratoDepth.connect(pitchBus);
        vibrato.start();

        noiseLoop = audioContext.createBuffer(1, audioContext.sampleRate * 2, audioContext.sampleRate);
        const noiseData = noiseLoop.getChannelData(0);
        for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

        analyser = audioContext.createAnalyser();
        analyser.fftSize = AUDIO_CONSTANTS.ANALYSER_FFT_SIZE;
        
        // Delay: a dotted eighth at the tempo, left then right, each repeat darker than the one before.
        // The kick and the sub stay out of it, so the repeats don't muddy the low end
        const delayIn = audioContext.createGain();
        delayIn.channelCount = 1;
        delayIn.channelCountMode = 'explicit';
        const delayLowCut = audioContext.createBiquadFilter();
        delayLowCut.type = 'highpass';
        delayLowCut.frequency.value = 160;
        delayL = audioContext.createDelay(2);
        delayR = audioContext.createDelay(2);
        const delayCross = audioContext.createGain();
        delayCross.gain.value = 0.75;
        const delayTone = audioContext.createBiquadFilter();
        delayTone.type = 'lowpass';
        delayTone.frequency.value = 3200;
        const delayFeedback = audioContext.createGain();
        delayFeedback.gain.value = AUDIO_CONSTANTS.DELAY_FEEDBACK;
        const delaySides = audioContext.createChannelMerger(2);
        const delayMix = audioContext.createGain();
        delayMix.gain.value = 0;

        delayIn.connect(delayLowCut);
        delayLowCut.connect(delayL);
        delayL.connect(delaySides, 0, 0);
        delayL.connect(delayCross);
        delayCross.connect(delayR);
        delayR.connect(delaySides, 0, 1);
        delayR.connect(delayTone);
        delayTone.connect(delayFeedback);
        delayFeedback.connect(delayL);
        delaySides.connect(delayMix);
        syncDelay();

        // Reverb: a tail that darkens as it fades, 20 ms after the sound; the lows stay dry
        const reverbLowCut = audioContext.createBiquadFilter();
        reverbLowCut.type = 'highpass';
        reverbLowCut.frequency.value = 220;
        const reverbNode = audioContext.createConvolver();
        reverbNode.buffer = makeImpulse(audioContext, AUDIO_CONSTANTS.REVERB_TIME);
        const reverbMix = audioContext.createGain();
        reverbMix.gain.value = 0;
        reverbLowCut.connect(reverbNode);
        reverbNode.connect(reverbMix);
        
        const filterNode = audioContext.createBiquadFilter();
        filterNode.type = 'lowpass';
        filterNode.frequency.value = AUDIO_CONSTANTS.DEFAULT_FILTER_FREQ;
        filterNode.Q.value = 1;
        
        const limiter = audioContext.createDynamicsCompressor();
        limiter.threshold.value = LIMITER.THRESHOLD;
        limiter.knee.value = LIMITER.KNEE;
        limiter.ratio.value = LIMITER.RATIO;
        limiter.attack.value = LIMITER.ATTACK;
        limiter.release.value = LIMITER.RELEASE;

        // The compressor adds makeup gain (0.6 power of its full-range gain); the trim takes it back so everything under the threshold passes at unity and loops don't grow on every layer
        const limiterTrim = audioContext.createGain();
        limiterTrim.gain.value = Math.pow(10, 0.6 * LIMITER.THRESHOLD * (1 - 1 / LIMITER.RATIO) / 20);

        // A dense hit still gets past the 2 ms attack; the ceiling rounds only that overshoot so output and recordings stay under 1
        const ceiling = audioContext.createWaveShaper();
        ceiling.curve = createCeilingCurve(LIMITER.CEILING);

        // Distortion, crush and chorus sit in series, each a crossfade from dry to processed, so turning one up
        // changes the sound instead of piling a copy on top of it. Delay and reverb take what comes out of them
        const insertDistortion = makeInsert();
        const insertCrush = makeInsert();
        const insertChorus = makeInsert();
        masterGain.connect(insertDistortion.input);
        insertDistortion.output.connect(insertCrush.input);
        insertCrush.output.connect(insertChorus.input);
        const fxOut = insertChorus.output;

        fxOut.connect(delayIn);
        fxOut.connect(reverbLowCut);
        fxOut.connect(filterNode);
        delayMix.connect(filterNode);
        reverbMix.connect(filterNode);
        filterNode.connect(limiter);
        limiter.connect(limiterTrim);
        limiterTrim.connect(ceiling);
        ceiling.connect(analyser);
        analyser.connect(audioContext.destination);

        // Loops are recorded before the limiter and play back into it, so they meet everything else there once
        loopBus = audioContext.createGain();
        loopBus.connect(limiter);

        const distortionNode = audioContext.createWaveShaper();
        distortionNode.curve = makeDistortionCurve(0);
        distortionNode.oversample = '4x';
        insertDistortion.input.connect(distortionNode);
        distortionNode.connect(insertDistortion.wet);

        // Bitcrusher - try AudioWorklet first, fallback to ScriptProcessor; until it's ready the insert stays dry
        let crushAmount = 0;
        let bitcrusherNode;

        async function setupBitcrusher() {
            if (audioContext.audioWorklet) {
                try {
                    await audioContext.audioWorklet.addModule('bitcrusher-processor.js');
                    bitcrusherNode = new AudioWorkletNode(audioContext, 'bitcrusher-processor', { outputChannelCount: [2] });

                    window.setCrushAmount = (val) => {
                        crushAmount = val;
                        bitcrusherNode.port.postMessage({ crushAmount: val });
                    };

                    insertCrush.input.connect(bitcrusherNode);
                    bitcrusherNode.connect(insertCrush.wet);
                    return;
                } catch (e) {
                    console.warn('AudioWorklet failed, falling back to ScriptProcessor:', e);
                }
            }

            bitcrusherNode = audioContext.createScriptProcessor(4096, 1, 1);
            let crushPhase = 0;
            let crushHeld = 0;
            bitcrusherNode.onaudioprocess = function(e) {
                const input = e.inputBuffer.getChannelData(0);
                const output = e.outputBuffer.getChannelData(0);
                if (crushAmount === 0) {
                    output.set(input);
                    return;
                }
                const step = Math.pow(0.5, 16 - 1.5 * crushAmount);
                const rate = 1 / (1 + 0.6 * Math.pow(crushAmount, 1.5));
                for (let i = 0; i < input.length; i++) {
                    crushPhase += rate;
                    if (crushPhase >= 1) {
                        crushPhase -= 1;
                        crushHeld = Math.round(input[i] / step) * step;
                    }
                    output[i] = crushHeld;
                }
            };

            window.setCrushAmount = (val) => { crushAmount = val; };

            insertCrush.input.connect(bitcrusherNode);
            bitcrusherNode.connect(insertCrush.wet);
        }

        const bitcrusherReady = setupBitcrusher();

        // Karplus-Strong worklet registration
        window.karplusStrongReady = false;
        const karplusReady = audioContext.audioWorklet
            ? audioContext.audioWorklet.addModule('karplus-strong-processor.js').then(() => {
                window.karplusStrongReady = true;
            }).catch(() => {})
            : Promise.resolve();

        // Drum engine worklet registration: stereo, each voice in its own place
        window.drumEngineReady = false;
        const drumEngineLoaded = (async () => {
            if (!audioContext.audioWorklet) return;
            try {
                await audioContext.audioWorklet.addModule('drum-engine-processor.js');
                const drumEngine = new AudioWorkletNode(audioContext, 'drum-engine-processor', { outputChannelCount: [2] });
                drumEngine.connect(masterGain);
                window.drumEngine = drumEngine;
                window.drumEngineReady = true;
                Object.keys(padSettings).forEach(sendPad);
            } catch(e) {
                console.warn('Drum engine worklet failed, using fallback:', e);
                window.drumEngineReady = false;
            }
        })();

        // The looper's recorder listens before the limiter; without AudioWorklet loops keep only their events
        const recorderLoaded = (async () => {
            if (!audioContext.audioWorklet) return;
            try {
                await audioContext.audioWorklet.addModule('recorder-processor.js');
                recorder = new AudioWorkletNode(audioContext, 'recorder-processor', { numberOfOutputs: 0 });
                recorder.port.onmessage = onRecorderMessage;
                filterNode.connect(recorder);
            } catch (e) {
                console.warn('Recorder worklet failed, loops keep their events only:', e);
                recorder = null;
            }
        })();

        audioReady = Promise.all([bitcrusherReady, karplusReady, drumEngineLoaded, recorderLoaded]).then(() => {
            audioLoaded = true;
            applySliders();
        });

        // Chorus: two delay lines swept in opposite directions, one on each side
        const chorusDelayL = audioContext.createDelay(0.1);
        const chorusDelayR = audioContext.createDelay(0.1);
        chorusDelayL.delayTime.value = 0.025;
        chorusDelayR.delayTime.value = 0.032;
        const chorusLFO = audioContext.createOscillator();
        const chorusLFOGain = audioContext.createGain();
        const chorusInvert = audioContext.createGain();
        const chorusSides = audioContext.createChannelMerger(2);
        chorusLFO.type = 'sine';
        chorusLFO.frequency.value = 1.5;
        chorusLFOGain.gain.value = 0.002;
        chorusInvert.gain.value = -1;
        chorusLFO.connect(chorusLFOGain);
        chorusLFOGain.connect(chorusDelayL.delayTime);
        chorusLFOGain.connect(chorusInvert);
        chorusInvert.connect(chorusDelayR.delayTime);
        chorusLFO.start();
        insertChorus.input.connect(chorusDelayL);
        insertChorus.input.connect(chorusDelayR);
        chorusDelayL.connect(chorusSides, 0, 0);
        chorusDelayR.connect(chorusSides, 0, 1);
        chorusSides.connect(insertChorus.wet);

        window.delayMix = delayMix;
        window.reverbMix = reverbMix;
        window.filterNode = filterNode;
        window.distortionNode = distortionNode;
        window.distortionMix = insertDistortion.wet;
        window.distortionDry = insertDistortion.dry;
        window.bitcrusherMix = insertCrush.wet;
        window.bitcrusherDry = insertCrush.dry;
        window.chorusMix = insertChorus.wet;
        window.chorusDry = insertChorus.dry;
        window.chorusLFOGain = chorusLFOGain;

        mediaStreamDestination = audioContext.createMediaStreamDestination();
        analyser.connect(mediaStreamDestination);
        
        isActive = true;
        document.getElementById('sysStatus').textContent = 'active';

        // Initialize voice management
        initSharedCurves();
        startVoiceCleanup();

        applySliders();

        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        if (navigator.requestMIDIAccess) {
            navigator.requestMIDIAccess({ sysex: false })
                .then(onMIDISuccess)
                .catch(onMIDIFailure);
        }

        drawViz();
    } else if (audioContext.state === 'suspended') {
        audioContext.resume();
        isActive = true;
        document.getElementById('sysStatus').textContent = 'active';
    }

    return audioReady;
}

function applySliders() {
    document.querySelectorAll('input[type="range"]').forEach(input => {
        input.dispatchEvent(new Event('input'));
    });
}

async function toggleMic() {
    initSystem();
    if (micPending) return;

    if (!isMicActive) {
        micPending = true;
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                } 
            });
            
            micSource = audioContext.createMediaStreamSource(micStream);
            micGain = audioContext.createGain();
            micGain.gain.value = 1.0;
            micSource.connect(micGain);
            micGain.connect(masterGain);
            
            isMicActive = true;
            document.getElementById('micBtn').classList.add('active');
            document.getElementById('micIndicator').classList.add('active');

            showMessage('mic on', 2000);

        } catch (error) {
            console.warn('Microphone access denied:', error);
            showMessage(error.name === 'NotFoundError' ? 'no mic found' : 'mic blocked · allow it in the browser', 4000);
        }
        micPending = false;
    } else {
        if (micSource) {
            micSource.disconnect();
            micSource = null;
        }
        if (micGain) {
            micGain.disconnect();
            micGain = null;
        }
        if (micStream) {
            micStream.getTracks().forEach(track => track.stop());
            micStream = null;
        }
        
        isMicActive = false;
        document.getElementById('micBtn').classList.remove('active');
        document.getElementById('micIndicator').classList.remove('active');

        showMessage('mic off', 2000);
    }
}

function flash(el, time, ms) {
    if (!el) return;
    const on = () => {
        el.classList.add('active');
        setTimeout(() => el.classList.remove('active'), ms);
    };
    const delay = (time - audioContext.currentTime) * 1000;
    if (delay > 5) {
        setTimeout(on, delay);
    } else {
        on();
    }
}

function atTime(time, fn) {
    const delay = (time - audioContext.currentTime) * 1000;
    if (delay > 5) setTimeout(fn, delay);
    else fn();
}

// The key on screen for a frequency at the current octave; notes outside the 13 keys light nothing
function keyFor(freq) {
    const index = Math.round(69 + 12 * Math.log2(freq / 440)) - 60 - 12 * octaveShift;
    const name = KEY_NOTES[index];
    return name ? document.querySelector(`.key[data-note="${name}"]`) : null;
}

// A key stays lit while any of its notes is held
function lightKey(el, time) {
    atTime(time, () => {
        el._held = (el._held || 0) + 1;
        el.classList.add('active');
    });
}

function unflash(el, time) {
    atTime(time, () => {
        el._held = Math.max(0, (el._held || 0) - 1);
        if (!el._held) el.classList.remove('active');
    });
}

// where each drum sits, as in drum-engine-processor.js: kick and snare in the middle, the kit spread around them
const DRUM_PAN = { kick: 0, snare: 0, hihat: 0.35, clap: -0.15, tom1: -0.3, perc: -0.4, cymbal: 0.25, rim: 0.2 };

// how loud a hit is for its velocity; the curve keeps soft hits audible
function drumLevel(velocity) {
    return 0.15 + 0.85 * Math.pow(velocity, 1.4);
}

// velocity 0–1 (1 when it isn't known: pads, keys, the pattern); variant 'open' lets the hat ring
function playDrum(type, skipRecording = false, time, velocity = 1, variant) {
    if (!audioLoaded) {
        initSystem().then(() => playDrum(type, skipRecording, time, velocity, variant));
        return;
    }

    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    const now = Math.max(time || 0, audioContext.currentTime);
    flash(document.querySelector(`[data-sound="${type}"]`), now, 150);

    if (!skipRecording && (isRecording || isOverdub)) {
        loopSlots[recordingSlot].loop.push({
            type: 'drum',
            sound: type,
            velocity,
            variant,
            time: now - recordingStart
        });
    }

    if (window.drumEngineReady && window.drumEngine) {
        window.drumEngine.port.postMessage({ type: 'trigger', voice: type, time: now, velocity, open: variant === 'open' });
        return;
    }

    const hitGain = audioContext.createGain();
    hitGain.gain.value = drumLevel(velocity);
    const hitPan = audioContext.createStereoPanner();
    hitPan.pan.value = DRUM_PAN[type] || 0;
    hitGain.connect(hitPan);
    hitPan.connect(masterGain);

    const nodes = [hitGain, hitPan]; // Track all nodes for cleanup
    const curves = initSharedCurves(); // Use shared curves
    let maxDuration = 0.5; // Default duration

    switch(type) {
        case 'kick': {
            maxDuration = 0.6;

            // Transient click
            const clickOsc = audioContext.createOscillator();
            const clickGain = audioContext.createGain();
            const clickDist = audioContext.createWaveShaper();
            clickOsc.type = 'triangle';
            clickOsc.frequency.setValueAtTime(4500, now);
            clickOsc.frequency.exponentialRampToValueAtTime(150, now + 0.008);
            clickDist.curve = curves.hardClip;
            clickGain.gain.setValueAtTime(0.9, now);
            clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
            clickOsc.connect(clickDist);
            clickDist.connect(clickGain);
            clickGain.connect(hitGain);
            clickOsc.start(now);
            clickOsc.stop(now + 0.015);
            nodes.push(clickOsc, clickGain, clickDist);

            // Body layer
            const bodyOsc = audioContext.createOscillator();
            const bodyGain = audioContext.createGain();
            const bodyDist = audioContext.createWaveShaper();
            bodyOsc.type = 'sine';
            bodyOsc.frequency.setValueAtTime(160, now);
            bodyOsc.frequency.exponentialRampToValueAtTime(55, now + 0.035);
            bodyOsc.frequency.exponentialRampToValueAtTime(40, now + 0.15);
            bodyDist.curve = curves.tanh25;
            bodyGain.gain.setValueAtTime(1.4, now);
            bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
            bodyOsc.connect(bodyDist);
            bodyDist.connect(bodyGain);
            bodyGain.connect(hitGain);
            bodyOsc.start(now);
            bodyOsc.stop(now + 0.45);
            nodes.push(bodyOsc, bodyGain, bodyDist);

            // Sub layer
            const subOsc = audioContext.createOscillator();
            const subGain = audioContext.createGain();
            const subFilter = audioContext.createBiquadFilter();
            subOsc.type = 'sine';
            subOsc.frequency.setValueAtTime(55, now);
            subOsc.frequency.exponentialRampToValueAtTime(35, now + 0.25);
            subFilter.type = 'lowpass';
            subFilter.frequency.value = 60;
            subGain.gain.setValueAtTime(1.0, now);
            subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
            subOsc.connect(subFilter);
            subFilter.connect(subGain);
            subGain.connect(hitGain);
            subOsc.start(now);
            subOsc.stop(now + 0.55);
            nodes.push(subOsc, subGain, subFilter);
            break;
        }

        case 'snare': {
            maxDuration = 0.2;

            // Transient crack
            const crackOsc = audioContext.createOscillator();
            const crackGain = audioContext.createGain();
            const crackDist = audioContext.createWaveShaper();
            crackOsc.type = 'triangle';
            crackOsc.frequency.setValueAtTime(1200, now);
            crackOsc.frequency.exponentialRampToValueAtTime(300, now + 0.003);
            crackDist.curve = curves.tanh40;
            crackGain.gain.setValueAtTime(0.7, now);
            crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.012);
            crackOsc.connect(crackDist);
            crackDist.connect(crackGain);
            crackGain.connect(hitGain);
            crackOsc.start(now);
            crackOsc.stop(now + 0.012);
            nodes.push(crackOsc, crackGain, crackDist);

            // Body
            const bodyOsc = audioContext.createOscillator();
            const bodyOsc2 = audioContext.createOscillator();
            const bodyGain = audioContext.createGain();
            const bodyFilter = audioContext.createBiquadFilter();
            bodyOsc.type = 'triangle';
            bodyOsc.frequency.setValueAtTime(240, now);
            bodyOsc.frequency.exponentialRampToValueAtTime(150, now + 0.025);
            bodyOsc2.type = 'sine';
            bodyOsc2.frequency.setValueAtTime(185, now);
            bodyOsc2.frequency.exponentialRampToValueAtTime(110, now + 0.04);
            bodyFilter.type = 'peaking';
            bodyFilter.frequency.value = 220;
            bodyFilter.Q.value = 3;
            bodyFilter.gain.value = 6;
            bodyGain.gain.setValueAtTime(0.65, now);
            bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
            bodyOsc.connect(bodyFilter);
            bodyOsc2.connect(bodyFilter);
            bodyFilter.connect(bodyGain);
            bodyGain.connect(hitGain);
            bodyOsc.start(now);
            bodyOsc2.start(now);
            bodyOsc.stop(now + 0.12);
            bodyOsc2.stop(now + 0.12);
            nodes.push(bodyOsc, bodyOsc2, bodyGain, bodyFilter);

            // Noise
            const noiseLen = 0.15;
            const noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * noiseLen, audioContext.sampleRate);
            const noiseData = noiseBuffer.getChannelData(0);
            for (let i = 0; i < noiseBuffer.length; i++) noiseData[i] = Math.random() * 2 - 1;
            const noise = audioContext.createBufferSource();
            noise.buffer = noiseBuffer;
            const noiseHP = audioContext.createBiquadFilter();
            noiseHP.type = 'highpass';
            noiseHP.frequency.value = 2500;
            const noiseLP = audioContext.createBiquadFilter();
            noiseLP.type = 'lowpass';
            noiseLP.frequency.setValueAtTime(12000, now);
            noiseLP.frequency.exponentialRampToValueAtTime(5000, now + 0.08);
            const noiseGain = audioContext.createGain();
            noiseGain.gain.setValueAtTime(1.0, now);
            noiseGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen);
            noise.connect(noiseHP);
            noiseHP.connect(noiseLP);
            noiseLP.connect(noiseGain);
            noiseGain.connect(hitGain);
            noise.start(now);
            nodes.push(noise, noiseHP, noiseLP, noiseGain);
            break;
        }

        case 'hihat': {
            maxDuration = 0.1;

            const fundamentals = [298, 366, 441, 528, 634, 748, 891, 1103];
            const metalGain = audioContext.createGain();
            const metalHP = audioContext.createBiquadFilter();
            metalHP.type = 'highpass';
            metalHP.frequency.value = 6000;
            metalGain.gain.setValueAtTime(0.18, now);
            metalGain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

            fundamentals.forEach((freq, i) => {
                const osc = audioContext.createOscillator();
                osc.type = 'square';
                osc.frequency.value = freq * (1 + Math.random() * 0.025);
                const oscGain = audioContext.createGain();
                oscGain.gain.value = 1 / (i + 1) * 0.6;
                osc.connect(oscGain);
                oscGain.connect(metalHP);
                osc.start(now);
                osc.stop(now + 0.055);
                nodes.push(osc, oscGain);
            });

            metalHP.connect(metalGain);
            metalGain.connect(hitGain);
            nodes.push(metalHP, metalGain);

            // Noise sizzle
            const noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.06, audioContext.sampleRate);
            const noiseData = noiseBuffer.getChannelData(0);
            for (let i = 0; i < noiseBuffer.length; i++) noiseData[i] = Math.random() * 2 - 1;
            const noise = audioContext.createBufferSource();
            noise.buffer = noiseBuffer;
            const noiseHP = audioContext.createBiquadFilter();
            noiseHP.type = 'highpass';
            noiseHP.frequency.value = 9000;
            const noiseGain = audioContext.createGain();
            noiseGain.gain.setValueAtTime(0.3, now);
            noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
            noise.connect(noiseHP);
            noiseHP.connect(noiseGain);
            noiseGain.connect(hitGain);
            noise.start(now);
            nodes.push(noise, noiseHP, noiseGain);
            break;
        }

        case 'clap': {
            maxDuration = 0.25;
            const burstCount = 4;
            const spacing = 0.012;

            for (let i = 0; i < burstCount; i++) {
                const delay = i * spacing + Math.random() * 0.005;
                const burstBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.03, audioContext.sampleRate);
                const burstData = burstBuffer.getChannelData(0);
                for (let j = 0; j < burstBuffer.length; j++) burstData[j] = Math.random() * 2 - 1;
                const burst = audioContext.createBufferSource();
                burst.buffer = burstBuffer;
                const burstBP = audioContext.createBiquadFilter();
                burstBP.type = 'bandpass';
                burstBP.frequency.value = 1200 + Math.random() * 400;
                burstBP.Q.value = 2;
                const burstGain = audioContext.createGain();
                burstGain.gain.setValueAtTime(i === burstCount - 1 ? 0.7 : 0.4, now + delay);
                burstGain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.08);
                burst.connect(burstBP);
                burstBP.connect(burstGain);
                burstGain.connect(hitGain);
                burst.start(now + delay);
                nodes.push(burst, burstBP, burstGain);
            }

            // Tail
            const tailBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.15, audioContext.sampleRate);
            const tailData = tailBuffer.getChannelData(0);
            for (let i = 0; i < tailBuffer.length; i++) tailData[i] = Math.random() * 2 - 1;
            const tail = audioContext.createBufferSource();
            tail.buffer = tailBuffer;
            const tailBP = audioContext.createBiquadFilter();
            tailBP.type = 'bandpass';
            tailBP.frequency.value = 1000;
            const tailGain = audioContext.createGain();
            tailGain.gain.setValueAtTime(0.3, now + 0.04);
            tailGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
            tail.connect(tailBP);
            tailBP.connect(tailGain);
            tailGain.connect(hitGain);
            tail.start(now + 0.04);
            nodes.push(tail, tailBP, tailGain);
            break;
        }

        case 'tom1': {
            maxDuration = 0.45;

            const bodyOsc = audioContext.createOscillator();
            const bodyGain = audioContext.createGain();
            const bodyFilter = audioContext.createBiquadFilter();
            bodyOsc.type = 'sine';
            bodyOsc.frequency.setValueAtTime(280, now);
            bodyOsc.frequency.exponentialRampToValueAtTime(110, now + 0.3);
            bodyFilter.type = 'lowpass';
            bodyFilter.frequency.value = 600;
            bodyGain.gain.setValueAtTime(1.0, now);
            bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
            bodyOsc.connect(bodyFilter);
            bodyFilter.connect(bodyGain);
            bodyGain.connect(hitGain);
            bodyOsc.start(now);
            bodyOsc.stop(now + 0.4);
            nodes.push(bodyOsc, bodyGain, bodyFilter);

            const overOsc = audioContext.createOscillator();
            const overGain = audioContext.createGain();
            overOsc.type = 'triangle';
            overOsc.frequency.setValueAtTime(560, now);
            overOsc.frequency.exponentialRampToValueAtTime(220, now + 0.05);
            overGain.gain.setValueAtTime(0.3, now);
            overGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
            overOsc.connect(overGain);
            overGain.connect(hitGain);
            overOsc.start(now);
            overOsc.stop(now + 0.1);
            nodes.push(overOsc, overGain);

            const clickBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.01, audioContext.sampleRate);
            const clickData = clickBuffer.getChannelData(0);
            for (let i = 0; i < clickBuffer.length; i++) clickData[i] = Math.random() * 2 - 1;
            const clickNoise = audioContext.createBufferSource();
            clickNoise.buffer = clickBuffer;
            const clickGain = audioContext.createGain();
            clickGain.gain.setValueAtTime(0.25, now);
            clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
            clickNoise.connect(clickGain);
            clickGain.connect(hitGain);
            clickNoise.start(now);
            nodes.push(clickNoise, clickGain);
            break;
        }

        case 'perc': {
            maxDuration = 0.15;

            const carrier = audioContext.createOscillator();
            const modulator = audioContext.createOscillator();
            const modGain = audioContext.createGain();
            const outputGain = audioContext.createGain();
            const filter = audioContext.createBiquadFilter();
            carrier.type = 'sine';
            carrier.frequency.value = 1800;
            modulator.type = 'sine';
            modulator.frequency.value = 2400;
            modGain.gain.setValueAtTime(800, now);
            modGain.gain.exponentialRampToValueAtTime(10, now + 0.1);
            filter.type = 'bandpass';
            filter.frequency.value = 2000;
            filter.Q.value = 3;
            outputGain.gain.setValueAtTime(0.4, now);
            outputGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
            modulator.connect(modGain);
            modGain.connect(carrier.frequency);
            carrier.connect(filter);
            filter.connect(outputGain);
            outputGain.connect(hitGain);
            carrier.start(now);
            modulator.start(now);
            carrier.stop(now + 0.1);
            modulator.stop(now + 0.1);
            nodes.push(carrier, modulator, modGain, outputGain, filter);
            break;
        }

        case 'cymbal': {
            maxDuration = 1.1;

            const partials = [205, 295, 375, 505, 625, 835, 1015, 1205, 1555, 2015];
            const metalGain = audioContext.createGain();
            const metalHP = audioContext.createBiquadFilter();
            metalHP.type = 'highpass';
            metalHP.frequency.value = 4000;
            metalGain.gain.setValueAtTime(0.12, now);
            metalGain.gain.exponentialRampToValueAtTime(0.001, now + 1.0);

            partials.forEach(freq => {
                const osc = audioContext.createOscillator();
                osc.type = 'square';
                osc.frequency.value = freq * (1 + Math.random() * 0.03);
                osc.connect(metalHP);
                osc.start(now);
                osc.stop(now + 1.0);
                nodes.push(osc);
            });

            metalHP.connect(metalGain);
            metalGain.connect(hitGain);
            nodes.push(metalHP, metalGain);

            const noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.8, audioContext.sampleRate);
            const noiseData = noiseBuffer.getChannelData(0);
            for (let i = 0; i < noiseBuffer.length; i++) noiseData[i] = Math.random() * 2 - 1;
            const noise = audioContext.createBufferSource();
            noise.buffer = noiseBuffer;
            const noiseHP = audioContext.createBiquadFilter();
            noiseHP.type = 'highpass';
            noiseHP.frequency.value = 9000;
            const noiseGain = audioContext.createGain();
            noiseGain.gain.setValueAtTime(0.2, now);
            noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
            noise.connect(noiseHP);
            noiseHP.connect(noiseGain);
            noiseGain.connect(hitGain);
            noise.start(now);
            nodes.push(noise, noiseHP, noiseGain);
            break;
        }

        case 'rim': {
            maxDuration = 0.1;

            const clickOsc = audioContext.createOscillator();
            const clickGain = audioContext.createGain();
            const clickHP = audioContext.createBiquadFilter();
            clickOsc.type = 'square';
            clickOsc.frequency.setValueAtTime(1800, now);
            clickOsc.frequency.exponentialRampToValueAtTime(800, now + 0.005);
            clickHP.type = 'highpass';
            clickHP.frequency.value = 1500;
            clickGain.gain.setValueAtTime(0.5, now);
            clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
            clickOsc.connect(clickHP);
            clickHP.connect(clickGain);
            clickGain.connect(hitGain);
            clickOsc.start(now);
            clickOsc.stop(now + 0.025);
            nodes.push(clickOsc, clickGain, clickHP);

            const bodyOsc = audioContext.createOscillator();
            const bodyGain = audioContext.createGain();
            const bodyBP = audioContext.createBiquadFilter();
            bodyOsc.type = 'triangle';
            bodyOsc.frequency.setValueAtTime(400, now);
            bodyOsc.frequency.exponentialRampToValueAtTime(200, now + 0.01);
            bodyBP.type = 'bandpass';
            bodyBP.frequency.value = 350;
            bodyBP.Q.value = 8;
            bodyGain.gain.setValueAtTime(0.4, now);
            bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
            bodyOsc.connect(bodyBP);
            bodyBP.connect(bodyGain);
            bodyGain.connect(hitGain);
            bodyOsc.start(now);
            bodyOsc.stop(now + 0.05);
            nodes.push(bodyOsc, bodyGain, bodyBP);
            break;
        }
    }

    // Register voice for cleanup
    if (nodes.length > 0) {
        registerDrumVoice(nodes, now - audioContext.currentTime + maxDuration);
    }
}

// A note sounds from opts.time for as long as it's held: keys, the pointer and MIDI call voice.release();
// loops and the API pass opts.hold in seconds. velocity 0–1 moves level and brightness together
function playNote(freq, opts = {}) {
    if (!audioContext) {
        initSystem();
    }

    const wave = opts.wave || document.getElementById('waveType').dataset.value;
    const skipRecording = !!opts.skipRecording;

    // string needs its worklet; a release that lands before it loads still ends the note
    if (wave === 'string' && !audioLoaded) {
        const pending = { released: false, release() { pending.released = true; } };
        audioReady.then(() => {
            const voice = playNote(freq, opts);
            if (voice && pending.released) voice.release();
        });
        return pending;
    }

    // The vocoder has nothing to shape without the mic; a played note asks for it, a loop or the API stays silent
    if (wave === 'vocoder' && !micSource) {
        if (!skipRecording) {
            toggleMic();
            const micBtn = document.getElementById('micBtn');
            micBtn.classList.add('blink');
            setTimeout(() => micBtn.classList.remove('blink'), 1500);
        }
        return null;
    }

    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    const now = Math.max(opts.time || 0, audioContext.currentTime);
    const velocity = opts.velocity === undefined ? 1 : Math.max(0, Math.min(1, opts.velocity));
    const hold = opts.hold === undefined ? Infinity : Math.max(0, opts.hold);

    const keyEl = keyFor(freq);
    if (keyEl) lightKey(keyEl, now);

    const attack = attackTime / 1000;
    const release = Math.max(releaseTime / 1000, 0.05);
    // a plucked string rings on after the key lets go
    const ring = wave === 'string' ? Math.max(release, 1.5) : release;
    const level = 0.3 + 0.7 * velocity;
    const curves = initSharedCurves();
    const voice = { nodes: [], sources: [], links: [], animationIds: [], released: false, start: now, endTime: Infinity };
    const nodes = voice.nodes;
    const sources = voice.sources;

    const bend = osc => {
        pitchBus.connect(osc.detune);
        voice.links.push([pitchBus, osc.detune]);
    };

    const outputGain = audioContext.createGain();
    outputGain.gain.setValueAtTime(0, now);
    outputGain.gain.linearRampToValueAtTime(0.28 * level, now + attack);
    outputGain.gain.setTargetAtTime(0.2 * level, now + attack, 0.06);
    nodes.push(outputGain);

    // Opens with the attack, harder notes open further, and settles while the note is held
    const filter = audioContext.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2;
    const filterBase = Math.min(freq * 1.5, 800);
    const filterTop = Math.min(freq * 8, 12000);
    const filterPeak = filterBase + (filterTop - filterBase) * (0.35 + 0.65 * velocity);
    filter.frequency.setValueAtTime(filterBase, now);
    filter.frequency.linearRampToValueAtTime(filterPeak, now + attack * 0.8 + 0.001);
    filter.frequency.setTargetAtTime(filterBase + (filterPeak - filterBase) * 0.35, now + attack * 0.8 + 0.001, 0.25);
    nodes.push(filter);

    const saturator = audioContext.createWaveShaper();
    saturator.curve = curves.tanh18;
    saturator.connect(filter);
    filter.connect(outputGain);
    outputGain.connect(masterGain);
    nodes.push(saturator);

    let stringNode = null;
    let stringGain = null;

    if (wave === 'noise') {
        const noiseSource = audioContext.createBufferSource();
        noiseSource.buffer = noiseLoop;
        noiseSource.loop = true;
        const noiseFilter = audioContext.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.Q.value = 15;
        noiseFilter.frequency.setValueAtTime(freq * 2, now);
        noiseFilter.frequency.exponentialRampToValueAtTime(freq, now + 0.1);
        noiseSource.connect(noiseFilter);
        noiseFilter.connect(saturator);
        noiseSource.start(now, Math.random() * (noiseLoop.duration - 0.1));
        sources.push(noiseSource);
        nodes.push(noiseSource, noiseFilter);

    } else if (wave === 'pulse') {
        const osc1 = audioContext.createOscillator();
        const osc2 = audioContext.createOscillator();
        const pulseGain = audioContext.createGain();
        osc1.type = 'sawtooth';
        osc2.type = 'sawtooth';
        osc1.frequency.setValueAtTime(freq, now);
        osc2.frequency.setValueAtTime(freq, now);
        osc1.detune.setValueAtTime(3, now);
        osc2.detune.setValueAtTime(-3, now);
        pulseGain.gain.value = -0.9;
        osc1.connect(saturator);
        osc2.connect(pulseGain);
        pulseGain.connect(saturator);
        const subOsc = audioContext.createOscillator();
        const subGain = audioContext.createGain();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(freq / 2, now);
        subGain.gain.value = 0.3;
        subOsc.connect(subGain);
        subGain.connect(saturator);
        [osc1, osc2, subOsc].forEach(bend);
        osc1.start(now);
        osc2.start(now);
        subOsc.start(now);
        sources.push(osc1, osc2, subOsc);
        nodes.push(osc1, osc2, pulseGain, subOsc, subGain);

    } else if (wave === 'string') {
        const bodyFilter = audioContext.createBiquadFilter();
        bodyFilter.type = 'peaking';
        bodyFilter.frequency.setValueAtTime(freq * 2, now);
        bodyFilter.Q.value = 1;
        bodyFilter.gain.value = 3;
        stringGain = audioContext.createGain();
        stringGain.gain.setValueAtTime(0.6, now);

        if (window.karplusStrongReady) {
            stringNode = new AudioWorkletNode(audioContext, 'karplus-strong-processor', {
                processorOptions: { frequency: freq, startAt: now }
            });
            stringNode.connect(bodyFilter);
            nodes.push(stringNode);
        } else {
            // Without AudioWorklet: a pre-computed pluck, long enough for a held note to ring out
            const sampleRate = audioContext.sampleRate;
            const period = Math.round(sampleRate / freq);
            const bufferSize = Math.ceil(sampleRate * 4);
            const buffer = audioContext.createBuffer(1, bufferSize, sampleRate);
            const data = buffer.getChannelData(0);
            const delayLine = new Float32Array(period);
            for (let i = 0; i < period; i++) delayLine[i] = (Math.random() * 2 - 1) * 0.8;
            let readIndex = 0;
            for (let i = 0; i < bufferSize; i++) {
                data[i] = delayLine[readIndex];
                const nextIndex = (readIndex + 1) % period;
                delayLine[readIndex] = (0.5 * delayLine[readIndex] + 0.5 * delayLine[nextIndex]) * 0.996;
                readIndex = nextIndex;
            }
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(bodyFilter);
            source.start(now);
            sources.push(source);
            nodes.push(source);
        }
        bodyFilter.connect(stringGain);
        stringGain.connect(saturator);
        nodes.push(bodyFilter, stringGain);

    } else if (wave === 'formant') {
        const vowels = { a: [800, 1200, 2500], e: [400, 2200, 2800], i: [300, 2300, 3000], o: [500, 900, 2500], u: [350, 700, 2500] };
        const vowelKeys = Object.keys(vowels);
        const currentVowel = vowels[vowelKeys[Math.floor((freq % 500) / 100) % vowelKeys.length]];
        const source = audioContext.createOscillator();
        source.type = 'sawtooth';
        source.frequency.setValueAtTime(freq, now);
        const source2 = audioContext.createOscillator();
        source2.type = 'sawtooth';
        source2.frequency.setValueAtTime(freq, now);
        source2.detune.setValueAtTime(5, now);
        const sourceMix = audioContext.createGain();
        sourceMix.gain.value = 0.5;
        source.connect(sourceMix);
        source2.connect(sourceMix);
        const formantMix = audioContext.createGain();
        formantMix.gain.value = 0.4;
        nodes.push(source, source2, sourceMix, formantMix);
        currentVowel.forEach((formantFreq, i) => {
            const filt = audioContext.createBiquadFilter();
            filt.type = 'bandpass';
            filt.frequency.value = formantFreq;
            filt.Q.value = 10 + i * 5;
            const gain = audioContext.createGain();
            gain.gain.value = 1 / (i + 1);
            sourceMix.connect(filt);
            filt.connect(gain);
            gain.connect(formantMix);
            nodes.push(filt, gain);
        });
        const lfo = audioContext.createOscillator();
        const lfoGain = audioContext.createGain();
        lfo.frequency.setValueAtTime(1.0 + Math.random() * 1.0, now);
        lfoGain.gain.setValueAtTime(20, now);
        lfo.connect(lfoGain);
        lfoGain.connect(source.detune);
        lfoGain.connect(source2.detune);
        [source, source2].forEach(bend);
        formantMix.connect(saturator);
        source.start(now);
        source2.start(now);
        lfo.start(now);
        sources.push(source, source2, lfo);
        nodes.push(lfo, lfoGain);

    } else if (wave === 'vocoder') {
        // Each band of the mic drives the same band of the carrier. The envelope is followed in the audio graph
        // (rectify, smooth, scale), so it keeps up with the voice at the sample rate, also in a background tab
        const bandFreqs = [200, 400, 800, 1600, 3200, 6400];
        const carrier = audioContext.createOscillator();
        const carrier2 = audioContext.createOscillator();
        carrier.type = 'sawtooth';
        carrier2.type = 'sawtooth';
        carrier.frequency.setValueAtTime(freq, now);
        carrier2.frequency.setValueAtTime(freq, now);
        carrier2.detune.setValueAtTime(7, now);
        const carrierMix = audioContext.createGain();
        carrierMix.gain.value = 0.5;
        carrier.connect(carrierMix);
        carrier2.connect(carrierMix);
        const vocoderMix = audioContext.createGain();
        vocoderMix.gain.value = 0.6;
        const micTap = audioContext.createGain();
        micTap.gain.value = 1;
        micSource.connect(micTap);
        voice.links.push([micSource, micTap]);
        nodes.push(carrier, carrier2, carrierMix, vocoderMix, micTap);
        bandFreqs.forEach(bandFreq => {
            const analysisFilter = audioContext.createBiquadFilter();
            analysisFilter.type = 'bandpass';
            analysisFilter.frequency.value = bandFreq;
            analysisFilter.Q.value = 4;
            const rectify = audioContext.createWaveShaper();
            rectify.curve = curves.rectify;
            const smooth = audioContext.createBiquadFilter();
            smooth.type = 'lowpass';
            smooth.frequency.value = 30;
            smooth.Q.value = 0.5;
            const scale = audioContext.createGain();
            scale.gain.value = 9;
            const ceiling = audioContext.createWaveShaper();
            ceiling.curve = curves.unit;
            const synthFilter = audioContext.createBiquadFilter();
            synthFilter.type = 'bandpass';
            synthFilter.frequency.value = bandFreq;
            synthFilter.Q.value = 6;
            const vca = audioContext.createGain();
            vca.gain.value = 0;
            micTap.connect(analysisFilter);
            analysisFilter.connect(rectify);
            rectify.connect(smooth);
            smooth.connect(scale);
            scale.connect(ceiling);
            ceiling.connect(vca.gain);
            carrierMix.connect(synthFilter);
            synthFilter.connect(vca);
            vca.connect(vocoderMix);
            nodes.push(analysisFilter, rectify, smooth, scale, ceiling, synthFilter, vca);
        });
        [carrier, carrier2].forEach(bend);
        vocoderMix.connect(saturator);
        carrier.start(now);
        carrier2.start(now);
        sources.push(carrier, carrier2);

    } else {
        // Standard waves with 5-voice unison
        const unisonDetune = [0, -12, 12, -6, 6];
        const unisonPan = [0, -0.4, 0.4, -0.2, 0.2];
        const oscMix = audioContext.createGain();
        oscMix.gain.value = 0.18;
        nodes.push(oscMix);
        unisonDetune.forEach((detune, i) => {
            const osc = audioContext.createOscillator();
            osc.type = wave;
            osc.frequency.setValueAtTime(freq, now);
            osc.detune.setValueAtTime(detune, now);
            const panner = audioContext.createStereoPanner();
            panner.pan.value = unisonPan[i];
            osc.connect(panner);
            panner.connect(oscMix);
            bend(osc);
            osc.start(now);
            sources.push(osc);
            nodes.push(osc, panner);
        });
        oscMix.connect(saturator);
        const subOsc = audioContext.createOscillator();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(freq / 2, now);
        const subGain = audioContext.createGain();
        subGain.gain.value = 0.22;
        subOsc.connect(subGain);
        subGain.connect(saturator);
        const driftLFO = audioContext.createOscillator();
        const driftGain = audioContext.createGain();
        driftLFO.type = 'sine';
        driftLFO.frequency.setValueAtTime(0.1 + Math.random() * 0.2, now);
        driftGain.gain.setValueAtTime(15, now);
        driftLFO.connect(driftGain);
        driftGain.connect(subOsc.detune);
        bend(subOsc);
        subOsc.start(now);
        driftLFO.start(now);
        sources.push(subOsc, driftLFO);
        nodes.push(subOsc, subGain, driftLFO, driftGain);
    }

    voice.out = outputGain;

    voice.release = (at) => {
        if (voice.released) return;
        voice.released = true;
        // a release inside the attack waits for it, so the ramp it would cancel has already landed
        const t = Math.max(at === undefined ? audioContext.currentTime : at, now + attack + 0.005);
        const end = t + ring * 1.5;
        const g = outputGain.gain;
        g.cancelScheduledValues(t);
        g.setTargetAtTime(0, t, ring / 5);
        filter.frequency.cancelScheduledValues(t);
        filter.frequency.setTargetAtTime(filterBase, t, ring / 4);
        if (stringGain) {
            stringGain.gain.cancelScheduledValues(t);
            stringGain.gain.setTargetAtTime(0, t, ring / 5);
        }
        if (stringNode) stringNode.port.postMessage({ stopAt: end });
        sources.forEach(s => { try { s.stop(end); } catch (e) { /* already stopped */ } });
        if (keyEl) unflash(keyEl, t);
        if (voice.event) voice.event.dur = t - now;
        endSynthVoice(voice, end);
    };

    registerSynthVoice(voice);

    if (!skipRecording && (isRecording || isOverdub)) {
        voice.event = { type: 'synth', freq, wave, velocity, time: now - recordingStart };
        loopSlots[recordingSlot].loop.push(voice.event);
    }

    if (hold !== Infinity) voice.release(now + hold);
    return voice;
}

document.getElementById('micBtn').addEventListener('click', toggleMic);

// pointerdown is not a user activation on touch screens; the release that follows is
['pointerup', 'touchend'].forEach(type => {
    document.addEventListener(type, () => {
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }
    });
});

// Tune and decay act on the last pad played by hand; the engine keeps them per pad
const padSettings = {};
['kick', 'snare', 'hihat', 'clap', 'tom1', 'perc', 'cymbal', 'rim'].forEach(d => { padSettings[d] = { tune: 0, decay: 1 }; });
let selectedPad = 'kick';
const PAD_NAMES = { kick: 'kick', snare: 'snare', hihat: 'hat', clap: 'clap', tom1: 'tom', perc: 'perc', cymbal: 'cymbal', rim: 'rim' };

function sendPad(drum) {
    if (window.drumEngine) window.drumEngine.port.postMessage({ type: 'set', voice: drum, tune: padSettings[drum].tune, decay: padSettings[drum].decay });
}

function showPad() {
    const settings = padSettings[selectedPad];
    document.getElementById('padName').textContent = PAD_NAMES[selectedPad];
    document.getElementById('padTune').value = settings.tune;
    document.getElementById('padTuneVal').textContent = (settings.tune > 0 ? '+' : '') + settings.tune;
    document.getElementById('padDecay').value = Math.round(settings.decay * 100);
    document.getElementById('padDecayVal').textContent = Math.round(settings.decay * 100) + '%';
    document.querySelectorAll('.pad').forEach(p => p.classList.toggle('selected', p.dataset.sound === selectedPad));
}

function selectPad(drum) {
    if (selectedPad === drum) return;
    selectedPad = drum;
    showPad();
}

function setPad(drum, changes) {
    Object.assign(padSettings[drum], changes);
    sendPad(drum);
    if (drum === selectedPad) showPad();
}

document.getElementById('padTune').addEventListener('input', function() {
    setPad(selectedPad, { tune: parseInt(this.value, 10) });
});
document.getElementById('padDecay').addEventListener('input', function() {
    setPad(selectedPad, { decay: parseInt(this.value, 10) / 100 });
});
showPad();

document.querySelectorAll('.pad').forEach(pad => {
    addPressHandler(pad, function() {
        const sound = this.dataset.sound;
        selectPad(sound);
        playDrum(sound);
    });
});

// A pressed key sounds until it's let go; sliding across the keys plays each one it reaches
const keyboardEl = document.querySelector('.keyboard');
const pointerNotes = new Map();

function pressKey(pointerId, key) {
    const held = pointerNotes.get(pointerId);
    if (held && held.key === key) return;
    if (held && held.voice) held.voice.release();
    if (key) lastNote = freqMidi(keyFreq(key.dataset.note));
    pointerNotes.set(pointerId, { key, voice: key ? playNote(keyFreq(key.dataset.note)) : null });
}

function liftKey(pointerId) {
    const held = pointerNotes.get(pointerId);
    if (!held) return;
    pointerNotes.delete(pointerId);
    if (held.voice) held.voice.release();
}

keyboardEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const key = e.target.closest('.key');
    if (!key) return;
    keyboardEl.setPointerCapture(e.pointerId);
    pressKey(e.pointerId, key);
});
keyboardEl.addEventListener('pointermove', e => {
    if (!pointerNotes.has(e.pointerId)) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    pressKey(e.pointerId, under ? under.closest('.key') : null);
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => {
    keyboardEl.addEventListener(type, e => liftKey(e.pointerId));
});
keyboardEl.addEventListener('touchstart', e => e.preventDefault(), { passive: false });

function shiftOctave(step) {
    const next = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, octaveShift + step));
    if (next === octaveShift) return;
    octaveShift = next;
    updateKeyLabels();
}

document.getElementById('octDown').addEventListener('click', () => shiftOctave(-1));
document.getElementById('octUp').addEventListener('click', () => shiftOctave(1));

const drums =['kick', 'snare', 'hihat', 'clap', 'tom1', 'perc', 'cymbal', 'rim'];

// A drum step goes on, then accented, then off. A keys step takes the last note played; the same note again clears it
[...drums, 'keys'].forEach(drum => {
    const stepsContainer = document.querySelector(`.seq-steps[data-drum="${drum}"]`);
    for (let i = 0; i < 16; i++) {
        const step = document.createElement('div');
        step.className = 'step';
        step.dataset.drum = drum;
        step.dataset.index = i;
        addPressHandler(step, function() {
            const row = sequencerSteps[drum];
            if (drum === 'keys') row[i] = row[i] === lastNote ? null : lastNote;
            else row[i] = !row[i] ? 1 : row[i] === 2 ? 0 : 2;
            paintStep(this, row[i]);
            saveSequencerState();
            updatePatternCount();
        });
        stepsContainer.appendChild(step);
    }
});

document.getElementById('playSeq').addEventListener('click', () => toggleSequencer());

// The timer only wakes the scheduler; every sound is placed on audioContext.currentTime
function startClock() {
    if (clockId) return;
    clockId = setInterval(clockTick, SCHEDULER.TICK_MS);
    clockTick();
}

function clockTick() {
    if (!audioLoaded) return;
    const horizon = audioContext.currentTime + SCHEDULER.LOOKAHEAD;
    let busy = false;

    if (isPlaying) {
        scheduleSequencer(horizon);
        busy = true;
    }

    Object.values(loopSlots).forEach(slot => {
        if (slot.playback && slot.playback.events) {
            scheduleSlotEvents(slot.playback, horizon);
            busy = true;
        }
    });

    if (!busy) {
        clearInterval(clockId);
        clockId = null;
    }
}

function scheduleSequencer(horizon) {
    while (nextStepTime < horizon) {
        const step = currentStep;
        const stepLength = 60 / parseInt(document.getElementById('tempo').value) / 4;
        const time = nextStepTime + (step % 2 ? swing * 0.5 * stepLength : 0);

        if (time > audioContext.currentTime - SCHEDULER.LATE) {
            drums.forEach(drum => {
                const hit = sequencerSteps[drum][step];
                if (hit) playDrum(drum, false, time, hit === 2 ? ACCENT : 1);
            });
            const note = sequencerSteps.keys[step];
            if (note !== null) playNote(midiFreq(note), { time, hold: stepLength * 0.5 });

            const run = seqRun;
            setTimeout(() => {
                if (run === seqRun) showStep(step);
            }, Math.max(0, (time - audioContext.currentTime) * 1000));
        }

        currentStep = (currentStep + 1) % 16;
        nextStepTime += stepLength;
    }
}

function showStep(step) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('playing'));
    document.querySelectorAll(`.step[data-index="${step}"]`).forEach(s => s.classList.add('playing'));

    // Update beat indicator (4 beats per bar, 4 steps per beat)
    document.querySelectorAll('.beat-dot').forEach(dot => dot.classList.remove('active'));
    const activeDot = document.querySelector(`.beat-dot[data-beat="${Math.floor(step / 4) + 1}"]`);
    if (activeDot) activeDot.classList.add('active');
}

function toggleSequencer(skipRecording = false) {
    if (!audioLoaded) {
        initSystem().then(() => toggleSequencer(skipRecording));
        return;
    }

    if (!isPlaying) {
        isPlaying = true;
        seqRun++;
        nextStepTime = audioContext.currentTime + 0.05;

        document.getElementById('playSeq').textContent = 'stop';
        document.getElementById('playSeq').classList.add('active');

        // Only auto-record if not called from API (skipRecording = false)
        if (!skipRecording && !isRecording && !isOverdub) {
            startRecording();
        }

        if (demoSlot) {
            startSlot(demoSlot, nextStepTime);
            updateSlotUI();
        }

        startClock();
    } else {
        stopSequencer();
    }
}

function stopSequencer(shouldStopRecording = true) {
    isPlaying = false;
    seqRun++;
    currentStep = 0;
    document.querySelectorAll('.step').forEach(s => s.classList.remove('playing'));
    document.querySelectorAll('.beat-dot').forEach(dot => dot.classList.remove('active'));
    document.getElementById('playSeq').textContent = 'play+rec';
    document.getElementById('playSeq').classList.remove('active');

    if (demoSlot) {
        stopSlot(demoSlot);
        updateSlotUI();
    }

    if (shouldStopRecording && isRecording) {
        stopRecording();
    }
}

document.getElementById('clearSeq').addEventListener('click', () => {
    clearPattern();
    saveSequencerState();
    updatePatternCount();
});

let takeId = null;

function startRecording() {
    recordingSlot = activeSlot;
    stopSlot(recordingSlot);
    if (recordingSlot === demoSlot) demoSlot = null;

    isRecording = true;
    isOverdub = false;
    recordingStart = audioContext.currentTime;
    loopSlots[recordingSlot].loop = [];
    takeId = recordFrom(recordingStart);

    document.getElementById('recordBtn').textContent = 'recording...';
    document.getElementById('recordBtn').classList.add('active');
    document.getElementById('recStatus').textContent = 'on';
    updateSlotUI();
}

function stopRecording() {
    isRecording = false;
    const key = recordingSlot;
    const frames = Math.round((audioContext.currentTime - recordingStart) * audioContext.sampleRate);
    if (!loopSlots[key].audioBuffer) loopSlots[key].loopSamples = frames;
    recordFor(takeId, frames).then(take => {
        if (take) setSlotAudio(key, take, take.length);
    });
    takeId = null;
    document.getElementById('recordBtn').textContent = 'rec manual';
    document.getElementById('recordBtn').classList.remove('active');
    document.getElementById('recStatus').textContent = 'off';
}

function startOverdub() {
    const now = audioContext.currentTime;
    recordingSlot = activeSlot;
    if (recordingSlot === demoSlot) demoSlot = null;

    isOverdub = true;
    recordingStart = now;
    startSlot(recordingSlot, now);
    overdubLength = loopSlots[recordingSlot].playback ? loopSlots[recordingSlot].playback.length : 0;
    takeId = recordFrom(now);

    document.getElementById('overdubBtn').textContent = 'layering...';
    document.getElementById('overdubBtn').classList.add('active');
    document.getElementById('recStatus').textContent = 'overdub';
    updateSlotUI();
}

function stopOverdub() {
    if (overdubStop) return;

    const now = audioContext.currentTime;
    const key = recordingSlot;
    const slot = loopSlots[key];
    const under = slot.audioBuffer;
    const underLength = slot.loopSamples;
    // the layer closes on the loop boundary, so the take holds whole cycles
    const cycles = overdubLength > 0 ? Math.max(1, Math.ceil((now - recordingStart) / overdubLength)) : 0;
    const frames = cycles && underLength ? cycles * underLength : Math.round((now - recordingStart) * audioContext.sampleRate);
    const stopAt = recordingStart + frames / audioContext.sampleRate;

    recordFor(takeId, frames).then(layer => {
        if (layer) setSlotAudio(key, addLayerTo(under, underLength, layer), layer.length);
    });
    takeId = null;

    const finish = () => {
        overdubStop = null;
        isOverdub = false;
        if (!slot.audioBuffer) slot.loopSamples = frames;
        document.getElementById('overdubBtn').textContent = 'add layer';
        document.getElementById('overdubBtn').classList.remove('active');
        document.getElementById('recStatus').textContent = 'off';
    };

    if (stopAt <= now) {
        finish();
        return;
    }

    // the take ends on its own frame; this only puts the buttons back when it does
    overdubStop = setTimeout(finish, (stopAt - now) * 1000);
}

document.getElementById('recordBtn').addEventListener('click', () => {
    initSystem();
    if (isOverdub) return;

    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

document.getElementById('overdubBtn').addEventListener('click', () => {
    initSystem();

    if (!isOverdub && !isRecording) {
        startOverdub();
    } else if (isOverdub) {
        stopOverdub();
    }
});

function slotLength(slot) {
    if (slot.loopSamples > 0) return slot.loopSamples / audioContext.sampleRate;
    if (slot.audioBuffer) return slot.audioBuffer.length / slot.audioBuffer.sampleRate;
    const bar = 240 / parseInt(document.getElementById('tempo').value);
    const last = slot.loop.reduce((max, event) => Math.max(max, event.time), 0);
    return Math.max(1, Math.ceil(last / bar + 0.001)) * bar;
}

function startSlot(key, when) {
    const slot = loopSlots[key];
    stopSlot(key);
    if (!slot.audioBuffer && slot.loop.length === 0) return;

    const length = slotLength(slot);

    if (slot.audioBuffer) {
        const source = audioContext.createBufferSource();
        source.buffer = slot.audioBuffer;
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = length;
        source.connect(loopBus);
        source.start(when);
        slot.playback = { source, start: when, length };
    } else {
        slot.playback = {
            events: slot.loop.slice().sort((a, b) => a.time - b.time),
            start: when,
            length,
            index: 0,
            cycle: when
        };
        startClock();
    }

    slot.isPlaying = true;
}

function stopSlot(key) {
    const slot = loopSlots[key];
    const playback = slot.playback;
    slot.playback = null;
    slot.isPlaying = false;

    if (playback && playback.source) {
        const source = playback.source;
        try { source.stop(); } catch(e) {}
        setTimeout(() => source.disconnect(), 100);
    }
}

function swapSlotPlayback(key) {
    const old = loopSlots[key].playback;
    const ahead = audioContext.currentTime + SCHEDULER.LOOKAHEAD + 0.05;
    const at = old.start + Math.ceil((ahead - old.start) / old.length) * old.length;

    loopSlots[key].playback = null;
    if (old.source) {
        old.source.stop(at);
        setTimeout(() => old.source.disconnect(), (at - audioContext.currentTime) * 1000 + 100);
    }
    startSlot(key, at);
}

function scheduleSlotEvents(playback, horizon) {
    if (playback.events.length === 0 || playback.length <= 0) return;

    for (;;) {
        if (playback.index >= playback.events.length) {
            playback.index = 0;
            playback.cycle += playback.length;
        }

        const event = playback.events[playback.index];
        const time = playback.cycle + event.time;
        if (time >= horizon) break;

        if (event.time < playback.length && time > audioContext.currentTime - SCHEDULER.LATE) {
            if (event.type === 'drum') {
                playDrum(event.sound, true, time, event.velocity, event.variant);
            } else if (event.type === 'synth') {
                playNote(event.freq, { skipRecording: true, time, wave: event.wave, velocity: event.velocity, hold: event.dur || 0 });
            }
        }
        playback.index++;
    }
}

function clearSlot(key) {
    stopSlot(key);
    const slot = loopSlots[key];
    slot.loop = [];
    slot.audioBuffer = null;
    slot.history = [];
    slot.duration = 0;
    slot.loopSamples = 0;
    if (key === demoSlot) demoSlot = null;
}

document.getElementById('playLoopBtn').addEventListener('click', () => {
    initSystem();

    if (loopSlots[activeSlot].playback) {
        stopSlot(activeSlot);
    } else {
        startSlot(activeSlot, audioContext.currentTime);
    }
    updateSlotUI();
});

document.getElementById('playAllBtn').addEventListener('click', () => {
    initSystem();

    const keys = Object.keys(loopSlots);
    if (keys.some(key => loopSlots[key].playback)) {
        keys.forEach(stopSlot);
    } else {
        const when = audioContext.currentTime;
        keys.forEach(key => startSlot(key, when));
    }
    updateSlotUI();
});

document.getElementById('clearLoopBtn').addEventListener('click', () => {
    clearSlot(activeSlot);
    updateSlotUI();
    document.getElementById('downloadBtn').style.display = 'none';
});

document.getElementById('downloadBtn').addEventListener('click', () => {
    if (!loopSlots[activeSlot].audioBuffer) return;
    const blob = slotWav(loopSlots[activeSlot]);

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tempo = document.getElementById('tempo').value;
    a.download = `playground-mk1-${activeSlot}-${tempo}bpm-${timestamp}.wav`;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);

    showMessage('exported slot ' + activeSlot);
});

// Export all non-empty slots
function exportAllSlots() {
    const slotsWithContent = Object.entries(loopSlots)
        .filter(([key, slot]) => slot.audioBuffer !== null);

    if (slotsWithContent.length === 0) {
        showMessage('no audio to export');
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tempo = document.getElementById('tempo').value;

    slotsWithContent.forEach(([key, slot], index) => {
        setTimeout(() => {
            const url = URL.createObjectURL(slotWav(slot));
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `playground-mk1-${key}-${tempo}bpm-${timestamp}.wav`;
            document.body.appendChild(a);
            a.click();

            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
        }, index * 300); // Stagger downloads to avoid browser blocking
    });

    showMessage('exporting ' + slotsWithContent.length + ' slots');
}

document.getElementById('exportAllBtn').addEventListener('click', exportAllSlots);

// takes the slot back to what it was before its last take or layer
function undoLayer(key) {
    const slot = loopSlots[key];
    const previous = slot.history.pop();
    if (!previous) return;
    slot.audioBuffer = previous.audioBuffer;
    slot.loopSamples = previous.loopSamples;
    slot.duration = previous.loopSamples / audioContext.sampleRate;
    if (slot.playback) swapSlotPlayback(key);
    updateSlotUI();
    showMessage('layer undone');
}

document.getElementById('undoLayerBtn').addEventListener('click', () => undoLayer(activeSlot));

document.querySelectorAll('.slot-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        activeSlot = this.dataset.slot;
        updateSlotUI();
    });
});

function updateSlotUI() {
    const slot = loopSlots[activeSlot];
    
    let infoText;
    if (slot.audioBuffer) {
        const duration = slot.duration.toFixed(1);
        infoText = `slot ${activeSlot} · ${duration}s recorded`;
    } else if (slot.loop.length > 0) {
        infoText = `slot ${activeSlot} · ${slot.loop.length} events`;
    } else {
        infoText = `slot ${activeSlot} · empty`;
    }
    document.getElementById('slotInfo').textContent = infoText;
    
    document.querySelectorAll('.slot-btn').forEach(btn => {
        const slotKey = btn.dataset.slot;
        const slotHasContent = loopSlots[slotKey].loop.length > 0 || loopSlots[slotKey].audioBuffer !== null;
        if (slotHasContent) {
            btn.classList.add('has-content');
        } else {
            btn.classList.remove('has-content');
        }
    });
    
    document.getElementById('downloadBtn').style.display = slot.audioBuffer ? 'block' : 'none';
    document.getElementById('undoLayerBtn').style.display = slot.history.length ? 'block' : 'none';

    document.getElementById('playLoopBtn').textContent = slot.playback ? 'stop' : 'play';
    document.getElementById('playAllBtn').textContent = Object.values(loopSlots).some(s => s.playback) ? 'stop all' : 'play all';
}

function setMasterVolume(value) {
    if (masterGain) setParam(masterGain.gain, value);
    if (loopBus) setParam(loopBus.gain, value / AUDIO_CONSTANTS.MASTER_VOLUME);
}

document.getElementById('masterVol').addEventListener('input', function() {
    setMasterVolume(this.value / 100);
    document.getElementById('masterVolVal').textContent = this.value + '%';
});

document.getElementById('attack').addEventListener('input', function() {
    attackTime = this.value;
    document.getElementById('attackVal').textContent = this.value + 'ms';
});

document.getElementById('release').addEventListener('input', function() {
    releaseTime = this.value;
    document.getElementById('releaseVal').textContent = this.value + 'ms';
});

document.getElementById('tempo').addEventListener('input', function() {
    document.getElementById('tempoVal').textContent = this.value;
    document.getElementById('tempoStatus').textContent = this.value;
    syncDelay();
});

document.getElementById('swing').addEventListener('input', function() {
    swing = this.value / 100;
    document.getElementById('swingVal').textContent = this.value + '%';
});

document.getElementById('reverb').addEventListener('input', function() {
    const value = this.value / 100;
    document.getElementById('reverbVal').textContent = this.value + '%';
    if (window.reverbMix) {
        setParam(window.reverbMix.gain, value);
    }
});

document.getElementById('delay').addEventListener('input', function() {
    const value = this.value / 100;
    document.getElementById('delayVal').textContent = this.value + '%';
    if (window.delayMix) {
        setParam(window.delayMix.gain, value);
    }
});

document.getElementById('filter').addEventListener('input', function() {
    const value = filterHz(parseInt(this.value));
    document.getElementById('filterVal').textContent = value + 'Hz';
    if (window.filterNode) {
        setParam(window.filterNode.frequency, value);
    }
});

document.getElementById('distort').addEventListener('input', function() {
    const value = parseInt(this.value);
    document.getElementById('distortVal').textContent = value + '%';
    applyDistortion(value / 100);
});

document.getElementById('crush').addEventListener('input', function() {
    const value = parseInt(this.value);
    document.getElementById('crushVal').textContent = value;
    applyCrush(value);
});

document.getElementById('chorus').addEventListener('input', function() {
    const value = parseInt(this.value);
    document.getElementById('chorusVal').textContent = value + '%';
    applyChorus(value / 100);
});

// Know how
const knowHow = document.getElementById('knowHow');
const knowHowPanel = document.getElementById('knowHowPanel');

function showKnowHow(open) {
    if (!open && knowHowPanel.contains(document.activeElement)) knowHow.focus();
    knowHowPanel.hidden = !open;
    knowHow.setAttribute('aria-expanded', open);
}

knowHow.addEventListener('click', () => showKnowHow(knowHowPanel.hidden));

document.addEventListener('pointerdown', (e) => {
    if (knowHowPanel.hidden || knowHowPanel.contains(e.target) || knowHow.contains(e.target)) return;
    showKnowHow(false);
});

// Keyboard layouts for different keyboard types
const keyboardLayouts = {
    qwerty: {
        '1': 'kick', '2': 'snare', '3': 'hihat', '4': 'clap',
        '5': 'tom1', '6': 'perc', '7': 'cymbal', '8': 'rim',
        'a': 'C4', 'w': 'C#4', 's': 'D4', 'e': 'D#4',
        'd': 'E4', 'f': 'F4', 't': 'F#4', 'g': 'G4',
        'y': 'G#4', 'h': 'A4', 'u': 'A#4', 'j': 'B4', 'k': 'C5'
    },
    azerty: {
        '1': 'kick', '2': 'snare', '3': 'hihat', '4': 'clap',
        '5': 'tom1', '6': 'perc', '7': 'cymbal', '8': 'rim',
        'q': 'C4', 'z': 'C#4', 's': 'D4', 'e': 'D#4',
        'd': 'E4', 'f': 'F4', 't': 'F#4', 'g': 'G4',
        'y': 'G#4', 'h': 'A4', 'u': 'A#4', 'j': 'B4', 'k': 'C5'
    },
    qwertz: {
        '1': 'kick', '2': 'snare', '3': 'hihat', '4': 'clap',
        '5': 'tom1', '6': 'perc', '7': 'cymbal', '8': 'rim',
        'a': 'C4', 'w': 'C#4', 's': 'D4', 'e': 'D#4',
        'd': 'E4', 'f': 'F4', 't': 'F#4', 'g': 'G4',
        'z': 'G#4', 'h': 'A4', 'u': 'A#4', 'j': 'B4', 'k': 'C5'
    }
};

let currentLayout = localStorage.getItem('playground-mk1-keyboard-layout') || 'qwerty';
let keyMap = keyboardLayouts[currentLayout];

// Initialize keyboard layout custom select
const keyboardLayoutElement = document.getElementById('keyboardLayout');
customSelectInstances.keyboardLayout = new CustomSelect(keyboardLayoutElement);

// Set initial value from localStorage
if (currentLayout !== 'qwerty') {
    const option = keyboardLayoutElement.querySelector(`[data-value="${currentLayout}"]`);
    if (option) {
        keyboardLayoutElement.querySelectorAll('.custom-select-option').forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');
        keyboardLayoutElement.dataset.value = currentLayout;
        keyboardLayoutElement.querySelector('.custom-select-value').textContent = option.textContent;
    }
}

// Labels follow the layout and the octave: white keys show key · note, black keys only the key
function updateKeyLabels() {
    const keyOf = {};
    Object.keys(keyMap).forEach(k => { if (notes[keyMap[k]]) keyOf[keyMap[k]] = k; });
    document.querySelectorAll('.key').forEach(el => {
        const name = el.dataset.note;
        const label = el.querySelector('.key-label');
        const letter = keyOf[name] || '';
        if (el.classList.contains('black')) {
            label.textContent = letter;
            return;
        }
        const pitch = name.replace(/\d/, '').toLowerCase() + (parseInt(name.slice(-1), 10) + octaveShift);
        label.textContent = letter ? letter + ' · ' + pitch : pitch;
    });
    document.getElementById('octVal').textContent = 'c' + (4 + octaveShift);
}

function showLayoutKeys() {
    updateKeyLabels();
    const keysFor = test => Object.keys(keyMap).filter(k => notes[keyMap[k]] && test(keyMap[k])).join(' ');
    knowHowPanel.querySelector('[data-keys="white"]').textContent = keysFor(n => !n.includes('#'));
    knowHowPanel.querySelector('[data-keys="black"]').textContent = keysFor(n => n.includes('#'));
    // A slot key that is also a note in this layout plays the note, so it is left out
    const slotKeys = { q: 'a', z: 'b', b: 'c', n: 'd' };
    const free = Object.keys(slotKeys).filter(k => !keyMap[k]);
    knowHowPanel.querySelector('[data-keys="slots"]').textContent = free.join(' ');
    knowHowPanel.querySelector('[data-keys="slot-names"]').textContent = 'slots ' + free.map(k => slotKeys[k]).join(' ');
}

showLayoutKeys();

keyboardLayoutElement.addEventListener('change', function(e) {
    currentLayout = e.detail.value;
    keyMap = keyboardLayouts[currentLayout];
    localStorage.setItem('playground-mk1-keyboard-layout', currentLayout);
    showLayoutKeys();
    showMessage('layout: ' + currentLayout);
});

// Initialize wave type grid
const waveTypeElement = document.getElementById('waveType');
const waveGridBtns = waveTypeElement.querySelectorAll('.wave-grid-btn');
waveGridBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        waveGridBtns.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        waveTypeElement.dataset.value = btn.dataset.value;
    });
});
customSelectInstances.waveType = {
    get value() {
        return waveTypeElement.dataset.value;
    },
    set value(newValue) {
        const btn = Array.from(waveGridBtns).find(b => b.dataset.value === newValue);
        if (btn) {
            waveGridBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            waveTypeElement.dataset.value = newValue;
        }
    }
};

document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();

    if (!knowHowPanel.hidden) {
        if (e.key === 'Escape' || e.key === '?') showKnowHow(false);
        return;
    }

    // Undo/Redo shortcuts
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
            redoSequencer();
        } else {
            undoSequencer();
        }
        return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        redoSequencer();
        return;
    }

    if (e.key === '?') {
        e.preventDefault();
        showKnowHow(true);
        return;
    }

    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;

    // a focused slider keeps its arrows
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(document.activeElement && document.activeElement.matches('input, select, textarea'))) {
        e.preventDefault();
        shiftOctave(e.key === 'ArrowLeft' ? -1 : 1);
        return;
    }

    // Checked before the note map, which owns plain 'e'
    if (e.shiftKey && key === 'e') {
        exportAllSlots();
        return;
    }

    if (keyMap[key]) {
        const val = keyMap[key];
        if (drums.includes(val)) {
            selectPad(val);
            playDrum(val);
        } else if (!keyNotes.has(key)) {
            lastNote = freqMidi(keyFreq(val));
            keyNotes.set(key, playNote(keyFreq(val)));
        }
        return;
    }

    if (key === 'enter') {
        initSystem();
        return;
    }
    
    if (key === ' ') {
        e.preventDefault();
        toggleSequencer();
        return;
    }
    
    if (key === 'r') {
        document.getElementById('recordBtn').click();
        return;
    }
    if (key === 'o') {
        document.getElementById('overdubBtn').click();
        return;
    }
    if (key === 'p') {
        document.getElementById('playLoopBtn').click();
        return;
    }
    if (key === 'l') {
        document.getElementById('playAllBtn').click();
        return;
    }
    if (key === 'c') {
        document.getElementById('clearLoopBtn').click();
        return;
    }
    if (key === 'x') {
        document.getElementById('clearSeq').click();
        return;
    }
    if (key === 'v') {
        document.getElementById('downloadBtn').click();
        return;
    }
    if (key === 'm') {
        toggleMic();
        return;
    }
    
    if (key === 'q') {
        document.querySelector('[data-slot="A"]').click();
        return;
    }
    if (key === 'z') {
        document.querySelector('[data-slot="B"]').click();
        return;
    }
    if (key === 'b') {
        document.querySelector('[data-slot="C"]').click();
        return;
    }
    if (key === 'n') {
        document.querySelector('[data-slot="D"]').click();
        return;
    }
});

// A held letter holds its note; leaving the window lets every held note go, so none is left hanging
const keyNotes = new Map();

document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (!keyNotes.has(key)) return;
    const voice = keyNotes.get(key);
    keyNotes.delete(key);
    if (voice) voice.release();
});

window.addEventListener('blur', () => {
    keyNotes.forEach(voice => { if (voice) voice.release(); });
    keyNotes.clear();
    [...pointerNotes.keys()].forEach(liftKey);
    releaseMidiNotes();
});

// Cache color values to avoid repeated getComputedStyle calls
let cachedVizBgColor = null;
let cachedVizLineColor = null;

function updateVizColors() {
    cachedVizBgColor = getComputedStyle(document.documentElement).getPropertyValue('--viz-bg').trim();
    cachedVizLineColor = getComputedStyle(document.documentElement).getPropertyValue('--viz-line').trim();
}

function drawViz() {
    requestAnimationFrame(drawViz);

    if (!isActive || !analyser) {
        return;
    }

    if (!cachedVizBgColor || !cachedVizLineColor) {
        updateVizColors();
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    ctx.fillStyle = cachedVizBgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = ANIMATION_CONSTANTS.VIZ_LINE_WIDTH;
    ctx.strokeStyle = cachedVizLineColor;
    ctx.beginPath();

    const sliceWidth = canvas.width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * canvas.height / 2;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }

        x += sliceWidth;
    }

    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
}

function resizeCanvas() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
}

// The display grows with the console, not only with the window
new ResizeObserver(resizeCanvas).observe(canvas);

function updatePatternCount() {
    let totalActive = sequencerSteps.keys.filter(note => note !== null).length;
    drums.forEach(drum => {
        const activeSteps = sequencerSteps[drum].filter(step => step).length;
        totalActive += activeSteps;
    });
    document.getElementById('patternCount').textContent = totalActive > 0 ? 1 : 0;
}

function isSlotFree(key) {
    const slot = loopSlots[key];
    const beingRecorded = (isRecording || isOverdub) && key === recordingSlot;
    return !slot.audioBuffer && slot.loop.length === 0 && !beingRecorded;
}

// Kept for n0body, which clicked the old start button to wake the audio engine
document.getElementById('initBtn').addEventListener('click', () => initSystem());

// ============================================
// ON AIR
// ============================================
// What goes out is the stream the looper records: the master after the limiter and the ceiling, nothing else
const airBtn = document.getElementById('airBtn');
const airClock = document.getElementById('airClock');
const airStatus = document.getElementById('airStatus');
const airLink = document.getElementById('airLink');
const airUrl = document.getElementById('airUrl');
const airCopy = document.getElementById('airCopy');
const airEnd = document.getElementById('airEnd');

let air = null;
let airWait = null;
let airClockId = null;
let airNoteId = null;
let airCopyId = null;
let airArmed = null;

const AIR_ENDS = {
    end: 'off air. nothing kept.',
    lost: 'the line was down too long. off air.',
    replaced: 'it went on from another window.',
    server: 'the radio closed it.',
    full: 'the radio is full. try again later.',
    refused: "this page can't reach the radio.",
    unreachable: "the radio isn't answering. try again in a minute."
};

function airTime(since) {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    const pad = n => (n < 10 ? '0' : '') + n;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? h + ':' + pad(m) + ':' + pad(s % 60) : m + ':' + pad(s % 60);
}

function airNote(text, ms) {
    clearTimeout(airNoteId);
    airStatus.textContent = text;
    if (ms) airNoteId = setTimeout(() => { airStatus.textContent = ''; }, ms);
}

function airListening(n) {
    airNote(n ? n + ' listening' : 'nobody listening yet');
}

// off · busy (connecting, waking) · on · hold (the line dropped, the room waits)
function airShow(state) {
    const live = state === 'on' || state === 'hold';
    airBtn.dataset.state = state;
    airBtn.setAttribute('aria-pressed', state === 'off' ? 'false' : 'true');
    airClock.hidden = !live;
    airLink.hidden = !live;
    airEnd.hidden = !live;
    clearInterval(airClockId);
    if (live && air && air.since) {
        const since = air.since;
        airClock.textContent = airTime(since);
        airClockId = setInterval(() => { airClock.textContent = airTime(since); }, 1000);
    }
}

function airFailure(code) {
    return Object.assign(new Error(code), { code });
}

function airStart(opts) {
    const o = opts || {};
    if (air) return air.id ? Promise.resolve({ id: air.id, link: air.link }) : airWait;
    if (!window.PGAir) {
        airNote("the radio didn't load. reload the page.");
        return Promise.reject(airFailure('unreachable'));
    }

    initSystem();
    let session;
    try {
        session = PGAir.goLive({
            stream: mediaStreamDestination.stream,
            name: typeof o.name === 'string' ? o.name : '',
            from: typeof o.from === 'string' && o.from ? o.from : 'mk-1'
        });
    } catch (e) {
        airNote("the radio didn't load. reload the page.");
        return Promise.reject(airFailure('unreachable'));
    }
    air = session;
    airShow('busy');
    airNote('going on air…');

    airWait = new Promise((resolve, reject) => {
        session.on('live', e => resolve({ id: e.id, link: e.link }));
        session.on('ended', e => { if (!session.id) reject(airFailure(e.reason)); });
    });
    // the header tells what happened; a caller that doesn't wait shouldn't get an unhandled rejection
    airWait.catch(() => {});

    session.on('waking', () => airNote('waking the radio… up to a minute'));
    session.on('live', e => {
        airUrl.textContent = 'mk-air/?r=' + e.id;
        airShow('on');
        airListening(session.listeners);
    });
    session.on('count', e => { if (session.state === 'live') airListening(e.listeners); });
    session.on('reconnecting', () => {
        airShow('hold');
        airNote('the line dropped. reconnecting…');
    });
    session.on('resumed', () => {
        airShow('on');
        airListening(session.listeners);
    });
    session.on('ended', e => {
        if (air !== session) return;
        air = null;
        airWait = null;
        airDisarm();
        airShow('off');
        if (e.reason === 'end') airNote(session.id ? AIR_ENDS.end : 'off air.', 4000);
        else airNote(AIR_ENDS[e.reason] || AIR_ENDS.unreachable);
    });

    return airWait;
}

function airStop() {
    if (air) air.end();
}

function airDisarm() {
    clearTimeout(airArmed);
    airArmed = null;
    airEnd.textContent = 'end';
    airEnd.classList.remove('armed');
}

// two presses, no dialog: a stray click shouldn't cut a set. Before going live there is nothing to cut
function airAskEnd() {
    if (!air) return;
    if (!air.id) return airStop();
    if (!airArmed) {
        airEnd.textContent = 'end? press again';
        airEnd.classList.add('armed');
        airArmed = setTimeout(airDisarm, 3000);
        return;
    }
    airDisarm();
    airStop();
}

function airState() {
    if (!air) return { state: 'off', id: null, link: null, listeners: 0 };
    return { state: air.state, id: air.id, link: air.link, listeners: air.listeners };
}

async function airCopyLink() {
    if (!air || !air.link) return;
    const link = air.link;
    let copied = false;
    try {
        await navigator.clipboard.writeText(link);
        copied = true;
    } catch (e) {
        const field = document.createElement('textarea');
        field.value = link;
        field.setAttribute('readonly', '');
        field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(field);
        field.select();
        try { copied = document.execCommand('copy'); } catch (err) { copied = false; }
        field.remove();
    }
    if (!copied) {
        // nothing to copy with: the whole link, selected, for ctrl+c
        airNote(link);
        const range = document.createRange();
        range.selectNodeContents(airStatus);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
    }
    airCopy.textContent = copied ? 'copied' : 'selected';
    clearTimeout(airCopyId);
    airCopyId = setTimeout(() => { airCopy.textContent = 'copy'; }, 2000);
}

airBtn.addEventListener('click', () => {
    if (air) airAskEnd();
    else airStart();
});
airEnd.addEventListener('click', airAskEnd);
airLink.addEventListener('click', airCopyLink);

// mk-air's signaling sleeps on Render's free tier; a hover wakes it before the click lands
airBtn.addEventListener('pointerenter', () => { if (window.PGAir && !air) PGAir.wake(); }, { once: true });

addEventListener('pagehide', airStop);

// a local test server (?air=) stays on when following a link to mk-air; in production this is a no-op
if (window.PGAir) document.querySelectorAll('a[href^="mk-air/"]').forEach(a => {
    const href = PGAir.withServer(a.getAttribute('href'));
    if (href !== a.href) a.href = href;
});

document.getElementById('loadDemoBtn').addEventListener('click', () => {
    initSystem();

    if (demoSlot) clearSlot(demoSlot);

    clearPattern();

    sequencerSteps.kick[0] = true;
    sequencerSteps.kick[4] = true;
    sequencerSteps.kick[8] = true;
    sequencerSteps.kick[12] = true;
    
    sequencerSteps.snare[4] = true;
    sequencerSteps.snare[12] = true;
    
    for (let i = 0; i < 16; i += 2) {
        sequencerSteps.hihat[i] = true;
    }
    
    sequencerSteps.clap[4] = true;
    sequencerSteps.clap[12] = true;

    updateSequencerUI();

    const free = Object.keys(loopSlots).filter(isSlotFree);
    if (free.length > 0) {
        demoSlot = free[free.length - 1];
        loopSlots[demoSlot].loop = [
            { type: 'synth', freq: notes.C4, wave: 'sine', time: 0 },
            { type: 'synth', freq: notes.E4, wave: 'sine', time: 0.5 },
            { type: 'synth', freq: notes.G4, wave: 'sine', time: 1.0 },
            { type: 'synth', freq: notes.C5, wave: 'sine', time: 1.5 },
            { type: 'synth', freq: notes.G4, wave: 'sine', time: 2.0 },
            { type: 'synth', freq: notes.E4, wave: 'sine', time: 2.5 },
            { type: 'synth', freq: notes.C4, wave: 'sine', time: 3.0 }
        ];
        // Two bars at 120 bpm, so the melody lines up with the pattern
        loopSlots[demoSlot].loopSamples = 4 * audioContext.sampleRate;

        // Space records into the active slot; keep it off the melody
        if (free.length > 1) {
            activeSlot = free[0];
            document.querySelectorAll('.slot-btn').forEach(b => b.classList.toggle('active', b.dataset.slot === activeSlot));
        }
    }

    document.getElementById('tempo').value = 120;
    document.getElementById('tempoVal').textContent = '120';
    document.getElementById('tempoStatus').textContent = '120';
    customSelectInstances.waveType.value = 'sine';

    saveSequencerState();
    updatePatternCount();
    updateSlotUI();

    showMessage(free.length > 0 ? 'demo · space' : 'demo · space · slots full', 4000);
});

document.getElementById('clearAllBtn').addEventListener('click', () => {
    if (isMicActive) {
        toggleMic();
    }

    Object.keys(loopSlots).forEach(clearSlot);

    clearPattern();

    if (isPlaying) {
        stopSequencer();
    }

    activeSlot = 'A';
    document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-slot="A"]').classList.add('active');

    customSelectInstances.waveType.value = 'sine';

    document.querySelectorAll('input[type="range"]').forEach(input => {
        input.value = input.defaultValue;
        input.dispatchEvent(new Event('input'));
    });

    document.getElementById('downloadBtn').style.display = 'none';

    saveSequencerState();
    updatePatternCount();
    updateSlotUI();

    showMessage('clear', 2000);
});

// ============================================
// MIDI INPUT SUPPORT
// ============================================
let midiAccess = null;
let midiInputs = [];

// MIDI note to frequency mapping (MIDI note 60 = C4)
function midiNoteToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
}

// MIDI drum mapping (GM standard drum kit on channel 10, notes 35-81)
const midiDrumMap = {
    36: 'kick',    // Bass Drum 1
    35: 'kick',    // Acoustic Bass Drum
    38: 'snare',   // Acoustic Snare
    40: 'snare',   // Electric Snare
    42: 'hihat',   // Closed Hi-Hat
    44: 'hihat',   // Pedal Hi-Hat
    46: 'hihat',   // Open Hi-Hat (played open)
    39: 'clap',    // Hand Clap
    45: 'tom1',    // Low Tom
    47: 'tom1',    // Low-Mid Tom
    48: 'tom1',    // Hi-Mid Tom
    37: 'rim',     // Side Stick
    56: 'perc',    // Cowbell
    51: 'cymbal',  // Ride Cymbal
    49: 'cymbal',  // Crash Cymbal 1
    57: 'cymbal',  // Crash Cymbal 2
};

// Held notes by channel and note number; with the sustain pedal down, a note let go waits for the pedal
const midiNotes = new Map();
const midiSustained = new Set();
let sustainPedal = false;

function releaseMidiNotes() {
    midiNotes.forEach(voice => { if (voice) voice.release(); });
    midiNotes.clear();
    midiSustained.forEach(voice => { if (voice) voice.release(); });
    midiSustained.clear();
}

function handleMIDIMessage(event) {
    const [status, data1, data2] = event.data;
    const command = status >> 4;
    const channel = status & 0xf;
    const id = channel * 128 + data1;

    if (command === 9 && data2 > 0) {
        const velocity = data2 / 127;
        // Channel 10 (index 9) is drums in GM
        if (channel === 9) {
            const drumSound = midiDrumMap[data1];
            if (drumSound) playDrum(drumSound, false, undefined, velocity, data1 === 46 ? 'open' : undefined);
            return;
        }
        const previous = midiNotes.get(id);
        if (previous) previous.release();
        lastNote = data1;
        midiNotes.set(id, playNote(midiNoteToFreq(data1), { velocity }));
        return;
    }

    if (command === 8 || (command === 9 && data2 === 0)) {
        const voice = midiNotes.get(id);
        if (voice === undefined) return;
        midiNotes.delete(id);
        if (!voice) return;
        if (sustainPedal) midiSustained.add(voice);
        else voice.release();
        return;
    }

    if (command === 0xB && data1 === 64) {
        sustainPedal = data2 >= 64;
        if (!sustainPedal) {
            midiSustained.forEach(voice => voice.release());
            midiSustained.clear();
        }
        return;
    }

    // mod wheel: vibrato up to a third of a semitone
    if (command === 0xB && data1 === 1 && vibratoDepth) {
        vibratoDepth.gain.setTargetAtTime((data2 / 127) * 35, audioContext.currentTime, 0.03);
        return;
    }

    // pitch bend: ±2 semitones
    if (command === 0xE && pitchBend) {
        const value = ((data2 << 7) | data1) - 8192;
        pitchBend.offset.setTargetAtTime((value / 8192) * 200, audioContext.currentTime, 0.008);
    }
}

function onMIDISuccess(access) {
    midiAccess = access;

    // Get all inputs
    const inputs = midiAccess.inputs.values();
    midiInputs = [];

    for (let input of inputs) {
        midiInputs.push(input);
        input.onmidimessage = handleMIDIMessage;
    }

    // Listen for new devices
    midiAccess.onstatechange = (event) => {
        if (event.port.type === 'input') {
            if (event.port.state === 'connected') {
                event.port.onmidimessage = handleMIDIMessage;
                midiInputs.push(event.port);
                showMessage('midi: ' + event.port.name);
            } else if (event.port.state === 'disconnected') {
                midiInputs = midiInputs.filter(i => i.id !== event.port.id);
                showMessage('midi disconnected');
            }
        }
    };

    if (midiInputs.length > 0) {
        showMessage('midi ready');
        console.log('MIDI inputs:', midiInputs.map(i => i.name));
    }
}

function onMIDIFailure(error) {
    console.log('MIDI access denied or not supported:', error);
}

// ============================================
// MK1 CONTROL API
// External automation interface for n0body performer
// ============================================
window.MK1 = (function() {
    // Drum pad mapping (1-8 to internal names)
    const drumMap = ['kick', 'snare', 'hihat', 'clap', 'tom1', 'perc', 'cymbal', 'rim'];

    // Extended note frequencies (C2-C7)
    const noteFrequencies = {
        'C2': 65.41, 'C#2': 69.30, 'D2': 73.42, 'D#2': 77.78,
        'E2': 82.41, 'F2': 87.31, 'F#2': 92.50, 'G2': 98.00,
        'G#2': 103.83, 'A2': 110.00, 'A#2': 116.54, 'B2': 123.47,
        'C3': 130.81, 'C#3': 138.59, 'D3': 146.83, 'D#3': 155.56,
        'E3': 164.81, 'F3': 174.61, 'F#3': 185.00, 'G3': 196.00,
        'G#3': 207.65, 'A3': 220.00, 'A#3': 233.08, 'B3': 246.94,
        'C4': 261.63, 'C#4': 277.18, 'D4': 293.66, 'D#4': 311.13,
        'E4': 329.63, 'F4': 349.23, 'F#4': 369.99, 'G4': 392.00,
        'G#4': 415.30, 'A4': 440.00, 'A#4': 466.16, 'B4': 493.88,
        'C5': 523.25, 'C#5': 554.37, 'D5': 587.33, 'D#5': 622.25,
        'E5': 659.25, 'F5': 698.46, 'F#5': 739.99, 'G5': 783.99,
        'G#5': 830.61, 'A5': 880.00, 'A#5': 932.33, 'B5': 987.77,
        'C6': 1046.50, 'C#6': 1108.73, 'D6': 1174.66, 'D#6': 1244.51,
        'E6': 1318.51, 'F6': 1396.91, 'F#6': 1479.98, 'G6': 1567.98,
        'G#6': 1661.22, 'A6': 1760.00, 'A#6': 1864.66, 'B6': 1975.53,
        'C7': 2093.00
    };

    // Waveform mapping (API names to internal names)
    const waveformMap = {
        'sine': 'sine',
        'square': 'square',
        'saw': 'sawtooth',
        'sawtooth': 'sawtooth',
        'triangle': 'triangle',
        'pulse': 'pulse',
        'noise': 'noise',
        'string': 'string',
        'voice': 'formant',
        'formant': 'formant',
        'vocoder': 'vocoder'
    };

    // Helper: clamp value to range
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    // Helper: validate pad number (1-8)
    function isValidPad(pad) {
        return Number.isInteger(pad) && pad >= 1 && pad <= 8;
    }

    // Helper: validate track number (1-8)
    function isValidTrack(track) {
        return Number.isInteger(track) && track >= 1 && track <= 8;
    }

    // Helper: validate step number (1-16)
    function isValidStep(step) {
        return Number.isInteger(step) && step >= 1 && step <= 16;
    }

    return {
        // === DRUMS ===
        drums: {
            // velocity 0-1 is optional; 1 is a full hit, as before
            hit: function(pad, velocity) {
                if (!isValidPad(pad)) return;
                const drumType = drumMap[pad - 1];
                playDrum(drumType, true, undefined, typeof velocity === 'number' ? clamp(velocity, 0, 1) : 1); // skipRecording = true for API calls
            },

            // semitones, -12 to 12; pitch and length move together, like tape
            setTune: function(pad, semitones) {
                if (!isValidPad(pad)) return;
                setPad(drumMap[pad - 1], { tune: Math.round(clamp(semitones, -12, 12)) });
            },

            // 0.2-1 of the pad's natural length
            setDecay: function(pad, value) {
                if (!isValidPad(pad)) return;
                setPad(drumMap[pad - 1], { decay: clamp(value, 0.2, 1) });
            }
        },

        // === SYNTH ===
        synth: {
            // velocity 0-1 is optional; without it notes play at full level, as before
            play: function(note, duration, velocity) {
                const freq = noteFrequencies[note];
                if (!freq) return;

                // held for duration seconds, then the release; without one it's a pluck
                playNote(freq, { skipRecording: true, hold: duration > 0 ? duration : 0, velocity: typeof velocity === 'number' ? clamp(velocity, 0, 1) : 1 });
            },

            stop: function() {
                releaseSynthVoices();
            },

            setWaveform: function(type) {
                const internalType = waveformMap[type];
                if (!internalType) return;

                if (customSelectInstances.waveType) {
                    customSelectInstances.waveType.value = internalType;
                }
            },

            setAttack: function(value) {
                // 0-1 maps to 0-500ms
                const ms = Math.round(clamp(value, 0, 1) * 500);
                attackTime = ms;

                // Update UI
                const slider = document.getElementById('attack');
                const display = document.getElementById('attackVal');
                if (slider) slider.value = ms;
                if (display) display.textContent = ms + 'ms';
            },

            setRelease: function(value) {
                // 0-1 maps to 50-2000ms
                const ms = Math.round(50 + clamp(value, 0, 1) * 1950);
                releaseTime = ms;

                // Update UI
                const slider = document.getElementById('release');
                const display = document.getElementById('releaseVal');
                if (slider) slider.value = ms;
                if (display) display.textContent = ms + 'ms';
            },

            getWaveTypes: function() {
                return ['sine', 'square', 'saw', 'triangle', 'pulse', 'noise', 'string', 'voice', 'vocoder'];
            },

            getWaveType: function() {
                return document.getElementById('waveType')?.dataset.value || 'sine';
            }
        },

        // === SEQUENCER ===
        sequencer: {
            setStep: function(track, step, active) {
                if (!isValidTrack(track) || !isValidStep(step)) return;

                const drumType = drumMap[track - 1];
                const stepIndex = step - 1;

                sequencerSteps[drumType][stepIndex] = active ? 1 : 0;

                const stepEl = document.querySelector(`.step[data-drum="${drumType}"][data-index="${stepIndex}"]`);
                if (stepEl) paintStep(stepEl, sequencerSteps[drumType][stepIndex]);
                updatePatternCount();
            },

            getStep: function(track, step) {
                if (!isValidTrack(track) || !isValidStep(step)) return false;

                const drumType = drumMap[track - 1];
                return !!sequencerSteps[drumType][step - 1];
            },

            // an accent turns the step on as well
            setAccent: function(track, step, accent) {
                if (!isValidTrack(track) || !isValidStep(step)) return;
                const drumType = drumMap[track - 1];
                const row = sequencerSteps[drumType];
                row[step - 1] = accent ? 2 : row[step - 1] ? 1 : 0;
                const stepEl = document.querySelector(`.step[data-drum="${drumType}"][data-index="${step - 1}"]`);
                if (stepEl) paintStep(stepEl, row[step - 1]);
                updatePatternCount();
            },

            // the keys row: note like 'C4', or null to clear the step
            setNote: function(step, note) {
                if (!isValidStep(step)) return;
                const freq = note ? noteFrequencies[note] : null;
                if (note && !freq) return;
                sequencerSteps.keys[step - 1] = freq ? freqMidi(freq) : null;
                const stepEl = document.querySelector(`.step[data-drum="keys"][data-index="${step - 1}"]`);
                if (stepEl) paintStep(stepEl, sequencerSteps.keys[step - 1]);
                updatePatternCount();
            },

            getNote: function(step) {
                if (!isValidStep(step)) return null;
                const midi = sequencerSteps.keys[step - 1];
                return midi === null ? null : noteName(midi).toUpperCase();
            },

            clearTrack: function(track) {
                if (!isValidTrack(track)) return;

                const drumType = drumMap[track - 1];
                sequencerSteps[drumType] = Array(16).fill(0);
                updateSequencerUI();
                updatePatternCount();
            },

            clearAll: function() {
                clearPattern();
                updatePatternCount();
            },

            start: function() {
                if (isPlaying) return;
                if (audioLoaded) {
                    toggleSequencer(true); // skipRecording = true for API calls
                } else {
                    initSystem().then(() => {
                        if (!isPlaying) toggleSequencer(true);
                    });
                }
            },

            stop: function() {
                if (isPlaying) {
                    stopSequencer();
                }
            },

            isPlaying: function() {
                return isPlaying;
            },

            // 0-1: straight to an MPC's 75%
            setSwing: function(value) {
                const v = clamp(value, 0, 1);
                swing = v;
                const slider = document.getElementById('swing');
                const display = document.getElementById('swingVal');
                if (slider) slider.value = Math.round(v * 100);
                if (display) display.textContent = Math.round(v * 100) + '%';
            },

            getSwing: function() {
                return swing;
            }
        },

        // === FX ===
        fx: {
            setReverb: function(value) {
                const v = clamp(value, 0, 1);
                if (window.reverbMix) {
                    setParam(window.reverbMix.gain, v);
                }

                // Update UI
                const slider = document.getElementById('reverb');
                const display = document.getElementById('reverbVal');
                if (slider) slider.value = Math.round(v * 100);
                if (display) display.textContent = Math.round(v * 100) + '%';
            },

            setDelay: function(value) {
                const v = clamp(value, 0, 1);
                if (window.delayMix) {
                    setParam(window.delayMix.gain, v);
                }

                // Update UI
                const slider = document.getElementById('delay');
                const display = document.getElementById('delayVal');
                if (slider) slider.value = Math.round(v * 100);
                if (display) display.textContent = Math.round(v * 100) + '%';
            },

            setFilter: function(value) {
                // 0-1 maps to 100-20000Hz, linear, as n0body learned it; the slider shows it on its log scale
                const freq = Math.round(100 + clamp(value, 0, 1) * 19900);
                if (window.filterNode && audioContext) {
                    setParam(window.filterNode.frequency, freq);
                }

                // Update UI
                const slider = document.getElementById('filter');
                const display = document.getElementById('filterVal');
                if (slider) slider.value = filterPosition(freq);
                if (display) display.textContent = freq + 'Hz';
            },

            setDistortion: function(value) {
                const v = clamp(value, 0, 1);
                applyDistortion(v);

                // Update UI
                const slider = document.getElementById('distort');
                const display = document.getElementById('distortVal');
                if (slider) slider.value = Math.round(v * 100);
                if (display) display.textContent = Math.round(v * 100) + '%';
            },

            setChorus: function(value) {
                const v = clamp(value, 0, 1);
                applyChorus(v);

                // Update UI
                const slider = document.getElementById('chorus');
                const display = document.getElementById('chorusVal');
                if (slider) slider.value = Math.round(v * 100);
                if (display) display.textContent = Math.round(v * 100) + '%';
            },

            setCrush: function(value) {
                // 0-1 maps to the slider's 0-8: fewer bits and a lower sample rate together
                const crushVal = Math.round(clamp(value, 0, 1) * 8);
                applyCrush(crushVal);

                // Update UI
                const slider = document.getElementById('crush');
                const display = document.getElementById('crushVal');
                if (slider) slider.value = crushVal;
                if (display) display.textContent = crushVal;
            }
        },

        // === TEMPO ===
        tempo: {
            setBPM: function(value) {
                const bpm = Math.round(clamp(value, 60, 200));

                // Update UI and trigger tempo change
                const slider = document.getElementById('tempo');
                if (slider) {
                    slider.value = bpm;
                    slider.dispatchEvent(new Event('input'));
                }
            },

            getBPM: function() {
                const slider = document.getElementById('tempo');
                return slider ? parseInt(slider.value) : 120;
            }
        },

        // === MASTER ===
        master: {
            setVolume: function(value) {
                const v = clamp(value, 0, 1);
                setMasterVolume(v);

                // Update UI
                const slider = document.getElementById('masterVol');
                const display = document.getElementById('masterVolVal');
                if (slider) slider.value = Math.round(v * 100);
                if (display) display.textContent = Math.round(v * 100) + '%';
            },

            getVolume: function() {
                return masterGain ? masterGain.gain.value : 0.7;
            }
        },

        // === LOOPER ===
        looper: {
            // Helper: normalize slot name to uppercase
            _normalizeSlot: function(slot) {
                if (typeof slot !== 'string') return null;
                const normalized = slot.toUpperCase();
                if (['A', 'B', 'C', 'D'].includes(normalized)) {
                    return normalized;
                }
                return null;
            },

            // Start recording on a slot
            record: function(slot) {
                const normalizedSlot = this._normalizeSlot(slot);
                if (!normalizedSlot) return;

                // Initialize audio if needed
                if (!audioContext) {
                    initSystem();
                }

                if (isOverdub) return;
                if (isRecording) stopRecording();

                // Switch to the target slot
                activeSlot = normalizedSlot;
                document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('active'));
                const slotBtn = document.querySelector(`[data-slot="${normalizedSlot}"]`);
                if (slotBtn) slotBtn.classList.add('active');

                // Start recording (clear existing content)
                startRecording();
            },

            // Stop current recording
            stopRecording: function() {
                if (isRecording) {
                    stopRecording();
                }
                if (isOverdub) {
                    stopOverdub();
                }
                updateSlotUI();
            },

            // Check if currently recording
            isRecording: function() {
                return isRecording || isOverdub;
            },

            // Play a specific slot
            play: function(slot) {
                const normalizedSlot = this._normalizeSlot(slot);
                if (!normalizedSlot) return;

                initSystem();
                startSlot(normalizedSlot, audioContext.currentTime);
                updateSlotUI();
            },

            // Play all slots with content
            playAll: function() {
                initSystem();
                const when = audioContext.currentTime;
                Object.keys(loopSlots).forEach(slotKey => startSlot(slotKey, when));
                updateSlotUI();
            },

            // Stop a specific slot
            stop: function(slot) {
                const normalizedSlot = this._normalizeSlot(slot);
                if (!normalizedSlot) return;

                stopSlot(normalizedSlot);
                updateSlotUI();
            },

            // Stop all slots
            stopAll: function() {
                Object.keys(loopSlots).forEach(stopSlot);
                updateSlotUI();
            },

            // Check if a slot is playing
            isPlaying: function(slot) {
                const normalizedSlot = this._normalizeSlot(slot);
                if (!normalizedSlot) return false;
                return loopSlots[normalizedSlot].isPlaying || false;
            },

            // Add layer (overdub) to existing slot
            addLayer: function(slot) {
                const normalizedSlot = this._normalizeSlot(slot);
                if (!normalizedSlot) return;

                if (!audioContext) {
                    initSystem();
                }

                // Switch to target slot
                activeSlot = normalizedSlot;
                document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('active'));
                const slotBtn = document.querySelector(`[data-slot="${normalizedSlot}"]`);
                if (slotBtn) slotBtn.classList.add('active');

                // Start overdub (keeps existing content)
                if (!isOverdub && !isRecording) {
                    startOverdub();
                }
                updateSlotUI();
            },

            // Clear a specific slot
            clear: function(slot) {
                const normalizedSlot = this._normalizeSlot(slot);
                if (!normalizedSlot) return;

                clearSlot(normalizedSlot);
                updateSlotUI();
            },

            // Clear all slots
            clearAll: function() {
                Object.keys(loopSlots).forEach(clearSlot);
                updateSlotUI();
                document.getElementById('downloadBtn').style.display = 'none';
            },

            // Get status of a specific slot
            getSlotStatus: function(slot) {
                const normalizedSlot = this._normalizeSlot(slot);
                if (!normalizedSlot) return null;

                const slotData = loopSlots[normalizedSlot];
                return {
                    hasContent: slotData.loop.length > 0 || slotData.audioBuffer !== null,
                    isPlaying: slotData.isPlaying || false,
                    duration: slotData.duration || 0,
                    events: slotData.loop.length,
                    hasAudio: slotData.audioBuffer !== null
                };
            },

            // Get status of all slots
            getAllStatus: function() {
                const status = {};
                Object.keys(loopSlots).forEach(slotKey => {
                    status[slotKey.toLowerCase()] = this.getSlotStatus(slotKey);
                });
                status.activeSlot = activeSlot.toLowerCase();
                status.isRecording = isRecording;
                status.isOverdub = isOverdub;
                return status;
            }
        },

        // === ON AIR ===
        air: {
            // Resolves with { id, link } once the room is live; rejects with err.code ('unreachable', 'refused', 'full', 'end'…)
            start: function(opts) {
                return airStart(opts);
            },

            stop: function() {
                airStop();
            },

            // state: 'off' | 'connecting' | 'waking' | 'live' | 'reconnecting'
            status: function() {
                return airState();
            }
        },

        // === UTILITY ===
        utils: {
            getState: function() {
                return {
                    isActive: isActive,
                    isPlaying: isPlaying,
                    currentStep: currentStep,
                    tempo: MK1.tempo.getBPM(),
                    volume: MK1.master.getVolume(),
                    waveform: document.getElementById('waveType')?.dataset.value || 'sine',
                    attack: attackTime,
                    release: releaseTime,
                    fx: {
                        reverb: window.reverbMix?.gain.value || 0,
                        delay: window.delayMix?.gain.value || 0,
                        filter: window.filterNode?.frequency.value || 10000,
                        distortion: (window.distortionMix?.gain.value || 0) / DISTORTION_MAKEUP,
                        chorus: (window.chorusMix?.gain.value || 0) / 0.6
                    },
                    swing: swing,
                    sequencer: JSON.parse(JSON.stringify(sequencerSteps)),
                    looper: MK1.looper.getAllStatus()
                };
            },

            init: function() {
                return initSystem();
            },

            // Audio health monitoring
            getHealth: function() {
                return {
                    contextState: audioContext ? audioContext.state : 'not initialized',
                    sampleRate: audioContext ? audioContext.sampleRate : 0,
                    currentTime: audioContext ? audioContext.currentTime : 0,
                    activeDrumVoices: activeDrumVoices.length,
                    activeSynthVoices: activeSynthVoices.length,
                    limits: VOICE_LIMITS,
                    healthy: audioContext && audioContext.state === 'running'
                };
            },

            // Force cleanup of all voices (emergency)
            forceCleanup: function() {
                activeDrumVoices.forEach(voice => cleanupVoice(voice));
                activeSynthVoices.forEach(voice => cleanupVoice(voice));
                activeDrumVoices = [];
                activeSynthVoices = [];
                console.log('[MK1] Force cleanup completed');
            },

            // Resume audio context if suspended
            resume: function() {
                if (audioContext && audioContext.state === 'suspended') {
                    audioContext.resume();
                    return true;
                }
                return false;
            }
        }
    };
})();
