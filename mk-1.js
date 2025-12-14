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
    VIBE_BASE_RADIUS: 80,
    VIBE_SCALE_FACTOR: 0.15,
    VIBE_LERP_SPEED: 0.15,
    VIBE_VOLUME_THRESHOLD_LOW: 0.02,
    VIBE_VOLUME_THRESHOLD_MID: 0.05,
    VIBE_VOLUME_THRESHOLD_HIGH: 0.15,
    VIBE_TRICK_DURATION: 2000,
    VIZ_LINE_WIDTH: 2
};

// ============================================
// AUDIO ENGINE
// ============================================
let audioContext;
let masterGain;
let analyser;
let isActive = false;

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

let loopSlots = {
    A: { loop: [], audioBlob: null, audioBuffer: null, duration: 0, isPlaying: false },
    B: { loop: [], audioBlob: null, audioBuffer: null, duration: 0, isPlaying: false },
    C: { loop: [], audioBlob: null, audioBuffer: null, duration: 0, isPlaying: false },
    D: { loop: [], audioBlob: null, audioBuffer: null, duration: 0, isPlaying: false }
};
let activeSlot = 'A';
let isRecording = false;
let recordingStart = 0;
let isOverdub = false;

let mediaRecorder;
let audioChunks = [];
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
let sequencerInterval;

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

function showMessage(msg) {
    const heroP = document.querySelector('.hero p');
    const originalText = heroP.textContent;
    heroP.textContent = msg;
    setTimeout(() => {
        heroP.textContent = originalText;
    }, 1000);
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

// Vibe Circle Animation
let vibeCircle = document.getElementById('vibeCircleMain');
let vibeEyeLeft = document.getElementById('vibeEyeLeft');
let vibeEyeRight = document.getElementById('vibeEyeRight');
let vibeMouth = document.getElementById('vibeMouth');
let vibeBaseRadius = ANIMATION_CONSTANTS.VIBE_BASE_RADIUS;
let vibeCurrentScale = 1;
let vibeTargetScale = 1;
let vibeMouthState = 'neutral';
let vibeIsDoingTrick = false;
let lastVibeExpression = null;

const vibeExpressions = [
    {
        name: 'glitch',
        eyes: () => {
            vibeEyeLeft.setAttribute('cx', '65');
            vibeEyeLeft.setAttribute('cy', '75');
            vibeEyeRight.setAttribute('cx', '135');
            vibeEyeRight.setAttribute('cy', '95');
            vibeEyeLeft.setAttribute('r', '2');
            vibeEyeRight.setAttribute('r', '6');
        },
        mouth: 'M 60 115 L 70 120 L 80 115 L 90 125 L 100 115 L 110 120 L 120 115 L 130 125 L 140 115'
    },
    {
        name: 'melt',
        eyes: () => {
            vibeEyeLeft.setAttribute('cy', '95');
            vibeEyeRight.setAttribute('cy', '95');
            vibeEyeLeft.setAttribute('ry', '8');
            vibeEyeRight.setAttribute('ry', '8');
            vibeEyeLeft.setAttribute('r', '3');
            vibeEyeRight.setAttribute('r', '3');
        },
        mouth: 'M 70 130 Q 100 135 130 130'
    },
    {
        name: 'zen',
        eyes: () => {
            vibeEyeLeft.setAttribute('r', '1');
            vibeEyeRight.setAttribute('r', '1');
        },
        mouth: 'M 80 115 L 120 115'
    },
    {
        name: 'vibrate',
        eyes: () => {
            vibeEyeLeft.setAttribute('cx', '73');
            vibeEyeLeft.setAttribute('cy', '83');
            vibeEyeRight.setAttribute('cx', '127');
            vibeEyeRight.setAttribute('cy', '87');
            vibeEyeLeft.setAttribute('r', '5');
            vibeEyeRight.setAttribute('r', '5');
        },
        mouth: 'M 68 115 Q 75 120 82 115 Q 90 110 98 115 Q 106 120 114 115 Q 122 110 130 115'
    },
    {
        name: 'flip',
        eyes: () => {
            vibeEyeLeft.setAttribute('cy', '115');
            vibeEyeRight.setAttribute('cy', '115');
            vibeEyeLeft.setAttribute('r', '4');
            vibeEyeRight.setAttribute('r', '4');
        },
        mouth: 'M 70 85 Q 100 75 130 85'
    },
    {
        name: 'spiral',
        eyes: () => {
            vibeEyeLeft.setAttribute('cx', '70');
            vibeEyeLeft.setAttribute('cy', '80');
            vibeEyeRight.setAttribute('cx', '130');
            vibeEyeRight.setAttribute('cy', '90');
            vibeEyeLeft.setAttribute('r', '2');
            vibeEyeRight.setAttribute('r', '7');
        },
        mouth: 'M 100 115 Q 110 120 115 115 Q 118 108 112 105'
    },
    {
        name: 'wink',
        eyes: () => {
            vibeEyeLeft.setAttribute('r', '4');
            vibeEyeRight.setAttribute('ry', '1');
            vibeEyeRight.setAttribute('r', '4');
        },
        mouth: 'M 70 115 Q 100 130 130 115'
    },
    {
        name: 'surprised',
        eyes: () => {
            vibeEyeLeft.setAttribute('r', '7');
            vibeEyeRight.setAttribute('r', '7');
        },
        mouth: 'M 90 120 Q 100 130 110 120 Q 100 110 90 120'
    },
    {
        name: 'sleepy',
        eyes: () => {
            vibeEyeLeft.setAttribute('ry', '1');
            vibeEyeRight.setAttribute('ry', '1');
            vibeEyeLeft.setAttribute('cy', '90');
            vibeEyeRight.setAttribute('cy', '90');
        },
        mouth: 'M 80 118 Q 100 115 120 118'
    },
    {
        name: 'dizzy',
        eyes: () => {
            vibeEyeLeft.setAttribute('cx', '80');
            vibeEyeLeft.setAttribute('cy', '80');
            vibeEyeRight.setAttribute('cx', '120');
            vibeEyeRight.setAttribute('cy', '90');
            vibeEyeLeft.setAttribute('r', '3');
            vibeEyeRight.setAttribute('r', '5');
        },
        mouth: 'M 75 120 Q 85 110 100 120 Q 115 130 125 115'
    }
];

function doRandomVibeTrick() {
    if (vibeIsDoingTrick) return;
    
    vibeIsDoingTrick = true;
    
    let availableExpressions = vibeExpressions;
    if (lastVibeExpression !== null) {
        availableExpressions = vibeExpressions.filter((expr, index) => index !== lastVibeExpression);
    }
    
    const randomIndex = Math.floor(Math.random() * availableExpressions.length);
    const expression = availableExpressions[randomIndex];
    
    lastVibeExpression = vibeExpressions.indexOf(expression);
    
    expression.eyes();
    vibeMouth.setAttribute('d', expression.mouth);
    
    setTimeout(() => {
        vibeIsDoingTrick = false;
        vibeEyeLeft.setAttribute('cx', '75');
        vibeEyeLeft.setAttribute('cy', '85');
        vibeEyeLeft.setAttribute('r', '4');
        vibeEyeLeft.setAttribute('ry', '4');
        vibeEyeRight.setAttribute('cx', '125');
        vibeEyeRight.setAttribute('cy', '85');
        vibeEyeRight.setAttribute('r', '4');
        vibeEyeRight.setAttribute('ry', '4');
        vibeMouth.setAttribute('d', 'M 70 115 Q 100 125 130 115');
    }, ANIMATION_CONSTANTS.VIBE_TRICK_DURATION);
}

document.getElementById('vibeCircle').addEventListener('click', doRandomVibeTrick);

// ============================================
// HELPER FUNCTIONS
// ============================================
function startMediaRecording() {
    audioChunks = [];
    document.getElementById('downloadBtn').style.display = 'none';

    mediaRecorder = new MediaRecorder(mediaStreamDestination.stream);

    mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        loopSlots[activeSlot].audioBlob = blob;

        try {
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            loopSlots[activeSlot].audioBuffer = audioBuffer;
            loopSlots[activeSlot].duration = audioBuffer.duration;
        } catch (error) {
            console.error('Error decoding audio:', error);
        }

        updateSlotUI();
        document.getElementById('downloadBtn').style.display = 'block';
    };

    mediaRecorder.start();
}

