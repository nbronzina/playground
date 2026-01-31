// ============================================
// MK-DWELL - Generative Audio Engine
// ============================================

const DwellAudio = (function() {
    let audioContext = null;
    let masterGain = null;
    let isRunning = false;

    // Spatial processing nodes
    let reverbNode = null;
    let reverbGain = null;
    let delayNode = null;
    let delayFeedback = null;
    let delayGain = null;
    let filterNode = null;
    let pannerNode = null;

    // Layer nodes
    let droneNodes = [];
    let textureNode = null;
    let eventTimeout = null;

    // Current position (0-1)
    let position = { x: 0.5, y: 0.5 };
    let targetPosition = { x: 0.5, y: 0.5 };

    // Seeded random
    let seed = Date.now();

    function seededRandom() {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
    }

    // Scales for melodic content (pentatonic for consonance)
    const SCALE = [0, 2, 4, 7, 9]; // C pentatonic
    const BASE_FREQ = 65.41; // C2

    function noteToFreq(note) {
        return BASE_FREQ * Math.pow(2, note / 12);
    }

    // Create impulse response for reverb
    function createReverbImpulse(duration, decay) {
        const sampleRate = audioContext.sampleRate;
        const length = sampleRate * duration;
        const impulse = audioContext.createBuffer(2, length, sampleRate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const env = Math.pow(1 - t / duration, decay);
            left[i] = (seededRandom() * 2 - 1) * env;
            right[i] = (seededRandom() * 2 - 1) * env;
        }

        return impulse;
    }

    // Initialize audio context and effects chain
    function init() {
        if (audioContext) return;

        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Master gain
        masterGain = audioContext.createGain();
        masterGain.gain.value = 0;
        masterGain.connect(audioContext.destination);

        // Panner
        pannerNode = audioContext.createStereoPanner();
        pannerNode.pan.value = 0;

        // Filter (lowpass for distance effect)
        filterNode = audioContext.createBiquadFilter();
        filterNode.type = 'lowpass';
        filterNode.frequency.value = 8000;
        filterNode.Q.value = 0.5;

        // Delay
        delayNode = audioContext.createDelay(2);
        delayNode.delayTime.value = 0.4;
        delayFeedback = audioContext.createGain();
        delayFeedback.gain.value = 0.3;
        delayGain = audioContext.createGain();
        delayGain.gain.value = 0;

        delayNode.connect(delayFeedback);
        delayFeedback.connect(delayNode);
        delayNode.connect(delayGain);

        // Reverb
        reverbNode = audioContext.createConvolver();
        reverbNode.buffer = createReverbImpulse(4, 2);
        reverbGain = audioContext.createGain();
        reverbGain.gain.value = 0;

        reverbNode.connect(reverbGain);

        // Connect chain
        pannerNode.connect(filterNode);
        filterNode.connect(delayNode);
        filterNode.connect(reverbNode);
        filterNode.connect(masterGain);
        delayGain.connect(masterGain);
        reverbGain.connect(masterGain);
    }

    // Smooth parameter transitions
    function smoothParam(param, value, time) {
        param.setTargetAtTime(value, audioContext.currentTime, time);
    }

    // Update spatial parameters based on position
    function updateSpatial() {
        if (!audioContext || !isRunning) return;

        // Smooth position interpolation
        position.x += (targetPosition.x - position.x) * 0.1;
        position.y += (targetPosition.y - position.y) * 0.1;

        const now = audioContext.currentTime;

        // X = panning (-1 to 1)
        const pan = (position.x - 0.5) * 2;
        smoothParam(pannerNode.pan, pan, 0.1);

        // Y = depth (0 = close/dry, 1 = far/wet)
        const depth = position.y;

        // Filter: close = bright, far = muffled
        const filterFreq = 2000 + (1 - depth) * 10000;
        smoothParam(filterNode.frequency, filterFreq, 0.2);

        // Reverb: more when far
        const reverbAmount = depth * 0.6;
        smoothParam(reverbGain.gain, reverbAmount, 0.3);

        // Delay: more when far
        const delayAmount = depth * 0.4;
        smoothParam(delayGain.gain, delayAmount, 0.3);
        smoothParam(delayFeedback.gain, 0.2 + depth * 0.4, 0.3);

        requestAnimationFrame(updateSpatial);
    }

    // === DRONE LAYER ===
    function createDrone() {
        const droneGain = audioContext.createGain();
        droneGain.gain.value = 0;
        droneGain.connect(pannerNode);

        // Multiple low oscillators with slight detuning
        const freqs = [
            noteToFreq(0),      // C2
            noteToFreq(0) * 2,  // C3
            noteToFreq(7),      // G2
        ];

        freqs.forEach((freq, i) => {
            const osc = audioContext.createOscillator();
            osc.type = i === 0 ? 'sine' : 'triangle';
            osc.frequency.value = freq;

            // Subtle drift
            const lfo = audioContext.createOscillator();
            const lfoGain = audioContext.createGain();
            lfo.frequency.value = 0.05 + seededRandom() * 0.1;
            lfoGain.gain.value = freq * 0.002;
            lfo.connect(lfoGain);
            lfoGain.connect(osc.frequency);
            lfo.start();

            const oscGain = audioContext.createGain();
            oscGain.gain.value = 0.15 / (i + 1);

            osc.connect(oscGain);
            oscGain.connect(droneGain);
            osc.start();

            droneNodes.push({ osc, lfo, oscGain });
        });

        // Fade in
        droneGain.gain.setTargetAtTime(1, audioContext.currentTime, 3);

        return droneGain;
    }

    // === TEXTURE LAYER ===
    function createTexture() {
        const textureGain = audioContext.createGain();
        textureGain.gain.value = 0;
        textureGain.connect(pannerNode);

        // Filtered noise
        const bufferSize = audioContext.sampleRate * 4;
        const noiseBuffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = seededRandom() * 2 - 1;
        }

        const noise = audioContext.createBufferSource();
        noise.buffer = noiseBuffer;
        noise.loop = true;

        // Bandpass filter for texture character
        const bp = audioContext.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 400;
        bp.Q.value = 2;

        // Slow modulation of filter
        const lfo = audioContext.createOscillator();
        const lfoGain = audioContext.createGain();
        lfo.frequency.value = 0.03;
        lfoGain.gain.value = 300;
        lfo.connect(lfoGain);
        lfoGain.connect(bp.frequency);
        lfo.start();

        noise.connect(bp);
        bp.connect(textureGain);
        noise.start();

        // Very subtle
        textureGain.gain.setTargetAtTime(0.08, audioContext.currentTime, 4);

        return { noise, lfo, bp, gain: textureGain };
    }

    // === EVENT LAYER ===
    function scheduleEvent() {
        if (!isRunning) return;

        // Random interval (5-20 seconds)
        const interval = 5000 + seededRandom() * 15000;

        eventTimeout = setTimeout(() => {
            if (!isRunning) return;
            playEvent();
            scheduleEvent();
        }, interval);
    }

    function playEvent() {
        // Random note from scale
        const octave = Math.floor(seededRandom() * 3) + 2; // Octaves 2-4
        const scaleNote = SCALE[Math.floor(seededRandom() * SCALE.length)];
        const note = scaleNote + octave * 12;
        const freq = noteToFreq(note);

        // Create event sound
        const osc = audioContext.createOscillator();
        const oscGain = audioContext.createGain();

        osc.type = seededRandom() > 0.5 ? 'sine' : 'triangle';
        osc.frequency.value = freq;

        // Envelope
        const now = audioContext.currentTime;
        const attack = 0.5 + seededRandom() * 1;
        const hold = 1 + seededRandom() * 3;
        const release = 2 + seededRandom() * 4;

        oscGain.gain.setValueAtTime(0, now);
        oscGain.gain.linearRampToValueAtTime(0.1, now + attack);
        oscGain.gain.setValueAtTime(0.1, now + attack + hold);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + attack + hold + release);

        osc.connect(oscGain);
        oscGain.connect(pannerNode);

        osc.start(now);
        osc.stop(now + attack + hold + release + 0.1);

        // Random panning for the event
        const eventPan = audioContext.createStereoPanner();
        eventPan.pan.value = (seededRandom() - 0.5) * 1.5;
        oscGain.disconnect();
        oscGain.connect(eventPan);
        eventPan.connect(pannerNode);
    }

    // === PUBLIC API ===
    return {
        start: function() {
            if (isRunning) return;

            init();

            if (audioContext.state === 'suspended') {
                audioContext.resume();
            }

            isRunning = true;

            // Start layers
            createDrone();
            textureNode = createTexture();
            scheduleEvent();

            // Start spatial update loop
            updateSpatial();

            // Fade in master
            masterGain.gain.setTargetAtTime(1, audioContext.currentTime, 2);
        },

        stop: function() {
            if (!isRunning) return;
            isRunning = false;

            // Clear event timer
            if (eventTimeout) {
                clearTimeout(eventTimeout);
            }

            // Fade out and cleanup
            if (masterGain) {
                masterGain.gain.setTargetAtTime(0, audioContext.currentTime, 1);
            }
        },

        setPosition: function(x, y) {
            targetPosition.x = Math.max(0, Math.min(1, x));
            targetPosition.y = Math.max(0, Math.min(1, y));
        },

        isRunning: function() {
            return isRunning;
        }
    };
})();
