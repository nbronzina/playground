// ============================================
// MK-DWELL - Generative Audio Engine v2
// Positioned sources + global atmosphere
// ============================================

const DwellAudio = (function() {
    let audioContext = null;
    let masterGain = null;
    let isRunning = false;

    // Spatial processing nodes (for global atmosphere)
    let reverbNode = null;
    let reverbGain = null;
    let delayNode = null;
    let delayFeedback = null;
    let delayGain = null;
    let filterNode = null;
    let pannerNode = null;

    // Global atmosphere layers
    let droneNodes = [];
    let droneGain = null;
    let textureNode = null;
    let nextEventTime = 0;

    // Scheduling
    let schedulerTimeout = null;
    let spatialFramePending = false;
    const SCHEDULE_AHEAD = 0.2;
    const SCHEDULER_INTERVAL = 50;

    // Positioned sources
    let sources = [];
    const SOURCE_GAIN_MAX = 0.8;  // Max gain - sources should be LOUD when close
    const DISTANCE_FACTOR = 12;   // Very steep falloff - focused listening

    // Current cursor position (0-1)
    let position = { x: 0.5, y: 0.5 };

    // Seeded random (xorshift32: a short-period LCG repeats audibly inside the 4 s reverb IR)
    let seed = (Date.now() >>> 0) || 1;

    function seededRandom() {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        return seed / 4294967296;
    }

    // Scales for melodic content
    const SCALE = [0, 2, 4, 7, 9]; // C pentatonic
    const BASE_FREQ = 65.41; // C2

    function noteToFreq(note) {
        return BASE_FREQ * Math.pow(2, note / 12);
    }

    // Free pitches land on the nearest scale note: inside the space nothing can sound wrong
    function snapToScale(freq) {
        const semitones = 12 * Math.log2(freq / BASE_FREQ);
        const octave = Math.floor(semitones / 12) * 12;
        let nearest = octave + SCALE[0];
        for (let i = 1; i <= SCALE.length; i++) {
            const note = octave + (i < SCALE.length ? SCALE[i] : 12);
            if (Math.abs(note - semitones) < Math.abs(nearest - semitones)) nearest = note;
        }
        return noteToFreq(nearest);
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

        // Panner (for global atmosphere)
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

        // Connect global atmosphere chain
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

    // ============================================
    // POSITIONED SOURCES SYSTEM
    // ============================================

    // Source definitions - each VERY DISTINCT timbre, spread to corners
    const SOURCE_DEFINITIONS = [
        {
            // 1. WARM BELL - top left corner
            name: 'bell',
            x: 0.1, y: 0.1,
            create: function(ctx, output) {
                const gain = ctx.createGain();
                gain.gain.value = 0;

                // Warm bell: triangle waves, lower register
                const osc1 = ctx.createOscillator();
                const osc2 = ctx.createOscillator();
                osc1.type = 'triangle';
                osc2.type = 'triangle';
                osc1.frequency.value = 440; // A4
                osc2.frequency.value = 440 * 1.5; // E5 (fifth)

                // Lowpass filter to soften
                const filter = ctx.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.value = 1800;
                filter.Q.value = 0.5;

                const oscGain = ctx.createGain();
                oscGain.gain.value = 0.4;

                osc1.connect(oscGain);
                osc2.connect(oscGain);
                oscGain.connect(filter);
                filter.connect(gain);
                gain.connect(output);

                osc1.start();
                osc2.start();

                return { gain, nodes: [osc1, osc2] };
            }
        },
        {
            // 2. RAIN/WIND TEXTURE - top right corner
            name: 'rain',
            x: 0.9, y: 0.1,
            create: function(ctx, output) {
                const gain = ctx.createGain();
                gain.gain.value = 0;

                const bufferSize = ctx.sampleRate * 2;
                const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
                const data = noiseBuffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) {
                    data[i] = seededRandom() * 2 - 1;
                }

                const noise = ctx.createBufferSource();
                noise.buffer = noiseBuffer;
                noise.loop = true;

                // Bandpass filter for rain-like texture
                const filter = ctx.createBiquadFilter();
                filter.type = 'bandpass';
                filter.frequency.value = 2000;
                filter.Q.value = 0.8;

                // Subtle LFO on filter for movement
                const lfo = ctx.createOscillator();
                const lfoGain = ctx.createGain();
                lfo.frequency.value = 0.15;
                lfoGain.gain.value = 500;
                lfo.connect(lfoGain);
                lfoGain.connect(filter.frequency);
                lfo.start();

                const noiseGain = ctx.createGain();
                noiseGain.gain.value = 0.2; // Lower gain

                noise.connect(filter);
                filter.connect(noiseGain);
                noiseGain.connect(gain);
                gain.connect(output);

                noise.start();

                return { gain, nodes: [noise, lfo] };
            }
        },
        {
            // 3. DEEP SUB BASS - bottom left corner
            name: 'sub',
            x: 0.1, y: 0.9,
            create: function(ctx, output) {
                const gain = ctx.createGain();
                gain.gain.value = 0;

                // Fundamental E1 (~41Hz): a free 40Hz sat a quarter tone flat of the scale
                const fundamental = snapToScale(40);
                const osc1 = ctx.createOscillator();
                osc1.type = 'sine';
                osc1.frequency.value = fundamental;

                // Octave harmonic for definition on smaller speakers
                const osc2 = ctx.createOscillator();
                osc2.type = 'sine';
                osc2.frequency.value = fundamental * 2;

                const oscGain = ctx.createGain();
                oscGain.gain.value = 1.4; // Boosted for presence

                const harmonicGain = ctx.createGain();
                harmonicGain.gain.value = 0.4; // Subtle harmonic

                osc1.connect(oscGain);
                osc2.connect(harmonicGain);
                oscGain.connect(gain);
                harmonicGain.connect(gain);
                gain.connect(output);

                osc1.start();
                osc2.start();

                return { gain, nodes: [osc1, osc2] };
            }
        },
        {
            // 4. RHYTHMIC CLICKS - bottom right corner
            name: 'clicks',
            x: 0.9, y: 0.9,
            create: function(ctx, output) {
                const gain = ctx.createGain();
                gain.gain.value = 0;

                const clickGain = ctx.createGain();
                clickGain.gain.value = 1;
                clickGain.connect(gain);
                gain.connect(output);

                let nextClickTime = 0;

                function clickInterval() {
                    return 0.1 + seededRandom() * 0.3; // Fast clicks
                }

                function playClick(time) {
                    const clickOsc = ctx.createOscillator();
                    const clickEnv = ctx.createGain();

                    clickOsc.type = 'square';
                    clickOsc.frequency.value = snapToScale(1000 + seededRandom() * 2000);

                    clickEnv.gain.setValueAtTime(0.6, time);
                    clickEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.01);

                    clickOsc.connect(clickEnv);
                    clickEnv.connect(clickGain);

                    clickOsc.onended = () => {
                        clickOsc.disconnect();
                        clickEnv.disconnect();
                    };

                    clickOsc.start(time);
                    clickOsc.stop(time + 0.02);
                }

                return {
                    gain,
                    nodes: [],
                    reset: function(time) {
                        nextClickTime = time + clickInterval();
                    },
                    schedule: function(until) {
                        nextClickTime = Math.max(nextClickTime, ctx.currentTime);
                        while (nextClickTime < until) {
                            playClick(nextClickTime);
                            nextClickTime += clickInterval();
                        }
                    }
                };
            }
        },
        {
            // 5. BREATHING PAD - center (calm refuge)
            name: 'breath',
            x: 0.5, y: 0.5,
            create: function(ctx, output) {
                const gain = ctx.createGain();
                gain.gain.value = 0;

                // Soft chord: C + E + G (major triad, LOW register)
                const osc1 = ctx.createOscillator();
                const osc2 = ctx.createOscillator();
                const osc3 = ctx.createOscillator();
                osc1.type = 'sine';
                osc2.type = 'sine';
                osc3.type = 'sine';
                osc1.frequency.value = 131; // C3
                osc2.frequency.value = 165; // E3
                osc3.frequency.value = 196; // G3

                // Lowpass filter for warmth
                const filter = ctx.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.value = 800;
                filter.Q.value = 0.3;

                // Very slow volume breathing
                const lfo = ctx.createOscillator();
                const lfoGain = ctx.createGain();
                lfo.frequency.value = 0.08; // Even slower breath
                lfoGain.gain.value = 0.1;
                lfo.start();

                const chordGain = ctx.createGain();
                chordGain.gain.value = 0.25;
                lfo.connect(lfoGain);
                lfoGain.connect(chordGain.gain);

                osc1.connect(chordGain);
                osc2.connect(chordGain);
                osc3.connect(chordGain);
                chordGain.connect(filter);
                filter.connect(gain);
                gain.connect(output);

                osc1.start();
                osc2.start();
                osc3.start();

                return { gain, nodes: [osc1, osc2, osc3, lfo] };
            }
        }
    ];

    function createSources() {
        sources = [];

        SOURCE_DEFINITIONS.forEach(def => {
            const source = def.create(audioContext, masterGain);
            sources.push({
                name: def.name,
                x: def.x,
                y: def.y,
                gain: source.gain,
                nodes: source.nodes,
                reset: source.reset,
                schedule: source.schedule
            });
        });
    }

    function updateSourceGains() {
        sources.forEach(source => {
            const dx = position.x - source.x;
            const dy = position.y - source.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // Inverse distance attenuation
            const gain = SOURCE_GAIN_MAX / (1 + distance * DISTANCE_FACTOR);

            smoothParam(source.gain.gain, gain, 0.1);
        });
    }

    // ============================================
    // GLOBAL ATMOSPHERE (existing system)
    // ============================================

    function requestSpatialUpdate() {
        if (spatialFramePending || !isRunning) return;
        spatialFramePending = true;
        requestAnimationFrame(updateSpatial);
    }

    // Update spatial parameters based on position
    function updateSpatial() {
        spatialFramePending = false;
        if (!audioContext || !isRunning) return;

        // X = panning (-1 to 1) - FULL stereo
        const pan = (position.x - 0.5) * 2;
        smoothParam(pannerNode.pan, pan, 0.02); // Faster response

        // Y = depth (0 = close/bright, 1 = far/muffled)
        const depth = position.y;

        // Filter: EXTREME sweep - 200Hz to 16000Hz
        const filterFreq = 200 + (1 - depth) * 15800;
        smoothParam(filterNode.frequency, filterFreq, 0.03); // Faster

        // Reverb: dramatic difference
        const reverbAmount = 0.1 + depth * 0.8;
        smoothParam(reverbGain.gain, reverbAmount, 0.05);

        // Delay: none to lots
        const delayAmount = depth * 0.7;
        smoothParam(delayGain.gain, delayAmount, 0.05);
        smoothParam(delayFeedback.gain, depth * 0.6, 0.05);

        // Update positioned sources
        updateSourceGains();
    }

    // === DRONE LAYER ===
    function createDrone() {
        const droneGain = audioContext.createGain();
        droneGain.gain.value = 0;
        droneGain.connect(pannerNode);

        const voices = [
            { freq: noteToFreq(0), type: 'sine', pan: -0.3 },
            { freq: noteToFreq(0) * 2, type: 'triangle', pan: 0 },
            { freq: noteToFreq(7), type: 'triangle', pan: 0.3 },
        ];

        voices.forEach((voice, i) => {
            const osc = audioContext.createOscillator();
            osc.type = voice.type;
            osc.frequency.value = voice.freq;

            const lfo = audioContext.createOscillator();
            const lfoGain = audioContext.createGain();
            lfo.frequency.value = 0.05 + seededRandom() * 0.1;
            lfoGain.gain.value = voice.freq * 0.003;
            lfo.connect(lfoGain);
            lfoGain.connect(osc.frequency);
            lfo.start();

            const voicePan = audioContext.createStereoPanner();
            voicePan.pan.value = voice.pan;

            const oscGain = audioContext.createGain();
            oscGain.gain.value = 0.04 / (i + 1); // VERY quiet - just background

            osc.connect(oscGain);
            oscGain.connect(voicePan);
            voicePan.connect(droneGain);
            osc.start();

            droneNodes.push({ osc, lfo, oscGain, pan: voicePan });
        });

        return droneGain;
    }

    // === TEXTURE LAYER ===
    function createTexture() {
        const textureGain = audioContext.createGain();
        textureGain.gain.value = 0;
        textureGain.connect(pannerNode);

        const bufferSize = audioContext.sampleRate * 4;

        const noiseBufferL = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
        const dataL = noiseBufferL.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            dataL[i] = seededRandom() * 2 - 1;
        }

        const noiseBufferR = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
        const dataR = noiseBufferR.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            dataR[i] = seededRandom() * 2 - 1;
        }

        const noiseL = audioContext.createBufferSource();
        noiseL.buffer = noiseBufferL;
        noiseL.loop = true;

        const noiseR = audioContext.createBufferSource();
        noiseR.buffer = noiseBufferR;
        noiseR.loop = true;

        const bpL = audioContext.createBiquadFilter();
        bpL.type = 'bandpass';
        bpL.frequency.value = 350;
        bpL.Q.value = 2;

        const bpR = audioContext.createBiquadFilter();
        bpR.type = 'bandpass';
        bpR.frequency.value = 450;
        bpR.Q.value = 2;

        const lfoL = audioContext.createOscillator();
        const lfoGainL = audioContext.createGain();
        lfoL.frequency.value = 0.03;
        lfoGainL.gain.value = 250;
        lfoL.connect(lfoGainL);
        lfoGainL.connect(bpL.frequency);
        lfoL.start();

        const lfoR = audioContext.createOscillator();
        const lfoGainR = audioContext.createGain();
        lfoR.frequency.value = 0.04;
        lfoGainR.gain.value = 300;
        lfoR.connect(lfoGainR);
        lfoGainR.connect(bpR.frequency);
        lfoR.start();

        const panL = audioContext.createStereoPanner();
        panL.pan.value = -0.6;
        const panR = audioContext.createStereoPanner();
        panR.pan.value = 0.6;

        noiseL.connect(bpL);
        bpL.connect(panL);
        panL.connect(textureGain);

        noiseR.connect(bpR);
        bpR.connect(panR);
        panR.connect(textureGain);

        noiseL.start();
        noiseR.start();

        return { noiseL, noiseR, lfoL, lfoR, bpL, bpR, gain: textureGain };
    }

    // === EVENT LAYER ===
    function eventInterval() {
        return 5 + seededRandom() * 15;
    }

    function scheduleEvents(until) {
        nextEventTime = Math.max(nextEventTime, audioContext.currentTime);
        while (nextEventTime < until) {
            playEvent(nextEventTime);
            nextEventTime += eventInterval();
        }
    }

    function playEvent(time) {
        const octave = Math.floor(seededRandom() * 3) + 2;
        const scaleNote = SCALE[Math.floor(seededRandom() * SCALE.length)];
        const note = scaleNote + octave * 12;
        const freq = noteToFreq(note);

        const osc = audioContext.createOscillator();
        const oscGain = audioContext.createGain();

        osc.type = seededRandom() > 0.5 ? 'sine' : 'triangle';
        osc.frequency.value = freq;

        const attack = 0.5 + seededRandom() * 1;
        const hold = 1 + seededRandom() * 3;
        const release = 2 + seededRandom() * 4;

        oscGain.gain.setValueAtTime(0, time);
        oscGain.gain.linearRampToValueAtTime(0.08, time + attack);
        oscGain.gain.setValueAtTime(0.08, time + attack + hold);
        oscGain.gain.exponentialRampToValueAtTime(0.001, time + attack + hold + release);

        const eventPan = audioContext.createStereoPanner();
        eventPan.pan.value = (seededRandom() - 0.5) * 1.5;

        osc.connect(oscGain);
        oscGain.connect(eventPan);
        eventPan.connect(pannerNode);

        osc.onended = () => {
            osc.disconnect();
            oscGain.disconnect();
            eventPan.disconnect();
        };

        osc.start(time);
        osc.stop(time + attack + hold + release + 0.1);
    }

    // === SCHEDULER ===
    // Timer only wakes the scheduler; every event is placed on the audio clock
    function scheduler() {
        if (!isRunning) return;

        const until = audioContext.currentTime + SCHEDULE_AHEAD;
        scheduleEvents(until);
        sources.forEach(source => {
            if (source.schedule) source.schedule(until);
        });

        schedulerTimeout = setTimeout(scheduler, SCHEDULER_INTERVAL);
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

            // Built once: rebuilding on every entry stacked layers that never stopped
            if (!droneGain) {
                droneGain = createDrone();
                textureNode = createTexture();
                createSources();
            }

            const now = audioContext.currentTime;

            // Reset so every entry emerges like the first
            droneGain.gain.setValueAtTime(0, now);
            droneGain.gain.setTargetAtTime(0.5, now, 3); // Lower
            textureNode.gain.gain.setValueAtTime(0, now);
            textureNode.gain.gain.setTargetAtTime(0.03, now, 4); // VERY quiet

            nextEventTime = now + eventInterval();
            sources.forEach(source => {
                if (source.reset) source.reset(now);
            });
            scheduler();

            requestSpatialUpdate();

            // Fade in master - gradual emergence from silence
            masterGain.gain.setValueAtTime(0, now);
            masterGain.gain.linearRampToValueAtTime(1, now + 4);
        },

        stop: function() {
            if (!isRunning) return;
            isRunning = false;

            clearTimeout(schedulerTimeout);

            if (masterGain) {
                masterGain.gain.setTargetAtTime(0, audioContext.currentTime, 1);
            }
        },

        setPosition: function(x, y) {
            position.x = Math.max(0, Math.min(1, x));
            position.y = Math.max(0, Math.min(1, y));
            requestSpatialUpdate();
        },

        isRunning: function() {
            return isRunning;
        }
    };
})();