function addTouchClick(element, handler) {
    let touchHandled = false;
    element.addEventListener('touchstart', function(e) {
        e.preventDefault();
        touchHandled = true;
        handler.call(this, e);
    });
    element.addEventListener('click', function(e) {
        if (!touchHandled) {
            handler.call(this, e);
        }
        touchHandled = false;
    });
}

function animateVibe() {
    requestAnimationFrame(animateVibe);
    
    if (vibeIsDoingTrick) {
        return;
    }
    
    if (!isActive || !analyser) {
        vibeEyeLeft.setAttribute('ry', '1');
        vibeEyeRight.setAttribute('ry', '1');
        vibeCurrentScale = 1;
        vibeCircle.setAttribute('r', vibeBaseRadius);
        vibeMouth.setAttribute('d', 'M 75 115 Q 100 118 125 115');
        return;
    }
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
    }
    const average = sum / bufferLength;
    const normalizedVolume = average / 255;

    if (normalizedVolume > ANIMATION_CONSTANTS.VIBE_VOLUME_THRESHOLD_LOW) {
        vibeEyeLeft.setAttribute('ry', '4');
        vibeEyeRight.setAttribute('ry', '4');

        vibeTargetScale = 1 + (normalizedVolume * ANIMATION_CONSTANTS.VIBE_SCALE_FACTOR);

        if (normalizedVolume > ANIMATION_CONSTANTS.VIBE_VOLUME_THRESHOLD_HIGH) {
            vibeMouth.setAttribute('d', 'M 70 110 Q 100 130 130 110');
        } else if (normalizedVolume > ANIMATION_CONSTANTS.VIBE_VOLUME_THRESHOLD_MID) {
            vibeMouth.setAttribute('d', 'M 70 115 Q 100 125 130 115');
        } else {
            vibeMouth.setAttribute('d', 'M 75 115 Q 100 120 125 115');
        }
        
        if (normalizedVolume > 0.2 && Math.random() > 0.98) {
            vibeEyeLeft.setAttribute('ry', '1');
            vibeEyeRight.setAttribute('ry', '1');
            setTimeout(() => {
                vibeEyeLeft.setAttribute('ry', '4');
                vibeEyeRight.setAttribute('ry', '4');
            }, 100);
        }
    } else {
        vibeEyeLeft.setAttribute('ry', '4');
        vibeEyeRight.setAttribute('ry', '4');
        vibeTargetScale = 1;
        vibeMouth.setAttribute('d', 'M 75 115 Q 100 118 125 115');
    }
    
    vibeCurrentScale += (vibeTargetScale - vibeCurrentScale) * ANIMATION_CONSTANTS.VIBE_LERP_SPEED;
    const newRadius = vibeBaseRadius * vibeCurrentScale;
    vibeCircle.setAttribute('r', newRadius);
}

