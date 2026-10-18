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

    // Get current value
    get value() {
        return this.element.dataset.value;
    }

    // Set value programmatically
    set value(newValue) {
        const option = Array.from(this.options).find(opt => opt.dataset.value === newValue);
        if (option) {
            this.select(option);
        }
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
    DELAY_TIME: 0.3,
    DELAY_FEEDBACK: 0.3,
    REVERB_TIME: 2,
    DEFAULT_FILTER_FREQ: 10000,
    DEFAULT_TEMPO: 120,
    SEQUENCER_STEPS: 16,
    LOOP_SLOTS_COUNT: 4
};

const SYNTH_DEFAULTS = {
    ATTACK_MS: 10,
    RELEASE_MS: 300,
    GAIN: 0.3
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

const LAYER_SEARCH = 0.06;

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
        tanh15: createTanhCurve(1.5),
        tanh18: createTanhCurve(1.8),
        tanh20: createTanhCurve(2.0),
        tanh25: createTanhCurve(2.5),
        tanh40: createTanhCurve(4.0),
        // Hard clip curve
        hardClip: createHardClipCurve(0.8, 3)
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

// Register a new synth voice and limit active voices
function registerSynthVoice(nodes, duration) {
    const voice = {
        nodes: nodes,
        endTime: audioContext.currentTime + duration,
        animationIds: []
    };

    activeSynthVoices.push(voice);

    // If over limit, cleanup oldest voice
    while (activeSynthVoices.length > VOICE_LIMITS.MAX_SYNTH_VOICES) {
        const oldest = activeSynthVoices.shift();
        cleanupVoice(oldest);
    }

    // Schedule cleanup
    setTimeout(() => {
        const index = activeSynthVoices.indexOf(voice);
        if (index > -1) {
            activeSynthVoices.splice(index, 1);
            cleanupVoice(voice);
        }
    }, duration * 1000 + 100);

    return voice;
}

function releaseSynthVoices() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const voices = activeSynthVoices;
    activeSynthVoices = [];

    voices.forEach(voice => {
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

// Stop voice cleanup (for cleanup on page unload)
function stopVoiceCleanup() {
    if (cleanupIntervalId) {
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
    }
}

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
    A: { loop: [], audioBlob: null, audioBuffer: null, duration: 0, loopSamples: 0, isPlaying: false, playback: null },
    B: { loop: [], audioBlob: null, audioBuffer: null, duration: 0, loopSamples: 0, isPlaying: false, playback: null },
    C: { loop: [], audioBlob: null, audioBuffer: null, duration: 0, loopSamples: 0, isPlaying: false, playback: null },
    D: { loop: [], audioBlob: null, audioBuffer: null, duration: 0, loopSamples: 0, isPlaying: false, playback: null }
};
let activeSlot = 'A';
let isRecording = false;
let recordingStart = 0;
let recordingSlot = 'A';
let isOverdub = false;
let overdubLength = 0;
let overdubStop = null;
let demoSlot = null;

let mediaRecorder;
let mediaStreamDestination;

let sequencerSteps = {
    kick: Array(16).fill(false),
    snare: Array(16).fill(false),
    hihat: Array(16).fill(false),
    clap: Array(16).fill(false),
    tom1: Array(16).fill(false),
    perc: Array(16).fill(false),
    cymbal: Array(16).fill(false),
    rim: Array(16).fill(false)
};
let currentStep = 0;
let isPlaying = false;
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

function updateSequencerUI() {
    document.querySelectorAll('.step').forEach(step => {
        const drum = step.dataset.drum;
        const index = parseInt(step.dataset.index);
        if (sequencerSteps[drum][index]) {
            step.classList.add('active');
        } else {
            step.classList.remove('active');
        }
    });
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
function startMediaRecording() {
    const slotKey = recordingSlot;
    const looped = loopSlots[slotKey].audioBuffer;
    const under = isOverdub && looped ? looped.getChannelData(0).subarray(0, Math.round(overdubLength * looped.sampleRate)) : null;
    const chunks = [];
    document.getElementById('downloadBtn').style.display = 'none';

    mediaRecorder = new MediaRecorder(mediaStreamDestination.stream);

    mediaRecorder.ondataavailable = (event) => {
        chunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
        const slot = loopSlots[slotKey];
        const blob = new Blob(chunks, { type: 'audio/webm' });
        slot.audioBlob = blob;

        try {
            const arrayBuffer = await blob.arrayBuffer();
            const take = await audioContext.decodeAudioData(arrayBuffer);
            const audioBuffer = under && slot.loopSamples > 0 ? alignLayer(take, under, slot.loopSamples) : take;
            slot.audioBuffer = audioBuffer;
            slot.loopSamples = Math.min(slot.loopSamples || audioBuffer.length, audioBuffer.length);
            slot.duration = slot.loopSamples / audioBuffer.sampleRate;
            if (slot.playback) swapSlotPlayback(slotKey);
        } catch (error) {
            console.error('Error decoding audio:', error);
        }

        updateSlotUI();
    };

    mediaRecorder.start();
}

// The recorder starts on its own clock and the limiter looks ahead, so a layer is placed by finding the loop it was played over inside the take
function layerOffset(take, under, sampleRate) {
    const block = 32;
    const reach = Math.round(LAYER_SEARCH * sampleRate);
    const span = Math.min(under.length, take.length - reach);
    if (span <= 0) return 0;

    const energy = (data, length) => {
        const env = new Float32Array(Math.ceil(length / block));
        for (let i = 0; i < length; i++) env[Math.floor(i / block)] += Math.abs(data[i]);
        return env;
    };
    const envTake = energy(take, take.length);
    const envUnder = energy(under, span);
    const blocks = Math.ceil(reach / block);

    let coarse = 0;
    let best = 0;
    for (let lag = -blocks; lag <= blocks; lag++) {
        let sum = 0;
        for (let i = Math.max(0, -lag); i < envUnder.length && i + lag < envTake.length; i++) {
            sum += envUnder[i] * envTake[i + lag];
        }
        if (sum > best) {
            best = sum;
            coarse = lag * block;
        }
    }

    const fineSpan = Math.min(span, sampleRate * 2);
    let offset = coarse;
    best = 0;
    for (let lag = coarse - 2 * block; lag <= coarse + 2 * block; lag++) {
        let sum = 0;
        for (let i = Math.max(0, -lag); i < fineSpan && i + lag < take.length; i++) {
            sum += under[i] * take[i + lag];
        }
        if (sum > best) {
            best = sum;
            offset = lag;
        }
    }
    return offset;
}

function alignLayer(take, under, length) {
    const offset = layerOffset(take.getChannelData(0), under, take.sampleRate);
    const aligned = audioContext.createBuffer(take.numberOfChannels, length, take.sampleRate);
    for (let ch = 0; ch < take.numberOfChannels; ch++) {
        const source = take.getChannelData(ch);
        const target = aligned.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            const j = i + offset < 0 ? i + offset + length : i + offset;
            target[i] = j < source.length ? source[j] : 0;
        }
    }
    return aligned;
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

        analyser = audioContext.createAnalyser();
        analyser.fftSize = AUDIO_CONSTANTS.ANALYSER_FFT_SIZE;
        
        const delayNode = audioContext.createDelay();
        delayNode.delayTime.value = AUDIO_CONSTANTS.DELAY_TIME;
        const delayFeedback = audioContext.createGain();
        delayFeedback.gain.value = AUDIO_CONSTANTS.DELAY_FEEDBACK;
        const delayMix = audioContext.createGain();
        delayMix.gain.value = 0;
        
        delayNode.connect(delayFeedback);
        delayFeedback.connect(delayNode);
        delayNode.connect(delayMix);
        
        const reverbNode = audioContext.createConvolver();
        const reverbMix = audioContext.createGain();
        reverbMix.gain.value = 0;
        
        const reverbTime = AUDIO_CONSTANTS.REVERB_TIME;
        const sampleRate = audioContext.sampleRate;
        const length = sampleRate * reverbTime;
        const impulse = audioContext.createBuffer(2, length, sampleRate);
        const impulseL = impulse.getChannelData(0);
        const impulseR = impulse.getChannelData(1);
        
        for (let i = 0; i < length; i++) {
            const decay = Math.pow(1 - i / length, 2);
            impulseL[i] = (Math.random() * 2 - 1) * decay;
            impulseR[i] = (Math.random() * 2 - 1) * decay;
        }
        reverbNode.buffer = impulse;
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

        masterGain.connect(delayNode);
        masterGain.connect(reverbNode);
        masterGain.connect(filterNode);
        delayMix.connect(filterNode);
        reverbMix.connect(filterNode);
        filterNode.connect(limiter);
        limiter.connect(limiterTrim);
        limiterTrim.connect(ceiling);
        ceiling.connect(analyser);
        analyser.connect(audioContext.destination);

        // Recorded loops already carry the FX and master level, so they join after the FX chain, still under the limiter
        loopBus = audioContext.createGain();
        loopBus.connect(limiter);

        // Distortion
        const distortionNode = audioContext.createWaveShaper();
        distortionNode.curve = makeDistortionCurve(0);
        distortionNode.oversample = '4x';
        const distortionMix = audioContext.createGain();
        distortionMix.gain.value = 0;

        masterGain.connect(distortionNode);
        distortionNode.connect(distortionMix);
        distortionMix.connect(filterNode);

        // Bitcrusher - try AudioWorklet first, fallback to ScriptProcessor
        let crushAmount = 0;
        let bitcrusherNode;
        const bitcrusherMix = audioContext.createGain();
        bitcrusherMix.gain.value = 0;

        // Async setup for AudioWorklet with fallback
        async function setupBitcrusher() {
            if (audioContext.audioWorklet) {
                try {
                    await audioContext.audioWorklet.addModule('bitcrusher-processor.js');
                    bitcrusherNode = new AudioWorkletNode(audioContext, 'bitcrusher-processor');

                    window.setCrushAmount = (val) => {
                        crushAmount = val;
                        bitcrusherNode.port.postMessage({ crushAmount: val });
                    };

                    masterGain.connect(bitcrusherNode);
                    bitcrusherNode.connect(bitcrusherMix);
                    bitcrusherMix.connect(filterNode);

                    console.log('Bitcrusher: using AudioWorklet');
                    return;
                } catch (e) {
                    console.warn('AudioWorklet failed, falling back to ScriptProcessor:', e);
                }
            }

            // Fallback to ScriptProcessorNode
            bitcrusherNode = audioContext.createScriptProcessor(4096, 1, 1);
            bitcrusherNode.onaudioprocess = function(e) {
                const input = e.inputBuffer.getChannelData(0);
                const output = e.outputBuffer.getChannelData(0);
                if (crushAmount === 0) {
                    for (let i = 0; i < input.length; i++) {
                        output[i] = input[i];
                    }
                } else {
                    const step = Math.pow(0.5, 16 - crushAmount);
                    for (let i = 0; i < input.length; i++) {
                        output[i] = Math.round(input[i] / step) * step;
                    }
                }
            };

            window.setCrushAmount = (val) => { crushAmount = val; };

            masterGain.connect(bitcrusherNode);
            bitcrusherNode.connect(bitcrusherMix);
            bitcrusherMix.connect(filterNode);

            console.log('Bitcrusher: using ScriptProcessor (fallback)');
        }

        // Start async setup (connects when ready)
        const bitcrusherReady = setupBitcrusher();

        window.bitcrusherMix = bitcrusherMix;

        // Karplus-Strong worklet registration
        window.karplusStrongReady = false;
        const karplusReady = audioContext.audioWorklet
            ? audioContext.audioWorklet.addModule('karplus-strong-processor.js').then(() => {
                window.karplusStrongReady = true;
            }).catch(() => {})
            : Promise.resolve();

        // Drum engine worklet registration
        window.drumEngineReady = false;
        const drumEngineLoaded = (async () => {
            if (!audioContext.audioWorklet) return;
            try {
                await audioContext.audioWorklet.addModule('drum-engine-processor.js');
                const drumEngine = new AudioWorkletNode(audioContext, 'drum-engine-processor');
                drumEngine.connect(masterGain);
                window.drumEngine = drumEngine;
                window.drumEngineReady = true;
            } catch(e) {
                console.warn('Drum engine worklet failed, using fallback:', e);
                window.drumEngineReady = false;
            }
        })();

        audioReady = Promise.all([bitcrusherReady, karplusReady, drumEngineLoaded]).then(() => {
            audioLoaded = true;
            applySliders();
        });

        // Chorus effect using modulated delay
        const chorusDelay = audioContext.createDelay();
        chorusDelay.delayTime.value = 0.03; // 30ms base delay
        const chorusLFO = audioContext.createOscillator();
        const chorusLFOGain = audioContext.createGain();
        const chorusMix = audioContext.createGain();

        chorusLFO.type = 'sine';
        chorusLFO.frequency.value = 1.5; // 1.5 Hz modulation
        chorusLFOGain.gain.value = 0.002; // Small modulation depth
        chorusMix.gain.value = 0;

        chorusLFO.connect(chorusLFOGain);
        chorusLFOGain.connect(chorusDelay.delayTime);
        chorusLFO.start();

        masterGain.connect(chorusDelay);
        chorusDelay.connect(chorusMix);
        chorusMix.connect(filterNode);

        window.delayMix = delayMix;
        window.reverbMix = reverbMix;
        window.filterNode = filterNode;
        window.distortionNode = distortionNode;
        window.distortionMix = distortionMix;
        // bitcrusherNode and setCrushAmount are set in setupBitcrusher()
        window.chorusMix = chorusMix;
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

function playDrum(type, skipRecording = false, time) {
    if (!audioLoaded) {
        initSystem().then(() => playDrum(type, skipRecording, time));
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
            time: now - recordingStart
        });
    }

    if (window.drumEngineReady && window.drumEngine) {
        window.drumEngine.port.postMessage({ type: 'trigger', voice: type, time: now });
        return;
    }

    const nodes = []; // Track all nodes for cleanup
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
            clickGain.connect(masterGain);
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
            bodyGain.connect(masterGain);
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
            subGain.connect(masterGain);
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
            crackGain.connect(masterGain);
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
            bodyGain.connect(masterGain);
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
            noiseGain.connect(masterGain);
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
            metalGain.connect(masterGain);
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
            noiseGain.connect(masterGain);
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
                burstGain.connect(masterGain);
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
            tailGain.connect(masterGain);
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
            bodyGain.connect(masterGain);
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
            overGain.connect(masterGain);
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
            clickGain.connect(masterGain);
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
            outputGain.connect(masterGain);
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
            metalGain.connect(masterGain);
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
            noiseGain.connect(masterGain);
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
            clickGain.connect(masterGain);
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
            bodyGain.connect(masterGain);
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

function playNote(freq, skipRecording = false, time, releaseMs = releaseTime, wave = document.getElementById('waveType').dataset.value) {
    if (!audioContext) {
        initSystem();
    }

    if (wave === 'string' && !audioLoaded) {
        audioReady.then(() => playNote(freq, skipRecording, time, releaseMs, wave));
        return;
    }

    // The vocoder has nothing to shape without the mic; a played note asks for it, a loop or the API stays silent
    if (wave === 'vocoder' && !micSource) {
        if (!skipRecording) {
            toggleMic();
            const micBtn = document.getElementById('micBtn');
            micBtn.classList.add('blink');
            setTimeout(() => micBtn.classList.remove('blink'), 1500);
        }
        return;
    }

    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    const now = Math.max(time || 0, audioContext.currentTime);

    const noteEntry = Object.entries(notes).find(([key, f]) => f === freq);
    if (noteEntry) {
        const [noteName] = noteEntry;
        flash(document.querySelector(`[data-note="${noteName}"]`), now, 200);
    }

    const attack = attackTime / 1000;
    const release = Math.max(releaseMs / 1000, attack + 0.05);
    const tail = wave === 'string' ? Math.max(release, 1.5) : release;
    const nodes = []; // Track all nodes for cleanup
    const curves = initSharedCurves();
    let voiceAnimationIds = []; // Track animation frames for vocoder

    // Main output gain with ADSR
    const outputGain = audioContext.createGain();
    outputGain.gain.value = 0;
    outputGain.gain.setValueAtTime(0, now);
    outputGain.gain.linearRampToValueAtTime(0.28, now + attack);
    const sustainTime = Math.min(tail * 0.3, 0.2, (tail - attack) / 2);
    outputGain.gain.linearRampToValueAtTime(0.2, now + attack + sustainTime);
    outputGain.gain.exponentialRampToValueAtTime(0.001, now + tail);
    nodes.push(outputGain);

    // Filter with envelope
    const filter = audioContext.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2;
    const filterBase = Math.min(freq * 1.5, 800);
    const filterPeak = Math.min(freq * 8, 12000);
    filter.frequency.setValueAtTime(filterBase, now);
    filter.frequency.linearRampToValueAtTime(filterPeak, now + attack * 0.8);
    filter.frequency.exponentialRampToValueAtTime(filterBase, now + release * 0.8);
    nodes.push(filter);

    // Soft saturation (use shared curve)
    const saturator = audioContext.createWaveShaper();
    saturator.curve = curves.tanh18;
    saturator.connect(filter);
    filter.connect(outputGain);
    outputGain.connect(masterGain);
    nodes.push(saturator);

    if (wave === 'noise') {
        const noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * release, audioContext.sampleRate);
        const noiseData = noiseBuffer.getChannelData(0);
        for (let i = 0; i < noiseBuffer.length; i++) noiseData[i] = Math.random() * 2 - 1;
        const noiseSource = audioContext.createBufferSource();
        noiseSource.buffer = noiseBuffer;
        const noiseFilter = audioContext.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.value = freq;
        noiseFilter.Q.value = 15;
        noiseFilter.frequency.setValueAtTime(freq * 2, now);
        noiseFilter.frequency.exponentialRampToValueAtTime(freq, now + release * 0.3);
        noiseSource.connect(noiseFilter);
        noiseFilter.connect(saturator);
        noiseSource.start(now);
        noiseSource.stop(now + release);
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
        osc1.start(now);
        osc2.start(now);
        subOsc.start(now);
        osc1.stop(now + release);
        osc2.stop(now + release);
        subOsc.stop(now + release);
        nodes.push(osc1, osc2, pulseGain, subOsc, subGain);

    } else if (wave === 'string') {
        const duration = tail;
        const bodyFilter = audioContext.createBiquadFilter();
        bodyFilter.type = 'peaking';
        bodyFilter.frequency.setValueAtTime(freq * 2, now);
        bodyFilter.Q.value = 1;
        bodyFilter.gain.value = 3;
        const stringGain = audioContext.createGain();
        stringGain.gain.setValueAtTime(0.6, now);
        stringGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

        if (window.karplusStrongReady) {
            const karplusNode = new AudioWorkletNode(audioContext, 'karplus-strong-processor', {
                processorOptions: { frequency: freq }
            });
            karplusNode.connect(bodyFilter);
            bodyFilter.connect(stringGain);
            stringGain.connect(saturator);
            setTimeout(() => {
                karplusNode.port.postMessage({ stop: true });
            }, (now + duration - audioContext.currentTime) * 1000);
            nodes.push(karplusNode, bodyFilter, stringGain);
        } else {
            // Fallback: pre-computed buffer for environments without AudioWorklet
            const sampleRate = audioContext.sampleRate;
            const period = Math.round(sampleRate / freq);
            const bufferSize = Math.ceil(sampleRate * duration);
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
            bodyFilter.connect(stringGain);
            stringGain.connect(saturator);
            source.start(now);
            source.stop(now + duration);
            nodes.push(source, bodyFilter, stringGain);
        }

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
        formantMix.connect(saturator);
        source.start(now);
        source2.start(now);
        lfo.start(now);
        source.stop(now + release);
        source2.stop(now + release);
        lfo.stop(now + release);
        nodes.push(lfo, lfoGain);

    } else if (wave === 'vocoder') {
        // Simplified vocoder - fewer bands for performance
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
        nodes.push(carrier, carrier2, carrierMix, vocoderMix, micTap);
        bandFreqs.forEach(bandFreq => {
            const analysisFilter = audioContext.createBiquadFilter();
            analysisFilter.type = 'bandpass';
            analysisFilter.frequency.value = bandFreq;
            analysisFilter.Q.value = 4;
            const synthFilter = audioContext.createBiquadFilter();
            synthFilter.type = 'bandpass';
            synthFilter.frequency.value = bandFreq;
            synthFilter.Q.value = 6;
            const vca = audioContext.createGain();
            vca.gain.value = 0;
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 128;
            analyser.smoothingTimeConstant = 0.5;
            micTap.connect(analysisFilter);
            analysisFilter.connect(analyser);
            carrierMix.connect(synthFilter);
            synthFilter.connect(vca);
            vca.connect(vocoderMix);
            nodes.push(analysisFilter, synthFilter, vca, analyser);
            const dataArray = new Float32Array(analyser.fftSize);
            const updateEnvelope = () => {
                if (audioContext.currentTime > now + release) return;
                analyser.getFloatTimeDomainData(dataArray);
                let sum = 0;
                for (let j = 0; j < dataArray.length; j++) sum += dataArray[j] * dataArray[j];
                vca.gain.setTargetAtTime(Math.min(Math.sqrt(sum / dataArray.length) * 6, 1), audioContext.currentTime, 0.02);
                voiceAnimationIds.push(requestAnimationFrame(updateEnvelope));
            };
            voiceAnimationIds.push(requestAnimationFrame(updateEnvelope));
        });
        vocoderMix.connect(saturator);
        carrier.start(now);
        carrier2.start(now);
        carrier.stop(now + release);
        carrier2.stop(now + release);

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
            osc.start(now);
            osc.stop(now + release);
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
        subOsc.start(now);
        driftLFO.start(now);
        subOsc.stop(now + release);
        driftLFO.stop(now + release);
        nodes.push(subOsc, subGain, driftLFO, driftGain);
    }

    // Register voice for cleanup
    const voice = registerSynthVoice(nodes, now - audioContext.currentTime + tail + 0.2);
    voice.animationIds = voiceAnimationIds;
    voice.out = outputGain;

    if (!skipRecording && (isRecording || isOverdub)) {
        loopSlots[recordingSlot].loop.push({
            type: 'synth',
            freq: freq,
            wave: wave,
            time: now - recordingStart
        });
    }
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

document.querySelectorAll('.pad').forEach(pad => {
    addPressHandler(pad, function() {
        const sound = this.dataset.sound;
        playDrum(sound);
    });
});

document.querySelectorAll('.key').forEach(key => {
    addPressHandler(key, function() {
        const note = this.dataset.note;
        playNote(notes[note]);
    });
});

const sequencer = document.getElementById('sequencer');
const drums = ['kick', 'snare', 'hihat', 'clap', 'tom1', 'perc', 'cymbal', 'rim'];

drums.forEach(drum => {
    const stepsContainer = document.querySelector(`.seq-steps[data-drum="${drum}"]`);
    for (let i = 0; i < 16; i++) {
        const step = document.createElement('div');
        step.className = 'step';
        step.dataset.drum = drum;
        step.dataset.index = i;
        addPressHandler(step, function() {
            sequencerSteps[drum][i] = !sequencerSteps[drum][i];
            this.classList.toggle('active');
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
        const time = nextStepTime;

        if (time > audioContext.currentTime - SCHEDULER.LATE) {
            drums.forEach(drum => {
                if (sequencerSteps[drum][step]) {
                    playDrum(drum, false, time);
                }
            });

            const run = seqRun;
            setTimeout(() => {
                if (run === seqRun) showStep(step);
            }, Math.max(0, (time - audioContext.currentTime) * 1000));
        }

        currentStep = (currentStep + 1) % 16;
        nextStepTime += 60 / parseInt(document.getElementById('tempo').value) / 4;
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
    drums.forEach(drum => {
        sequencerSteps[drum] = Array(16).fill(false);
    });
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    saveSequencerState();
    updatePatternCount();
});

function startRecording() {
    recordingSlot = activeSlot;
    stopSlot(recordingSlot);
    if (recordingSlot === demoSlot) demoSlot = null;

    isRecording = true;
    isOverdub = false;
    recordingStart = audioContext.currentTime;
    loopSlots[recordingSlot].loop = [];
    loopSlots[recordingSlot].loopSamples = 0;

    startMediaRecording();

    document.getElementById('recordBtn').textContent = 'recording...';
    document.getElementById('recordBtn').classList.add('active');
    document.getElementById('recStatus').textContent = 'on';
    updateSlotUI();
}

function stopRecording() {
    isRecording = false;
    loopSlots[recordingSlot].loopSamples = Math.round((audioContext.currentTime - recordingStart) * audioContext.sampleRate);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
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

    startMediaRecording();

    document.getElementById('overdubBtn').textContent = 'layering...';
    document.getElementById('overdubBtn').classList.add('active');
    document.getElementById('recStatus').textContent = 'overdub';
    updateSlotUI();
}

function stopOverdub() {
    if (overdubStop) return;

    const now = audioContext.currentTime;
    const recorder = mediaRecorder;
    let stopAt = now;
    if (overdubLength > 0) {
        const cycles = Math.max(1, Math.ceil((now - recordingStart) / overdubLength));
        stopAt = recordingStart + cycles * overdubLength;
    }

    const finish = () => {
        overdubStop = null;
        isOverdub = false;
        loopSlots[recordingSlot].loopSamples = Math.round((stopAt - recordingStart) * audioContext.sampleRate);
        if (recorder && recorder.state !== 'inactive') {
            recorder.stop();
        }
        document.getElementById('overdubBtn').textContent = 'add layer';
        document.getElementById('overdubBtn').classList.remove('active');
        document.getElementById('recStatus').textContent = 'off';
    };

    if (stopAt <= now) {
        finish();
        return;
    }

    // The layer closes on the loop boundary so the new take keeps whole cycles; the extra time covers the recorder delay that alignLayer trims from the start
    overdubStop = setTimeout(finish, (stopAt - now + LAYER_SEARCH) * 1000 + 50);
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
                playDrum(event.sound, true, time);
            } else if (event.type === 'synth') {
                playNote(event.freq, true, time, undefined, event.wave);
            }
        }
        playback.index++;
    }
}

function clearSlot(key) {
    stopSlot(key);
    const slot = loopSlots[key];
    slot.loop = [];
    slot.audioBlob = null;
    slot.audioBuffer = null;
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
    const blob = loopSlots[activeSlot].audioBlob;
    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tempo = document.getElementById('tempo').value;
    a.download = `playground-mk1-${activeSlot}-${tempo}bpm-${timestamp}.webm`;
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
        .filter(([key, slot]) => slot.audioBlob !== null);

    if (slotsWithContent.length === 0) {
        showMessage('no audio to export');
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tempo = document.getElementById('tempo').value;

    slotsWithContent.forEach(([key, slot], index) => {
        setTimeout(() => {
            const url = URL.createObjectURL(slot.audioBlob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `playground-mk1-${key}-${tempo}bpm-${timestamp}.webm`;
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
    
    if (slot.audioBlob) {
        document.getElementById('downloadBtn').style.display = 'block';
    } else {
        document.getElementById('downloadBtn').style.display = 'none';
    }

    document.getElementById('playLoopBtn').textContent = slot.playback ? 'stop' : 'play';
    document.getElementById('playAllBtn').textContent = Object.values(loopSlots).some(s => s.playback) ? 'stop all' : 'play all';
}

function setMasterVolume(value) {
    if (masterGain) masterGain.gain.value = value;
    if (loopBus) loopBus.gain.value = value / AUDIO_CONSTANTS.MASTER_VOLUME;
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
});

document.getElementById('reverb').addEventListener('input', function() {
    const value = this.value / 100;
    document.getElementById('reverbVal').textContent = this.value + '%';
    if (window.reverbMix) {
        window.reverbMix.gain.value = value;
    }
});

document.getElementById('delay').addEventListener('input', function() {
    const value = this.value / 100;
    document.getElementById('delayVal').textContent = this.value + '%';
    if (window.delayMix) {
        window.delayMix.gain.value = value;
    }
});

document.getElementById('filter').addEventListener('input', function() {
    const value = parseInt(this.value);
    document.getElementById('filterVal').textContent = value + 'Hz';
    if (window.filterNode) {
        window.filterNode.frequency.setValueAtTime(value, audioContext.currentTime);
    }
});

document.getElementById('distort').addEventListener('input', function() {
    const value = parseInt(this.value);
    document.getElementById('distortVal').textContent = value + '%';
    if (window.distortionNode && window.distortionMix) {
        // Update distortion curve based on amount (0-100 maps to 0-400 for curve)
        window.distortionNode.curve = makeDistortionCurve(value * 4);
        // Mix in the distortion (0% = no effect, 100% = full effect)
        window.distortionMix.gain.value = value / 100;
    }
});

document.getElementById('crush').addEventListener('input', function() {
    const value = parseInt(this.value);
    document.getElementById('crushVal').textContent = value;
    if (window.setCrushAmount && window.bitcrusherMix) {
        window.setCrushAmount(value);
        // Mix in the bitcrusher when active
        window.bitcrusherMix.gain.value = value > 0 ? 1 : 0;
    }
});

document.getElementById('chorus').addEventListener('input', function() {
    const value = parseInt(this.value);
    document.getElementById('chorusVal').textContent = value + '%';
    if (window.chorusMix && window.chorusLFOGain) {
        // Mix in the chorus effect
        window.chorusMix.gain.value = value / 100;
        // Increase modulation depth with intensity
        window.chorusLFOGain.gain.value = 0.002 + (value / 100) * 0.003;
    }
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

function showLayoutKeys() {
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

    // Checked before the note map, which owns plain 'e'
    if (e.shiftKey && key === 'e') {
        exportAllSlots();
        return;
    }

    if (keyMap[key]) {
        const val = keyMap[key];
        if (drums.includes(val)) {
            playDrum(val);
        } else {
            playNote(notes[val]);
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
    let totalActive = 0;
    drums.forEach(drum => {
        const activeSteps = sequencerSteps[drum].filter(step => step).length;
        totalActive += activeSteps;
    });
    document.getElementById('patternCount').textContent = totalActive > 0 ? 1 : 0;
}

function isSlotFree(key) {
    const slot = loopSlots[key];
    const beingRecorded = (isRecording || isOverdub) && key === recordingSlot;
    return !slot.audioBlob && !slot.audioBuffer && slot.loop.length === 0 && !beingRecorded;
}

// Kept for n0body, which clicked the old start button to wake the audio engine
document.getElementById('initBtn').addEventListener('click', () => initSystem());

document.getElementById('loadDemoBtn').addEventListener('click', () => {
    initSystem();

    if (demoSlot) clearSlot(demoSlot);

    drums.forEach(drum => {
        sequencerSteps[drum] = Array(16).fill(false);
    });
    
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

    drums.forEach(drum => {
        sequencerSteps[drum] = Array(16).fill(false);
    });

    document.querySelectorAll('.step').forEach(step => {
        step.classList.remove('active');
    });

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

// MIDI note to our note name mapping
function midiNoteToName(note) {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(note / 12) - 1;
    const noteName = noteNames[note % 12];
    return noteName + octave;
}

// MIDI drum mapping (GM standard drum kit on channel 10, notes 35-81)
const midiDrumMap = {
    36: 'kick',    // Bass Drum 1
    35: 'kick',    // Acoustic Bass Drum
    38: 'snare',   // Acoustic Snare
    40: 'snare',   // Electric Snare
    42: 'hihat',   // Closed Hi-Hat
    44: 'hihat',   // Pedal Hi-Hat
    46: 'hihat',   // Open Hi-Hat
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

function handleMIDIMessage(event) {
    const [status, data1, data2] = event.data;
    const command = status >> 4;
    const channel = status & 0xf;

    // Note On (command = 9) with velocity > 0
    if (command === 9 && data2 > 0) {
        const note = data1;
        const velocity = data2 / 127;

        // Channel 10 (index 9) is drums in GM
        if (channel === 9) {
            const drumSound = midiDrumMap[note];
            if (drumSound) {
                playDrum(drumSound);
            }
        } else {
            // Play synth note
            const freq = midiNoteToFreq(note);
            playNote(freq);
        }
    }
    // Note Off (command = 8) or Note On with velocity 0
    // (Currently notes are one-shot, no sustain handling needed)
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
            hit: function(pad) {
                if (!isValidPad(pad)) return;
                const drumType = drumMap[pad - 1];
                playDrum(drumType, true); // skipRecording = true for API calls
            }
        },

        // === SYNTH ===
        synth: {
            play: function(note, duration) {
                const freq = noteFrequencies[note];
                if (!freq) return;

                // Duration in seconds, default to current release time
                const durationMs = duration ? duration * 1000 : releaseTime;

                playNote(freq, true, undefined, Math.max(50, durationMs)); // skipRecording = true for API calls
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

                sequencerSteps[drumType][stepIndex] = !!active;

                // Update UI
                const stepEl = document.querySelector(`.step[data-drum="${drumType}"][data-index="${stepIndex}"]`);
                if (stepEl) {
                    if (active) {
                        stepEl.classList.add('active');
                    } else {
                        stepEl.classList.remove('active');
                    }
                }
                updatePatternCount();
            },

            getStep: function(track, step) {
                if (!isValidTrack(track) || !isValidStep(step)) return false;

                const drumType = drumMap[track - 1];
                return sequencerSteps[drumType][step - 1];
            },

            clearTrack: function(track) {
                if (!isValidTrack(track)) return;

                const drumType = drumMap[track - 1];
                sequencerSteps[drumType] = Array(16).fill(false);

                // Update UI
                document.querySelectorAll(`.step[data-drum="${drumType}"]`).forEach(s => {
                    s.classList.remove('active');
                });
                updatePatternCount();
            },

            clearAll: function() {
                drums.forEach(drum => {
                    sequencerSteps[drum] = Array(16).fill(false);
                });
                document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
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
            }
        },

        // === FX ===
        fx: {
            setReverb: function(value) {
                const v = clamp(value, 0, 1);
                if (window.reverbMix) {
                    window.reverbMix.gain.value = v;
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
                    window.delayMix.gain.value = v;
                }

                // Update UI
                const slider = document.getElementById('delay');
                const display = document.getElementById('delayVal');
                if (slider) slider.value = Math.round(v * 100);
                if (display) display.textContent = Math.round(v * 100) + '%';
            },

            setFilter: function(value) {
                // 0-1 maps to 100-20000Hz (logarithmic would be better but linear is simpler)
                const freq = Math.round(100 + clamp(value, 0, 1) * 19900);
                if (window.filterNode && audioContext) {
                    window.filterNode.frequency.setValueAtTime(freq, audioContext.currentTime);
                }

                // Update UI
                const slider = document.getElementById('filter');
                const display = document.getElementById('filterVal');
                if (slider) slider.value = freq;
                if (display) display.textContent = freq + 'Hz';
            },

            setDistortion: function(value) {
                const v = clamp(value, 0, 1);
                if (window.distortionNode && window.distortionMix) {
                    window.distortionNode.curve = makeDistortionCurve(v * 400);
                    window.distortionMix.gain.value = v;
                }

                // Update UI
                const slider = document.getElementById('distort');
                const display = document.getElementById('distortVal');
                if (slider) slider.value = Math.round(v * 100);
                if (display) display.textContent = Math.round(v * 100) + '%';
            },

            setChorus: function(value) {
                const v = clamp(value, 0, 1);
                if (window.chorusMix && window.chorusLFOGain) {
                    window.chorusMix.gain.value = v;
                    window.chorusLFOGain.gain.value = 0.002 + v * 0.003;
                }

                // Update UI
                const slider = document.getElementById('chorus');
                const display = document.getElementById('chorusVal');
                if (slider) slider.value = Math.round(v * 100);
                if (display) display.textContent = Math.round(v * 100) + '%';
            },

            setCrush: function(value) {
                // 0-1 maps to 0-16 bit reduction
                const crushVal = Math.round(clamp(value, 0, 1) * 16);
                if (window.setCrushAmount && window.bitcrusherMix) {
                    window.setCrushAmount(crushVal);
                    window.bitcrusherMix.gain.value = crushVal > 0 ? 1 : 0;
                }

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
                        distortion: window.distortionMix?.gain.value || 0,
                        chorus: window.chorusMix?.gain.value || 0
                    },
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
