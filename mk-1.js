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
        
        window.delayMix = delayMix;
        window.reverbMix = reverbMix;
        window.filterNode = filterNode;
        
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

    const wave = document.getElementById('waveType').value;
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

function toggleSequencer() {
    if (!audioContext) {
        initSystem();
        setTimeout(toggleSequencer, 100);
        return;
    }
    
    if (!isPlaying) {
        isPlaying = true;
        const tempo = parseInt(document.getElementById('tempo').value);
        const interval = (60 / tempo) * 1000 / 4;
        
        document.getElementById('playSeq').textContent = 'stop';
        document.getElementById('playSeq').classList.add('active');
        
        if (!isRecording && !isOverdub) {
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
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `playground-mk1-slot-${activeSlot}-${timestamp}.webm`;
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
});

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

// Initialize keyboard layout selector
document.getElementById('keyboardLayout').value = currentLayout;
document.getElementById('keyboardLayout').addEventListener('change', function() {
    currentLayout = this.value;
    keyMap = keyboardLayouts[currentLayout];
    localStorage.setItem('playground-mk1-keyboard-layout', currentLayout);
    showMessage('layout: ' + currentLayout);
});

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
    document.getElementById('waveType').value = 'sine';
    
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
    
    document.getElementById('waveType').value = 'sine';
    
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

// Tap Tempo
let tapTimes = [];
const TAP_TIMEOUT = 2000; // Reset after 2 seconds of no taps

document.getElementById('tapTempoBtn').addEventListener('click', () => {
    const now = Date.now();

    // Reset if too long since last tap
    if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > TAP_TIMEOUT) {
        tapTimes = [];
    }

    tapTimes.push(now);

    // Keep only last 8 taps
    if (tapTimes.length > 8) {
        tapTimes.shift();
    }

    // Need at least 2 taps to calculate tempo
    if (tapTimes.length >= 2) {
        let totalInterval = 0;
        for (let i = 1; i < tapTimes.length; i++) {
            totalInterval += tapTimes[i] - tapTimes[i - 1];
        }
        const avgInterval = totalInterval / (tapTimes.length - 1);
        let bpm = Math.round(60000 / avgInterval);

        // Clamp to valid range
        bpm = Math.max(60, Math.min(200, bpm));

        // Update UI
        document.getElementById('tempo').value = bpm;
        document.getElementById('tempoVal').textContent = bpm;
        document.getElementById('tempoStatus').textContent = bpm;

        // If playing, restart sequencer with new tempo
        if (isPlaying) {
            stopSequencer(false);
            setTimeout(() => toggleSequencer(), 50);
        }
    }
});

// Synth Presets (localStorage)
const PRESETS_KEY = 'playground-mk1-synth-presets';

function loadPresetsFromStorage() {
    try {
        const stored = localStorage.getItem(PRESETS_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        return {};
    }
}

function savePresetsToStorage(presets) {
    try {
        localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
    } catch (e) {
        console.error('Could not save presets:', e);
    }
}

function updatePresetDropdown() {
    const select = document.getElementById('synthPreset');
    const presets = loadPresetsFromStorage();

    // Clear and rebuild
    select.innerHTML = '<option value="">--</option>';

    Object.keys(presets).forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });
}

function getCurrentSynthSettings() {
    return {
        wave: document.getElementById('waveType').value,
        attack: document.getElementById('attack').value,
        release: document.getElementById('release').value
    };
}

function applySynthSettings(settings) {
    document.getElementById('waveType').value = settings.wave;
    document.getElementById('attack').value = settings.attack;
    document.getElementById('attackVal').textContent = settings.attack + 'ms';
    attackTime = parseInt(settings.attack);
    document.getElementById('release').value = settings.release;
    document.getElementById('releaseVal').textContent = settings.release + 'ms';
    releaseTime = parseInt(settings.release);
}

document.getElementById('savePresetBtn').addEventListener('click', () => {
    const name = prompt('Preset name:');
    if (!name || !name.trim()) return;

    const presets = loadPresetsFromStorage();
    presets[name.trim()] = getCurrentSynthSettings();
    savePresetsToStorage(presets);
    updatePresetDropdown();
    document.getElementById('synthPreset').value = name.trim();
    showMessage('preset saved');
});

document.getElementById('synthPreset').addEventListener('change', function() {
    if (!this.value) return;

    const presets = loadPresetsFromStorage();
    const preset = presets[this.value];

    if (preset) {
        applySynthSettings(preset);
        showMessage('preset loaded');
    }
});

// Initialize preset dropdown
updatePresetDropdown();

// Pattern Presets (localStorage)
const PATTERNS_KEY = 'playground-mk1-patterns';

function loadPatternsFromStorage() {
    try {
        const stored = localStorage.getItem(PATTERNS_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        return {};
    }
}

function savePatternsToStorage(patterns) {
    try {
        localStorage.setItem(PATTERNS_KEY, JSON.stringify(patterns));
    } catch (e) {
        console.error('Could not save patterns:', e);
    }
}

function updatePatternDropdown() {
    const select = document.getElementById('patternPreset');
    const patterns = loadPatternsFromStorage();

    select.innerHTML = '<option value="">patterns</option>';

    Object.keys(patterns).forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });
}

function getCurrentPattern() {
    const pattern = {};
    for (const drum in sequencerSteps) {
        pattern[drum] = [...sequencerSteps[drum]];
    }
    return pattern;
}

function applyPattern(pattern) {
    for (const drum in pattern) {
        sequencerSteps[drum] = [...pattern[drum]];
    }
    updateSequencerUI();
    updatePatternCount();
}

document.getElementById('savePatternBtn').addEventListener('click', () => {
    const name = prompt('Pattern name:');
    if (!name || !name.trim()) return;

    const patterns = loadPatternsFromStorage();
    patterns[name.trim()] = getCurrentPattern();
    savePatternsToStorage(patterns);
    updatePatternDropdown();
    document.getElementById('patternPreset').value = name.trim();
    showMessage('pattern saved');
});

document.getElementById('patternPreset').addEventListener('change', function() {
    if (!this.value) return;

    const patterns = loadPatternsFromStorage();
    const pattern = patterns[this.value];

    if (pattern) {
        saveSequencerState(); // For undo
        applyPattern(pattern);
        showMessage('pattern loaded');
    }
});

// Initialize pattern dropdown
updatePatternDropdown();