animateVibe();

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
        
        masterGain.connect(delayNode);
        masterGain.connect(reverbNode);
        masterGain.connect(filterNode);
        delayMix.connect(filterNode);
        reverbMix.connect(filterNode);
        filterNode.connect(analyser);
        analyser.connect(audioContext.destination);
        
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
        setupBitcrusher();

        window.bitcrusherMix = bitcrusherMix;

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
        document.getElementById('initBtn').textContent = 'active';
        document.getElementById('initBtn').classList.add('active');
        
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        
        drawViz();
    } else if (audioContext.state === 'suspended') {
        audioContext.resume();
        isActive = true;
        document.getElementById('sysStatus').textContent = 'active';
    }
}

async function toggleMic() {
    if (!audioContext) {
        initSystem();
        setTimeout(toggleMic, 100);
        return;
    }
    
    if (!isMicActive) {
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
            
            const heroP = document.querySelector('.hero p');
            const originalText = heroP.textContent;
            heroP.textContent = 'mic active · ready to capture external audio';
            setTimeout(() => {
                heroP.textContent = originalText;
            }, 3000);
            
        } catch (error) {
            console.error('Microphone access denied:', error);
            alert('Could not access microphone. Please check permissions.');
        }
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
        
        const heroP = document.querySelector('.hero p');
        const originalText = heroP.textContent;
        heroP.textContent = 'mic off';
        setTimeout(() => {
            heroP.textContent = originalText;
        }, 2000);
    }
}

function playDrum(type, skipRecording = false) {
    if (!audioContext) {
        initSystem();
        setTimeout(() => playDrum(type), 100);
        return;
    }
    
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    
    const pad = document.querySelector(`[data-sound="${type}"]`);
    if (pad) {
        pad.classList.add('active');
        setTimeout(() => pad.classList.remove('active'), 150);
    }
    
    const now = audioContext.currentTime;
    
    switch(type) {
        case 'kick':
            const kickOsc = audioContext.createOscillator();
            const kickGain = audioContext.createGain();
            const kickFilter = audioContext.createBiquadFilter();
            
            kickOsc.type = 'sine';
            kickOsc.frequency.setValueAtTime(150, now);
            kickOsc.frequency.exponentialRampToValueAtTime(40, now + 0.05);
            kickOsc.frequency.exponentialRampToValueAtTime(20, now + 0.5);
            
            kickFilter.type = 'lowpass';
            kickFilter.frequency.value = 200;
            kickFilter.Q.value = 1;
            
            kickGain.gain.setValueAtTime(1.5, now);
            kickGain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
            
            kickOsc.connect(kickFilter);
            kickFilter.connect(kickGain);
            kickGain.connect(masterGain);
            
            kickOsc.start(now);
            kickOsc.stop(now + 0.5);
            break;
            
        case 'snare':
            const snareOsc = audioContext.createOscillator();
            const snareNoise = audioContext.createBufferSource();
            const snareNoiseFilter = audioContext.createBiquadFilter();
            const snareGain = audioContext.createGain();
            const snareNoiseGain = audioContext.createGain();
            
            snareOsc.type = 'triangle';
            snareOsc.frequency.value = 180;
            
            const noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.2, audioContext.sampleRate);
            const noiseData = noiseBuffer.getChannelData(0);
            for (let i = 0; i < noiseBuffer.length; i++) {
                noiseData[i] = Math.random() * 2 - 1;
            }
            snareNoise.buffer = noiseBuffer;
            
            snareNoiseFilter.type = 'highpass';
            snareNoiseFilter.frequency.value = 1000;
            
            snareGain.gain.setValueAtTime(0.4, now);
            snareGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
            
            snareNoiseGain.gain.setValueAtTime(0.8, now);
            snareNoiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
            
            snareOsc.connect(snareGain);
            snareNoise.connect(snareNoiseFilter);
            snareNoiseFilter.connect(snareNoiseGain);
            snareGain.connect(masterGain);
            snareNoiseGain.connect(masterGain);
            
            snareOsc.start(now);
            snareOsc.stop(now + 0.2);
            snareNoise.start(now);
            snareNoise.stop(now + 0.15);
            break;
            
        case 'hihat':
            const hihatNoise = audioContext.createBufferSource();
            const hihatFilter = audioContext.createBiquadFilter();
            const hihatGain = audioContext.createGain();
            
            const hihatBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.1, audioContext.sampleRate);
            const hihatData = hihatBuffer.getChannelData(0);
            for (let i = 0; i < hihatBuffer.length; i++) {
                hihatData[i] = Math.random() * 2 - 1;
            }
            hihatNoise.buffer = hihatBuffer;
            
            hihatFilter.type = 'highpass';
            hihatFilter.frequency.value = 7000;
            hihatFilter.Q.value = 1;
            
            hihatGain.gain.setValueAtTime(0.3, now);
            hihatGain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
            
            hihatNoise.connect(hihatFilter);
            hihatFilter.connect(hihatGain);
            hihatGain.connect(masterGain);
            
            hihatNoise.start(now);
            break;
            
        case 'clap':
            for (let i = 0; i < 3; i++) {
                const clapNoise = audioContext.createBufferSource();
                const clapFilter = audioContext.createBiquadFilter();
                const clapGain = audioContext.createGain();
                
                const clapBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.05, audioContext.sampleRate);
                const clapData = clapBuffer.getChannelData(0);
                for (let j = 0; j < clapBuffer.length; j++) {
                    clapData[j] = Math.random() * 2 - 1;
                }
                clapNoise.buffer = clapBuffer;
                
                clapFilter.type = 'bandpass';
                clapFilter.frequency.value = 1000;
                clapFilter.Q.value = 5;
                
                const delay = i * 0.015;
                clapGain.gain.setValueAtTime(0.5, now + delay);
                clapGain.gain.exponentialRampToValueAtTime(0.01, now + delay + 0.05);
                
                clapNoise.connect(clapFilter);
                clapFilter.connect(clapGain);
                clapGain.connect(masterGain);
                
                clapNoise.start(now + delay);
            }
            break;
            
        case 'tom1':
            const tomOsc = audioContext.createOscillator();
            const tomGain = audioContext.createGain();
            const tomFilter = audioContext.createBiquadFilter();
            
            tomOsc.type = 'sine';
            tomOsc.frequency.setValueAtTime(220, now);
            tomOsc.frequency.exponentialRampToValueAtTime(150, now + 0.1);
            
            tomFilter.type = 'lowpass';
            tomFilter.frequency.value = 800;
            tomFilter.Q.value = 8;
            
            tomGain.gain.setValueAtTime(1.0, now);
            tomGain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
            
            tomOsc.connect(tomFilter);
            tomFilter.connect(tomGain);
            tomGain.connect(masterGain);
            
            tomOsc.start(now);
            tomOsc.stop(now + 0.4);
            break;
            
        case 'perc':
            const percOsc1 = audioContext.createOscillator();
            const percOsc2 = audioContext.createOscillator();
            const percGain = audioContext.createGain();
            
            percOsc1.type = 'square';
            percOsc1.frequency.value = 800;
            percOsc2.type = 'square';
            percOsc2.frequency.value = 540;
            
            percGain.gain.setValueAtTime(0.3, now);
            percGain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
            
            percOsc1.connect(percGain);
            percOsc2.connect(percGain);
            percGain.connect(masterGain);
            
            percOsc1.start(now);
            percOsc2.start(now);
            percOsc1.stop(now + 0.08);
            percOsc2.stop(now + 0.08);
            break;
            
        case 'cymbal':
            const cymbalNoise = audioContext.createBufferSource();
            const cymbalFilter1 = audioContext.createBiquadFilter();
            const cymbalFilter2 = audioContext.createBiquadFilter();
            const cymbalGain = audioContext.createGain();
            
            const cymbalBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.8, audioContext.sampleRate);
            const cymbalData = cymbalBuffer.getChannelData(0);
            for (let i = 0; i < cymbalBuffer.length; i++) {
                cymbalData[i] = Math.random() * 2 - 1;
            }
            cymbalNoise.buffer = cymbalBuffer;
            
            cymbalFilter1.type = 'highpass';
            cymbalFilter1.frequency.value = 5000;
            cymbalFilter2.type = 'bandpass';
            cymbalFilter2.frequency.value = 8000;
            cymbalFilter2.Q.value = 2;
            
            cymbalGain.gain.setValueAtTime(0.3, now);
            cymbalGain.gain.exponentialRampToValueAtTime(0.01, now + 0.8);
            
            cymbalNoise.connect(cymbalFilter1);
            cymbalFilter1.connect(cymbalFilter2);
            cymbalFilter2.connect(cymbalGain);
            cymbalGain.connect(masterGain);
            
            cymbalNoise.start(now);
            break;
            
        case 'rim':
            const rimOsc = audioContext.createOscillator();
            const rimGain = audioContext.createGain();
            const rimFilter = audioContext.createBiquadFilter();
            
            rimOsc.type = 'square';
            rimOsc.frequency.value = 1000;
            
            rimFilter.type = 'highpass';
            rimFilter.frequency.value = 2000;
            
            rimGain.gain.setValueAtTime(0.5, now);
            rimGain.gain.exponentialRampToValueAtTime(0.01, now + 0.03);
            
            rimOsc.connect(rimFilter);
            rimFilter.connect(rimGain);
            rimGain.connect(masterGain);
            
            rimOsc.start(now);
            rimOsc.stop(now + 0.03);
            break;
    }
    
    if (!skipRecording && (isRecording || isOverdub)) {
        loopSlots[activeSlot].loop.push({
            type: 'drum',
            sound: type,
            time: audioContext.currentTime - recordingStart
        });
    }
}

function playNote(freq, skipRecording = false) {
    if (!audioContext) {
        initSystem();
        setTimeout(() => playNote(freq), 100);
        return;
    }

    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    const noteEntry = Object.entries(notes).find(([key, f]) => f === freq);
    if (noteEntry) {
        const [noteName] = noteEntry;
        const keyEl = document.querySelector(`[data-note="${noteName}"]`);
        if (keyEl) {
            keyEl.classList.add('active');
            setTimeout(() => keyEl.classList.remove('active'), 200);
        }
    }

    const wave = document.getElementById('waveType').dataset.value;
    const now = audioContext.currentTime;
    const attack = attackTime / 1000;
    const release = releaseTime / 1000;

    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.3, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.01, now + release);
    gain.connect(masterGain);

    if (wave === 'noise') {
        // White noise with pitch-based filter
        const noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * release, audioContext.sampleRate);
        const noiseData = noiseBuffer.getChannelData(0);
        for (let i = 0; i < noiseBuffer.length; i++) {
            noiseData[i] = Math.random() * 2 - 1;
        }
        const noiseSource = audioContext.createBufferSource();
        noiseSource.buffer = noiseBuffer;

        // Use frequency to control filter cutoff for tonal noise
        const noiseFilter = audioContext.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.value = freq;
        noiseFilter.Q.value = 10;

        noiseSource.connect(noiseFilter);
        noiseFilter.connect(gain);
        noiseSource.start();
        noiseSource.stop(now + release);
    } else if (wave === 'pulse') {
        // Pulse wave using two detuned sawtooths
        const osc1 = audioContext.createOscillator();
        const osc2 = audioContext.createOscillator();
        const pulseGain = audioContext.createGain();

        osc1.type = 'sawtooth';
        osc2.type = 'sawtooth';
        osc1.frequency.setValueAtTime(freq, now);
        osc2.frequency.setValueAtTime(freq, now);

        // Phase offset creates pulse width effect
        osc2.detune.setValueAtTime(1, now);
        pulseGain.gain.value = -1;

        osc1.connect(gain);
        osc2.connect(pulseGain);
        pulseGain.connect(gain);

        osc1.start();
        osc2.start();
        osc1.stop(now + release);
        osc2.stop(now + release);
    } else {
        // Standard oscillator waves
        const osc = audioContext.createOscillator();
        osc.type = wave;
        osc.frequency.setValueAtTime(freq, audioContext.currentTime);
        osc.connect(gain);
        osc.start();
        osc.stop(audioContext.currentTime + release);
    }

    if (!skipRecording && (isRecording || isOverdub)) {
        loopSlots[activeSlot].loop.push({
            type: 'synth',
            freq: freq,
            wave: wave,
            time: audioContext.currentTime - recordingStart
        });
    }
}

document.getElementById('initBtn').addEventListener('click', initSystem);
document.getElementById('micBtn').addEventListener('click', toggleMic);

document.querySelectorAll('.pad').forEach(pad => {
    addTouchClick(pad, function() {
        const sound = this.dataset.sound;
        playDrum(sound);
    });
});

document.querySelectorAll('.key').forEach(key => {
    addTouchClick(key, function() {
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
        addTouchClick(step, function() {
            saveSequencerState();
            sequencerSteps[drum][i] = !sequencerSteps[drum][i];
            this.classList.toggle('active');
            updatePatternCount();
        });
        stepsContainer.appendChild(step);
    }
});

document.getElementById('playSeq').addEventListener('click', toggleSequencer);

function toggleSequencer(skipRecording = false) {
    if (!audioContext) {
        initSystem();
        setTimeout(() => toggleSequencer(skipRecording), 100);
        return;
    }

    if (!isPlaying) {
        isPlaying = true;
        const tempo = parseInt(document.getElementById('tempo').value);
        const interval = (60 / tempo) * 1000 / 4;

        document.getElementById('playSeq').textContent = 'stop';
        document.getElementById('playSeq').classList.add('active');

        // Only auto-record if not called from API (skipRecording = false)
        if (!skipRecording && !isRecording && !isOverdub) {
            isRecording = true;
            recordingStart = audioContext.currentTime;
            loopSlots[activeSlot].loop = [];

            startMediaRecording();

            document.getElementById('recordBtn').textContent = 'recording...';
            document.getElementById('recordBtn').classList.add('active');
            document.getElementById('recStatus').textContent = 'on';
        }
        
        sequencerInterval = setInterval(() => {
            const steps = document.querySelectorAll('.step');
            steps.forEach(s => s.classList.remove('playing'));

            const currentSteps = document.querySelectorAll(`.step[data-index="${currentStep}"]`);
            currentSteps.forEach(s => s.classList.add('playing'));

            // Update beat indicator (4 beats per bar, 4 steps per beat)
            const beatDots = document.querySelectorAll('.beat-dot');
            beatDots.forEach(dot => dot.classList.remove('active'));
            const currentBeat = Math.floor(currentStep / 4) + 1;
            const activeDot = document.querySelector(`.beat-dot[data-beat="${currentBeat}"]`);
            if (activeDot) activeDot.classList.add('active');

            drums.forEach(drum => {
                if (sequencerSteps[drum][currentStep]) {
                    playDrum(drum);
                }
            });

            currentStep = (currentStep + 1) % 16;
        }, interval);
    } else {
        stopSequencer();
    }
}

function stopSequencer(shouldStopRecording = true) {
    clearInterval(sequencerInterval);
    isPlaying = false;
    currentStep = 0;
    document.querySelectorAll('.step').forEach(s => s.classList.remove('playing'));
    document.querySelectorAll('.beat-dot').forEach(dot => dot.classList.remove('active'));
    document.getElementById('playSeq').textContent = 'play+rec';
    document.getElementById('playSeq').classList.remove('active');
    
    if (shouldStopRecording && isRecording) {
        isRecording = false;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        document.getElementById('recordBtn').textContent = 'rec manual';
        document.getElementById('recordBtn').classList.remove('active');
        document.getElementById('recStatus').textContent = 'off';
    }
}

document.getElementById('clearSeq').addEventListener('click', () => {
    drums.forEach(drum => {
        sequencerSteps[drum] = Array(16).fill(false);
    });
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    updatePatternCount();
});

document.getElementById('recordBtn').addEventListener('click', () => {
    if (!audioContext) {
        initSystem();
        setTimeout(() => document.getElementById('recordBtn').click(), 100);
        return;
    }
    
    if (!isRecording) {
        isRecording = true;
        isOverdub = false;
        recordingStart = audioContext.currentTime;
        loopSlots[activeSlot].loop = [];

        startMediaRecording();

        document.getElementById('recordBtn').textContent = 'recording...';
        document.getElementById('recordBtn').classList.add('active');
        document.getElementById('recStatus').textContent = 'on';
    } else {
        isRecording = false;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        document.getElementById('recordBtn').textContent = 'rec manual';
        document.getElementById('recordBtn').classList.remove('active');
        document.getElementById('recStatus').textContent = 'off';
    }
});

document.getElementById('overdubBtn').addEventListener('click', () => {
    if (!audioContext) {
        initSystem();
        setTimeout(() => document.getElementById('overdubBtn').click(), 100);
        return;
    }
    
    if (!isOverdub && !isRecording) {
        isOverdub = true;
        recordingStart = audioContext.currentTime;

        startMediaRecording();

        document.getElementById('overdubBtn').textContent = 'layering...';
        document.getElementById('overdubBtn').classList.add('active');
        document.getElementById('recStatus').textContent = 'overdub';
    } else if (isOverdub) {
        isOverdub = false;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        document.getElementById('overdubBtn').textContent = 'add layer';
        document.getElementById('overdubBtn').classList.remove('active');
        document.getElementById('recStatus').textContent = 'off';
    }
});

document.getElementById('playLoopBtn').addEventListener('click', () => {
    const slot = loopSlots[activeSlot];
    
    if (!audioContext) {
        initSystem();
        setTimeout(() => document.getElementById('playLoopBtn').click(), 100);
        return;
    }
    
    if (slot.audioBuffer) {
        const source = audioContext.createBufferSource();
        source.buffer = slot.audioBuffer;
        source.connect(masterGain);
        source.start(0);
    }
    
    if (slot.loop.length > 0) {
        slot.loop.forEach(event => {
            setTimeout(() => {
                if (event.type === 'drum') {
                    playDrum(event.sound, true);
                } else if (event.type === 'synth') {
                    playNote(event.freq, true);
                }
            }, event.time * 1000);
        });
    }
});

document.getElementById('playAllBtn').addEventListener('click', () => {
    if (!audioContext) {
        initSystem();
        setTimeout(() => document.getElementById('playAllBtn').click(), 100);
        return;
    }
    
    Object.keys(loopSlots).forEach(slotKey => {
        const slot = loopSlots[slotKey];
        
        if (slot.audioBuffer) {
            const source = audioContext.createBufferSource();
            source.buffer = slot.audioBuffer;
            source.connect(masterGain);
            source.start(0);
        }
        
        if (slot.loop.length > 0) {
            slot.loop.forEach(event => {
                setTimeout(() => {
                    if (event.type === 'drum') {
                        playDrum(event.sound, true);
                    } else if (event.type === 'synth') {
                        playNote(event.freq, true);
                    }
                }, event.time * 1000);
            });
        }
    });
});

document.getElementById('clearLoopBtn').addEventListener('click', () => {
    loopSlots[activeSlot].loop = [];
    loopSlots[activeSlot].audioBlob = null;
    loopSlots[activeSlot].audioBuffer = null;
    loopSlots[activeSlot].duration = 0;
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
}

document.getElementById('masterVol').addEventListener('input', function() {
    if (masterGain) masterGain.gain.value = this.value / 100;
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
    if (isPlaying) {
        stopSequencer(false);
        setTimeout(() => toggleSequencer(), 50);
    }
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

// Shortcuts Modal
const modal = document.getElementById('shortcutsModal');
const closeModalBtn = document.getElementById('closeModal');

function openModal() {
    modal.classList.add('active');
}

function closeModal() {
    modal.classList.remove('active');
}

// Shortcuts Modal Button
document.getElementById('shortcutsBtn').addEventListener('click', openModal);

modal.addEventListener('click', (e) => {
    if (e.target === modal) {
        closeModal();
    }
});

closeModalBtn.addEventListener('click', closeModal);

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

keyboardLayoutElement.addEventListener('change', function(e) {
    currentLayout = e.detail.value;
    keyMap = keyboardLayouts[currentLayout];
    localStorage.setItem('playground-mk1-keyboard-layout', currentLayout);
    showMessage('layout: ' + currentLayout);
});

// Initialize wave type custom select
const waveTypeElement = document.getElementById('waveType');
customSelectInstances.waveType = new CustomSelect(waveTypeElement);

document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();

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

    if (e.key === '?' && !modal.classList.contains('active')) {
        e.preventDefault();
        openModal();
        return;
    }
    
    if (e.key === 'Escape' && modal.classList.contains('active')) {
        closeModal();
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
    if (key === 'e') {
        exportAllSlots();
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
    
    if (keyMap[key]) {
        const val = keyMap[key];
        
        if (['kick', 'snare', 'hihat', 'clap', 'tom1', 'perc', 'cymbal', 'rim'].includes(val)) {
            playDrum(val);
            const pad = document.querySelector(`[data-sound="${val}"]`);
            if (pad) {
                pad.classList.add('active');
                setTimeout(() => pad.classList.remove('active'), 150);
            }
        } else {
            playNote(notes[val]);
            const keyEl = document.querySelector(`[data-note="${val}"]`);
            if (keyEl) {
                keyEl.classList.add('active');
                setTimeout(() => keyEl.classList.remove('active'), 200);
            }
        }
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

    // Update colors if not cached (first run or theme change)
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

let resizeTimeout;
function resizeCanvas() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
}

window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(resizeCanvas, 100);
});

window.addEventListener('orientationchange', () => {
    setTimeout(resizeCanvas, 300);
});

function updateTimestamp() {
    const now = new Date();
    const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.getElementById('timestamp').textContent = `${date} — ${time}`;
}

updateTimestamp();
setInterval(updateTimestamp, 1000);

function updatePatternCount() {
    let totalActive = 0;
    drums.forEach(drum => {
        const activeSteps = sequencerSteps[drum].filter(step => step).length;
        totalActive += activeSteps;
    });
    document.getElementById('patternCount').textContent = totalActive > 0 ? 1 : 0;
}

document.getElementById('loadDemoBtn').addEventListener('click', () => {
    if (!audioContext) {
        initSystem();
    }
    
    Object.keys(loopSlots).forEach(key => {
        loopSlots[key].loop = [];
        loopSlots[key].audioBlob = null;
        loopSlots[key].audioBuffer = null;
        loopSlots[key].duration = 0;
    });
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
    
    document.querySelectorAll('.step').forEach(step => {
        const drum = step.dataset.drum;
        const index = parseInt(step.dataset.index);
        if (sequencerSteps[drum][index]) {
            step.classList.add('active');
        } else {
            step.classList.remove('active');
        }
    });
    
    activeSlot = 'A';
    document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-slot="A"]').classList.add('active');
    
    loopSlots.A.loop = [
        { type: 'synth', freq: notes.C4, wave: 'sine', time: 0 },
        { type: 'synth', freq: notes.E4, wave: 'sine', time: 0.5 },
        { type: 'synth', freq: notes.G4, wave: 'sine', time: 1.0 },
        { type: 'synth', freq: notes.C5, wave: 'sine', time: 1.5 },
        { type: 'synth', freq: notes.G4, wave: 'sine', time: 2.0 },
        { type: 'synth', freq: notes.E4, wave: 'sine', time: 2.5 },
        { type: 'synth', freq: notes.C4, wave: 'sine', time: 3.0 }
    ];
    
    document.getElementById('tempo').value = 120;
    document.getElementById('tempoVal').textContent = '120';
    document.getElementById('tempoStatus').textContent = '120';
    customSelectInstances.waveType.value = 'sine';

    updatePatternCount();
    updateSlotUI();

    const heroP = document.querySelector('.hero p');
    const originalText = heroP.textContent;
    heroP.textContent = 'demo loaded! hit space to hear it';
    setTimeout(() => {
        heroP.textContent = originalText;
    }, 4000);
});

document.getElementById('clearAllBtn').addEventListener('click', () => {
    if (isMicActive) {
        toggleMic();
    }
    
    Object.keys(loopSlots).forEach(key => {
        loopSlots[key].loop = [];
        loopSlots[key].audioBlob = null;
        loopSlots[key].audioBuffer = null;
        loopSlots[key].duration = 0;
        loopSlots[key].isPlaying = false;
    });
    
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
    
    document.getElementById('tempo').value = 120;
    document.getElementById('tempoVal').textContent = '120';
    document.getElementById('tempoStatus').textContent = '120';

    customSelectInstances.waveType.value = 'sine';

    document.getElementById('attack').value = 10;
    document.getElementById('attackVal').textContent = '10ms';
    
    document.getElementById('release').value = 300;
    document.getElementById('releaseVal').textContent = '300ms';
    
    document.getElementById('reverb').value = 0;
    document.getElementById('reverbVal').textContent = '0%';
    if (window.reverbMix) window.reverbMix.gain.value = 0;
    
    document.getElementById('delay').value = 0;
    document.getElementById('delayVal').textContent = '0%';
    if (window.delayMix) window.delayMix.gain.value = 0;
    
    document.getElementById('filter').value = 10000;
    document.getElementById('filterVal').textContent = '10000Hz';
    if (window.filterNode) window.filterNode.frequency.value = 10000;

    document.getElementById('chorus').value = 0;
    document.getElementById('chorusVal').textContent = '0%';
    if (window.chorusMix) window.chorusMix.gain.value = 0;
    if (window.chorusLFOGain) window.chorusLFOGain.gain.value = 0.002;

    document.getElementById('distort').value = 0;
    document.getElementById('distortVal').textContent = '0%';
    if (window.distortionNode) window.distortionNode.curve = makeDistortionCurve(0);
    if (window.distortionMix) window.distortionMix.gain.value = 0;

    document.getElementById('crush').value = 0;
    document.getElementById('crushVal').textContent = '0';
    if (window.setCrushAmount) window.setCrushAmount(0);
    if (window.bitcrusherMix) window.bitcrusherMix.gain.value = 0;

    document.getElementById('masterVol').value = 70;
    document.getElementById('masterVolVal').textContent = '70%';
    if (masterGain) masterGain.gain.value = 0.7;
    
    document.getElementById('downloadBtn').style.display = 'none';
    
    updatePatternCount();
    updateSlotUI();
    
    const heroP = document.querySelector('.hero p');
    const originalText = heroP.textContent;
    heroP.textContent = 'all clear! start creating';
    setTimeout(() => {
        heroP.textContent = originalText;
    }, 3000);
});

// Theme Toggle - Always starts in light mode
const themeToggle = document.getElementById('themeToggle');
const html = document.documentElement;

themeToggle.addEventListener('click', () => {
    html.classList.toggle('dark-mode');
    // Update visualizer colors when theme changes
    updateVizColors();
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

// Initialize MIDI on page load
if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess({ sysex: false })
        .then(onMIDISuccess)
        .catch(onMIDIFailure);
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
        'noise': 'noise'
    };

    // Track active synth note for stop functionality
    let activeSynthNodes = [];

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
                // Ensure audio system is initialized
                if (!audioContext) {
                    initSystem();
                }

                // Get frequency from note name
                const freq = noteFrequencies[note];
                if (!freq) return;

                // Duration in seconds, default to current release time
                const durationMs = duration ? duration * 1000 : releaseTime;

                // Store original release
                const originalRelease = releaseTime;

                // Temporarily set release to match duration
                releaseTime = Math.max(50, durationMs);

                // Play the note
                playNote(freq, true); // skipRecording = true for API calls

                // Restore original release after a tick
                setTimeout(() => {
                    releaseTime = originalRelease;
                }, 10);
            },

            stop: function() {
                // Future: implement note cutoff if needed
                // Currently notes auto-release based on envelope
            },

            setWaveform: function(type) {
                const internalType = waveformMap[type];
                if (!internalType) return;

                // Update the custom select
                if (customSelectInstances.waveType) {
                    customSelectInstances.waveType.value = internalType === 'sawtooth' ? 'saw' : internalType;
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
                if (!isPlaying) {
                    // Initialize audio if needed
                    if (!audioContext) {
                        initSystem();
                    }
                    toggleSequencer(true); // skipRecording = true for API calls
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
                if (masterGain) {
                    masterGain.gain.value = v;
                }

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

                // Switch to the target slot
                activeSlot = normalizedSlot;
                document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('active'));
                const slotBtn = document.querySelector(`[data-slot="${normalizedSlot}"]`);
                if (slotBtn) slotBtn.classList.add('active');

                // Start recording (clear existing content)
                isRecording = true;
                isOverdub = false;
                recordingStart = audioContext.currentTime;
                loopSlots[normalizedSlot].loop = [];

                startMediaRecording();

                document.getElementById('recordBtn').textContent = 'recording...';
                document.getElementById('recordBtn').classList.add('active');
                document.getElementById('recStatus').textContent = 'on';
                updateSlotUI();
            },

            // Stop current recording
            stopRecording: function() {
                if (isRecording) {
                    isRecording = false;
                    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                        mediaRecorder.stop();
                    }
                    document.getElementById('recordBtn').textContent = 'rec manual';
                    document.getElementById('recordBtn').classList.remove('active');
                    document.getElementById('recStatus').textContent = 'off';
                }
                if (isOverdub) {
                    isOverdub = false;
                    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                        mediaRecorder.stop();
                    }
                    document.getElementById('overdubBtn').textContent = 'add layer';
                    document.getElementById('overdubBtn').classList.remove('active');
                    document.getElementById('recStatus').textContent = 'off';
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

                if (!audioContext) {
                    initSystem();
                }

                const slotData = loopSlots[normalizedSlot];

                // Play audio buffer if exists
                if (slotData.audioBuffer) {
                    const source = audioContext.createBufferSource();
                    source.buffer = slotData.audioBuffer;
                    source.connect(masterGain);
                    source.start(0);

                    // Track playback state
                    slotData.isPlaying = true;
                    source.onended = () => {
                        slotData.isPlaying = false;
                    };
                }

                // Replay event loop
                if (slotData.loop.length > 0) {
                    slotData.isPlaying = true;
                    let maxTime = 0;

                    slotData.loop.forEach(event => {
                        if (event.time > maxTime) maxTime = event.time;
                        setTimeout(() => {
                            if (event.type === 'drum') {
                                playDrum(event.sound, true);
                            } else if (event.type === 'synth') {
                                playNote(event.freq, true);
                            }
                        }, event.time * 1000);
                    });

                    // Clear playing state after all events finish
                    setTimeout(() => {
                        slotData.isPlaying = false;
                    }, (maxTime + 1) * 1000);
                }
            },

            // Play all slots with content
            playAll: function() {
                Object.keys(loopSlots).forEach(slotKey => {
                    const slot = loopSlots[slotKey];
                    if (slot.audioBuffer || slot.loop.length > 0) {
                        this.play(slotKey);
                    }
                });
            },

            // Stop a specific slot (limited - can't stop audio buffer mid-play)
            stop: function(slot) {
                const normalizedSlot = this._normalizeSlot(slot);
                if (!normalizedSlot) return;

                // Mark as not playing (note: can't actually stop AudioBufferSourceNode mid-play easily)
                loopSlots[normalizedSlot].isPlaying = false;
            },

            // Stop all slots
            stopAll: function() {
                Object.keys(loopSlots).forEach(slotKey => {
                    loopSlots[slotKey].isPlaying = false;
                });
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
                    isOverdub = true;
                    recordingStart = audioContext.currentTime;

                    startMediaRecording();

                    document.getElementById('overdubBtn').textContent = 'layering...';
                    document.getElementById('overdubBtn').classList.add('active');
                    document.getElementById('recStatus').textContent = 'overdub';
                }
                updateSlotUI();
            },

            // Clear a specific slot
            clear: function(slot) {
                const normalizedSlot = this._normalizeSlot(slot);
                if (!normalizedSlot) return;

                loopSlots[normalizedSlot].loop = [];
                loopSlots[normalizedSlot].audioBlob = null;
                loopSlots[normalizedSlot].audioBuffer = null;
                loopSlots[normalizedSlot].duration = 0;
                loopSlots[normalizedSlot].isPlaying = false;
                updateSlotUI();
            },

            // Clear all slots
            clearAll: function() {
                Object.keys(loopSlots).forEach(slotKey => {
                    loopSlots[slotKey].loop = [];
                    loopSlots[slotKey].audioBlob = null;
                    loopSlots[slotKey].audioBuffer = null;
                    loopSlots[slotKey].duration = 0;
                    loopSlots[slotKey].isPlaying = false;
                });
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
                initSystem();
            }
        }
    };
})();
