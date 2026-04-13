const TWO_PI = 6.283185307179586;

class DrumEngineProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        const sr = sampleRate;

        // Shared noise buffer — 1 second
        const nLen = sr;
        this.nBuf = new Float32Array(nLen);
        for (let i = 0; i < nLen; i++) this.nBuf[i] = Math.random() * 2 - 1;
        this.nLen = nLen;

        // Hihat base frequencies and per-osc gain weights
        this.hhBaseF = new Float32Array([298, 366, 441, 528, 634, 748, 891, 1103]);
        this.hhOscG = new Float32Array([0.6, 0.3, 0.2, 0.15, 0.12, 0.1, 0.0857, 0.075]);

        // --- Voice states ---
        this.kick = {
            on: false, t: 0,
            // click osc phase, body osc phase, sub osc phase
            cp: 0, bp: 0, sp: 0,
            // sub lowpass filter state
            sf: this._mkF()
        };

        this.snare = {
            on: false, t: 0,
            // crack phase, body1 phase, body2 phase
            cp: 0, b1p: 0, b2p: 0,
            // noise read index
            ni: 0,
            // body peaking filter, noise HP, noise LP
            bf: this._mkF(), nhp: this._mkF(), nlp: this._mkF()
        };

        this.hihat = {
            on: false, t: 0,
            // 8 oscillator phases and randomized frequencies
            ph: new Float32Array(8),
            fr: new Float32Array(8),
            // metal HP filter, noise HP filter
            mf: this._mkF(), nf: this._mkF(),
            ni: 0
        };

        this.clap = {
            on: false, t: 0,
            // 4 burst delays (samples), 4 burst filter freqs, noise offsets for 5 sources
            del: new Float32Array(4),
            bfr: new Float32Array(4),
            nOff: new Float32Array(5),
            // 4 burst BP filters + 1 tail BP filter
            bf0: this._mkF(), bf1: this._mkF(), bf2: this._mkF(), bf3: this._mkF(),
            tf: this._mkF()
        };

        this.tom = {
            on: false, t: 0,
            // body phase, overtone phase, noise index
            bp: 0, op: 0, ni: 0,
            // body lowpass filter
            bf: this._mkF()
        };

        this.perc = {
            on: false, t: 0,
            // carrier phase, modulator phase
            cp: 0, mp: 0,
            // output bandpass filter
            cf: this._mkF()
        };

        // Cymbal base frequencies
        this.cyBaseF = new Float32Array([205, 295, 375, 505, 625, 835, 1015, 1205, 1555, 2015]);

        this.cymbal = {
            on: false, t: 0,
            // 10 oscillator phases and randomized frequencies
            ph: new Float32Array(10),
            fr: new Float32Array(10),
            // metal HP filter, noise HP filter
            mf: this._mkF(), nf: this._mkF(),
            ni: 0
        };

        this.rim = {
            on: false, t: 0,
            // click phase, body phase
            cp: 0, bp: 0,
            // click highpass, body bandpass
            chp: this._mkF(), bbp: this._mkF()
        };

        this.port.onmessage = (e) => {
            if (e.data.type === 'trigger') this._trig(e.data.voice);
        };
    }

    // ========= Filter factory (constructor only) =========

    _mkF() {
        return { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 };
    }

    // ========= Filter coefficient computation =========

    _lpCoef(s, f, q) {
        q = q || 1;
        const w = TWO_PI * f / sampleRate, sw = Math.sin(w), cw = Math.cos(w);
        const a = sw / (2 * q), a0 = 1 + a;
        s.b0 = (1 - cw) / 2 / a0;
        s.b1 = (1 - cw) / a0;
        s.b2 = s.b0;
        s.a1 = -2 * cw / a0;
        s.a2 = (1 - a) / a0;
    }

    _hpCoef(s, f, q) {
        q = q || 1;
        const w = TWO_PI * f / sampleRate, sw = Math.sin(w), cw = Math.cos(w);
        const a = sw / (2 * q), a0 = 1 + a;
        s.b0 = (1 + cw) / 2 / a0;
        s.b1 = -(1 + cw) / a0;
        s.b2 = s.b0;
        s.a1 = -2 * cw / a0;
        s.a2 = (1 - a) / a0;
    }

    _bpCoef(s, f, q) {
        q = q || 1;
        const w = TWO_PI * f / sampleRate, sw = Math.sin(w), cw = Math.cos(w);
        const a = sw / (2 * q), a0 = 1 + a;
        s.b0 = a / a0;
        s.b1 = 0;
        s.b2 = -a / a0;
        s.a1 = -2 * cw / a0;
        s.a2 = (1 - a) / a0;
    }

    _pkCoef(s, f, q, dB) {
        const A = Math.pow(10, dB / 40);
        const w = TWO_PI * f / sampleRate, sw = Math.sin(w), cw = Math.cos(w);
        const a = sw / (2 * q), a0 = 1 + a / A;
        s.b0 = (1 + a * A) / a0;
        s.b1 = -2 * cw / a0;
        s.b2 = (1 - a * A) / a0;
        s.a1 = -2 * cw / a0;
        s.a2 = (1 - a / A) / a0;
    }

    // ========= DSP primitives (inlined in hot paths, methods for clarity) =========

    _filt(s, x) {
        const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
        s.x2 = s.x1; s.x1 = x;
        s.y2 = s.y1; s.y1 = y;
        return y;
    }

    _rstF(s) { s.x1 = s.x2 = s.y1 = s.y2 = 0; }

    // Exponential value at time t: v0 → v1 over dur seconds
    _ea(v0, v1, t, dur) {
        if (t <= 0) return v0;
        if (t >= dur) return v1;
        return v0 * Math.pow(v1 / v0, t / dur);
    }

    // Per-sample multiplier for exponential interpolation across n samples
    _em(v0, v1, n) {
        if (n <= 1 || v0 <= 0 || v1 <= 0) return 1;
        return Math.pow(v1 / v0, 1 / n);
    }

    // ========= Trigger =========

    _trig(voice) {
        const key = voice === 'tom1' ? 'tom' : voice;
        const v = this[key];
        if (!v) return;

        v.on = true;
        v.t = 0;

        switch (key) {
            case 'kick':
                v.cp = v.bp = v.sp = 0;
                this._lpCoef(v.sf, 60, 1);
                this._rstF(v.sf);
                break;

            case 'snare':
                v.cp = v.b1p = v.b2p = 0;
                v.ni = (Math.random() * this.nLen) | 0;
                this._pkCoef(v.bf, 220, 3, 6);
                this._rstF(v.bf);
                this._hpCoef(v.nhp, 2500);
                this._rstF(v.nhp);
                this._lpCoef(v.nlp, 12000);
                this._rstF(v.nlp);
                break;

            case 'hihat':
                for (let i = 0; i < 8; i++) {
                    v.ph[i] = 0;
                    v.fr[i] = this.hhBaseF[i] * (1 + Math.random() * 0.025);
                }
                this._hpCoef(v.mf, 6000);
                this._rstF(v.mf);
                v.ni = (Math.random() * this.nLen) | 0;
                this._hpCoef(v.nf, 9000);
                this._rstF(v.nf);
                break;

            case 'clap': {
                const sr = sampleRate;
                for (let i = 0; i < 4; i++) {
                    v.del[i] = ((i * 0.012 + Math.random() * 0.005) * sr) | 0;
                    v.bfr[i] = 1200 + Math.random() * 400;
                    v.nOff[i] = (Math.random() * this.nLen) | 0;
                }
                v.nOff[4] = (Math.random() * this.nLen) | 0;
                this._bpCoef(v.bf0, v.bfr[0], 2);  this._rstF(v.bf0);
                this._bpCoef(v.bf1, v.bfr[1], 2);  this._rstF(v.bf1);
                this._bpCoef(v.bf2, v.bfr[2], 2);  this._rstF(v.bf2);
                this._bpCoef(v.bf3, v.bfr[3], 2);  this._rstF(v.bf3);
                this._bpCoef(v.tf, 1000, 1);        this._rstF(v.tf);
                break;
            }

            case 'tom':
                v.bp = v.op = 0;
                v.ni = (Math.random() * this.nLen) | 0;
                this._lpCoef(v.bf, 600, 1);
                this._rstF(v.bf);
                break;

            case 'perc':
                v.cp = v.mp = 0;
                this._bpCoef(v.cf, 2000, 3);
                this._rstF(v.cf);
                break;

            case 'cymbal':
                for (let i = 0; i < 10; i++) {
                    v.ph[i] = 0;
                    v.fr[i] = this.cyBaseF[i] * (1 + Math.random() * 0.03);
                }
                this._hpCoef(v.mf, 4000);
                this._rstF(v.mf);
                v.ni = (Math.random() * this.nLen) | 0;
                this._hpCoef(v.nf, 9000);
                this._rstF(v.nf);
                break;

            case 'rim':
                v.cp = v.bp = 0;
                this._hpCoef(v.chp, 1500);
                this._rstF(v.chp);
                this._bpCoef(v.bbp, 350, 8);
                this._rstF(v.bbp);
                break;
        }
    }

    // ========= Voice renderers =========

    _renderKick(out, n) {
        const k = this.kick, sr = sampleRate;
        const t0 = k.t / sr;
        const t1 = (k.t + n) / sr;

        // --- Click: triangle 4500→150 / 8ms, hardClip, gain 0.9→0.001 / 15ms ---
        if (t0 < 0.015) {
            const end = Math.min(n, ((0.015 * sr) | 0) - k.t);
            if (end > 0) {
                const te = (k.t + end) / sr;
                const f0 = this._ea(4500, 150, t0, 0.008);
                const f1 = this._ea(4500, 150, te, 0.008);
                const g0 = this._ea(0.9, 0.001, t0, 0.015);
                const g1 = this._ea(0.9, 0.001, te, 0.015);
                const fm = this._em(f0, f1, end);
                const gm = this._em(g0, g1, end);
                let fr = f0, gn = g0, ph = k.cp;
                for (let i = 0; i < end; i++) {
                    const p = ph - (ph | 0);
                    const tri = 1 - 4 * Math.abs(p - 0.5);
                    const cl = tri * 3;
                    out[i] += (cl > 0.8 ? 0.8 : cl < -0.8 ? -0.8 : cl) * gn;
                    ph += fr / sr;
                    fr *= fm;
                    gn *= gm;
                }
                k.cp = ph;
            }
        }

        // --- Body: sine 160→55/35ms→40/150ms, tanh2.5, gain 1.4→0.001 / 450ms ---
        if (t0 < 0.45) {
            const end = Math.min(n, ((0.45 * sr) | 0) - k.t);
            if (end > 0) {
                const te = (k.t + end) / sr;
                const bf0 = t0 < 0.035
                    ? this._ea(160, 55, t0, 0.035)
                    : this._ea(55, 40, t0 - 0.035, 0.115);
                const bf1 = te < 0.035
                    ? this._ea(160, 55, te, 0.035)
                    : this._ea(55, 40, te - 0.035, 0.115);
                const g0 = this._ea(1.4, 0.001, t0, 0.45);
                const g1 = this._ea(1.4, 0.001, te, 0.45);
                const fm = this._em(bf0, bf1, end);
                const gm = this._em(g0, g1, end);
                let fr = bf0, gn = g0, ph = k.bp;
                for (let i = 0; i < end; i++) {
                    const s = Math.sin(TWO_PI * ph);
                    out[i] += Math.tanh(s * 2.5) * gn;
                    ph += fr / sr;
                    fr *= fm;
                    gn *= gm;
                }
                k.bp = ph - ((ph | 0) > 0 ? (ph | 0) : 0);
            }
        }

        // --- Sub: sine 55→35 / 250ms, LP 60Hz, gain 1.0→0.001 / 550ms ---
        if (t0 < 0.55) {
            const end = Math.min(n, ((0.55 * sr) | 0) - k.t);
            if (end > 0) {
                const te = (k.t + end) / sr;
                const f0 = this._ea(55, 35, t0, 0.25);
                const f1 = this._ea(55, 35, te, 0.25);
                const g0 = this._ea(1.0, 0.001, t0, 0.55);
                const g1 = this._ea(1.0, 0.001, te, 0.55);
                const fm = this._em(f0, f1, end);
                const gm = this._em(g0, g1, end);
                let fr = f0, gn = g0, ph = k.sp;
                for (let i = 0; i < end; i++) {
                    out[i] += this._filt(k.sf, Math.sin(TWO_PI * ph)) * gn;
                    ph += fr / sr;
                    fr *= fm;
                    gn *= gm;
                }
                k.sp = ph - ((ph | 0) > 0 ? (ph | 0) : 0);
            }
        }

        k.t += n;
        if (k.t / sr >= 0.6) k.on = false;
    }

    _renderSnare(out, n) {
        const s = this.snare, sr = sampleRate;
        const t0 = s.t / sr;

        // --- Crack: triangle 1200→300 / 3ms, tanh4.0, gain 0.7→0.001 / 12ms ---
        if (t0 < 0.012) {
            const end = Math.min(n, ((0.012 * sr) | 0) - s.t);
            if (end > 0) {
                const te = (s.t + end) / sr;
                const f0 = this._ea(1200, 300, t0, 0.003);
                const f1 = this._ea(1200, 300, te, 0.003);
                const g0 = this._ea(0.7, 0.001, t0, 0.012);
                const g1 = this._ea(0.7, 0.001, te, 0.012);
                const fm = this._em(f0, f1, end);
                const gm = this._em(g0, g1, end);
                let fr = f0, gn = g0, ph = s.cp;
                for (let i = 0; i < end; i++) {
                    const p = ph - (ph | 0);
                    const tri = 1 - 4 * Math.abs(p - 0.5);
                    out[i] += Math.tanh(tri * 4.0) * gn;
                    ph += fr / sr;
                    fr *= fm;
                    gn *= gm;
                }
                s.cp = ph;
            }
        }

        // --- Body: tri 240→150/25ms + sine 185→110/40ms → peaking(220,Q3,+6dB) → gain 0.65→0.001/120ms ---
        if (t0 < 0.12) {
            const end = Math.min(n, ((0.12 * sr) | 0) - s.t);
            if (end > 0) {
                const te = (s.t + end) / sr;
                const fa0 = this._ea(240, 150, t0, 0.025);
                const fa1 = this._ea(240, 150, te, 0.025);
                const fb0 = this._ea(185, 110, t0, 0.04);
                const fb1 = this._ea(185, 110, te, 0.04);
                const g0 = this._ea(0.65, 0.001, t0, 0.12);
                const g1 = this._ea(0.65, 0.001, te, 0.12);
                const fma = this._em(fa0, fa1, end);
                const fmb = this._em(fb0, fb1, end);
                const gm = this._em(g0, g1, end);
                let fra = fa0, frb = fb0, gn = g0;
                let p1 = s.b1p, p2 = s.b2p;
                for (let i = 0; i < end; i++) {
                    const pa = p1 - (p1 | 0);
                    const mix = (1 - 4 * Math.abs(pa - 0.5)) + Math.sin(TWO_PI * p2);
                    out[i] += this._filt(s.bf, mix) * gn;
                    p1 += fra / sr;
                    p2 += frb / sr;
                    fra *= fma;
                    frb *= fmb;
                    gn *= gm;
                }
                s.b1p = p1 - ((p1 | 0) > 0 ? (p1 | 0) : 0);
                s.b2p = p2 - ((p2 | 0) > 0 ? (p2 | 0) : 0);
            }
        }

        // --- Noise: HP(2500) → LP(12000→5000/80ms) → gain 1.0→0.001/150ms ---
        if (t0 < 0.15) {
            const end = Math.min(n, ((0.15 * sr) | 0) - s.t);
            if (end > 0) {
                const te = (s.t + end) / sr;
                const g0 = this._ea(1.0, 0.001, t0, 0.15);
                const g1 = this._ea(1.0, 0.001, te, 0.15);
                const gm = this._em(g0, g1, end);
                // Recompute LP coefficients per-block for the sweep
                const lpf = this._ea(12000, 5000, (t0 + te) * 0.5, 0.08);
                this._lpCoef(s.nlp, lpf);
                let gn = g0;
                const nb = this.nBuf, nl = this.nLen;
                let ni = s.ni;
                for (let i = 0; i < end; i++) {
                    const raw = nb[ni % nl];
                    ni++;
                    out[i] += this._filt(s.nlp, this._filt(s.nhp, raw)) * gn;
                    gn *= gm;
                }
                s.ni = ni;
            }
        }

        s.t += n;
        if (s.t / sr >= 0.2) s.on = false;
    }

    _renderHihat(out, n) {
        const h = this.hihat, sr = sampleRate;
        const t0 = h.t / sr;

        // --- Metal: 8 square oscs → HP(6000) → gain 0.18→0.001/55ms ---
        if (t0 < 0.055) {
            const end = Math.min(n, ((0.055 * sr) | 0) - h.t);
            if (end > 0) {
                const te = (h.t + end) / sr;
                const g0 = this._ea(0.18, 0.001, t0, 0.055);
                const g1 = this._ea(0.18, 0.001, te, 0.055);
                const gm = this._em(g0, g1, end);
                let gn = g0;
                const ph = h.ph, fr = h.fr, og = this.hhOscG;
                for (let i = 0; i < end; i++) {
                    let mix = 0;
                    for (let j = 0; j < 8; j++) {
                        mix += ((ph[j] - ((ph[j] | 0) + (ph[j] < 0 ? -1 : 0))) < 0.5 ? 1 : -1) * og[j];
                        ph[j] += fr[j] / sr;
                    }
                    out[i] += this._filt(h.mf, mix) * gn;
                    gn *= gm;
                }
            }
        }

        // --- Noise: HP(9000) → gain 0.3→0.001/45ms, buffer 60ms ---
        if (t0 < 0.06) {
            const end = Math.min(n, ((0.06 * sr) | 0) - h.t);
            if (end > 0) {
                const te = (h.t + end) / sr;
                const g0 = this._ea(0.3, 0.001, t0, 0.045);
                const g1 = this._ea(0.3, 0.001, Math.min(te, 0.045), 0.045);
                const gm = this._em(g0, g1, end);
                let gn = g0;
                const nb = this.nBuf, nl = this.nLen;
                let ni = h.ni;
                for (let i = 0; i < end; i++) {
                    out[i] += this._filt(h.nf, nb[ni % nl]) * gn;
                    ni++;
                    gn *= gm;
                }
                h.ni = ni;
            }
        }

        h.t += n;
        if (h.t / sr >= 0.1) h.on = false;
    }

    _renderClap(out, n) {
        const c = this.clap, sr = sampleRate;
        const nb = this.nBuf, nl = this.nLen;
        const bFilts = [c.bf0, c.bf1, c.bf2, c.bf3];

        // --- 4 noise bursts: staggered, BP filtered, gain envelopes ---
        for (let b = 0; b < 4; b++) {
            const startSamp = c.del[b];
            const noiseDur = (0.03 * sr) | 0;
            const envDur = 0.08;
            const envEndSamp = startSamp + ((envDur * sr) | 0);

            if (c.t + n <= startSamp || c.t >= envEndSamp) continue;

            const lStart = startSamp > c.t ? startSamp - c.t : 0;
            const noiseEndSamp = startSamp + noiseDur;
            const lEnd = Math.min(n, envEndSamp - c.t, noiseEndSamp - c.t);
            if (lStart >= lEnd) continue;

            const count = lEnd - lStart;
            const burstG = b === 3 ? 0.7 : 0.4;
            const tb0 = (c.t + lStart - startSamp) / sr;
            const tb1 = (c.t + lEnd - startSamp) / sr;
            const g0 = this._ea(burstG, 0.001, tb0, envDur);
            const g1 = this._ea(burstG, 0.001, tb1, envDur);
            const gm = this._em(g0, g1, count);
            let gn = g0;
            let ni = c.nOff[b] + (c.t + lStart - startSamp);
            const bf = bFilts[b];

            for (let i = lStart; i < lEnd; i++) {
                out[i] += this._filt(bf, nb[ni % nl]) * gn;
                ni++;
                gn *= gm;
            }
        }

        // --- Tail: starts at 40ms, noise 150ms, BP(1000), gain 0.3→0.001 / 140ms ---
        const tailStart = (0.04 * sr) | 0;
        const tailNoiseDur = (0.15 * sr) | 0;
        const tailEnvDur = 0.14;
        const tailEnvEnd = tailStart + ((tailEnvDur * sr) | 0);

        if (c.t + n > tailStart && c.t < tailEnvEnd) {
            const lStart = tailStart > c.t ? tailStart - c.t : 0;
            const lEnd = Math.min(n, tailEnvEnd - c.t, tailStart + tailNoiseDur - c.t);
            if (lStart < lEnd) {
                const count = lEnd - lStart;
                const tt0 = (c.t + lStart - tailStart) / sr;
                const tt1 = (c.t + lEnd - tailStart) / sr;
                const g0 = this._ea(0.3, 0.001, tt0, tailEnvDur);
                const g1 = this._ea(0.3, 0.001, tt1, tailEnvDur);
                const gm = this._em(g0, g1, count);
                let gn = g0;
                let ni = c.nOff[4] + (c.t + lStart - tailStart);

                for (let i = lStart; i < lEnd; i++) {
                    out[i] += this._filt(c.tf, nb[ni % nl]) * gn;
                    ni++;
                    gn *= gm;
                }
            }
        }

        c.t += n;
        if (c.t / sr >= 0.25) c.on = false;
    }

    _renderTom(out, n) {
        const v = this.tom, sr = sampleRate;
        const t0 = v.t / sr;

        // --- Body: sine 280→110 / 300ms, LP(600), gain 1.0→0.001 / 400ms ---
        if (t0 < 0.4) {
            const end = Math.min(n, ((0.4 * sr) | 0) - v.t);
            if (end > 0) {
                const te = (v.t + end) / sr;
                const f0 = this._ea(280, 110, t0, 0.3);
                const f1 = this._ea(280, 110, te, 0.3);
                const g0 = this._ea(1.0, 0.001, t0, 0.4);
                const g1 = this._ea(1.0, 0.001, te, 0.4);
                const fm = this._em(f0, f1, end);
                const gm = this._em(g0, g1, end);
                let fr = f0, gn = g0, ph = v.bp;
                for (let i = 0; i < end; i++) {
                    out[i] += this._filt(v.bf, Math.sin(TWO_PI * ph)) * gn;
                    ph += fr / sr;
                    fr *= fm;
                    gn *= gm;
                }
                v.bp = ph - ((ph | 0) > 0 ? (ph | 0) : 0);
            }
        }

        // --- Overtone: triangle 560→220 / 50ms, gain 0.3→0.001 / 100ms ---
        if (t0 < 0.1) {
            const end = Math.min(n, ((0.1 * sr) | 0) - v.t);
            if (end > 0) {
                const te = (v.t + end) / sr;
                const f0 = this._ea(560, 220, t0, 0.05);
                const f1 = this._ea(560, 220, te, 0.05);
                const g0 = this._ea(0.3, 0.001, t0, 0.1);
                const g1 = this._ea(0.3, 0.001, te, 0.1);
                const fm = this._em(f0, f1, end);
                const gm = this._em(g0, g1, end);
                let fr = f0, gn = g0, ph = v.op;
                for (let i = 0; i < end; i++) {
                    const p = ph - (ph | 0);
                    out[i] += (1 - 4 * Math.abs(p - 0.5)) * gn;
                    ph += fr / sr;
                    fr *= fm;
                    gn *= gm;
                }
                v.op = ph;
            }
        }

        // --- Click noise: 10ms noise, gain 0.25→0.001 / 15ms ---
        if (t0 < 0.01) {
            const end = Math.min(n, ((0.01 * sr) | 0) - v.t);
            if (end > 0) {
                const te = (v.t + end) / sr;
                const g0 = this._ea(0.25, 0.001, t0, 0.015);
                const g1 = this._ea(0.25, 0.001, te, 0.015);
                const gm = this._em(g0, g1, end);
                let gn = g0;
                const nb = this.nBuf, nl = this.nLen;
                let ni = v.ni;
                for (let i = 0; i < end; i++) {
                    out[i] += nb[ni % nl] * gn;
                    ni++;
                    gn *= gm;
                }
                v.ni = ni;
            }
        }

        v.t += n;
        if (v.t / sr >= 0.45) v.on = false;
    }

    _renderPerc(out, n) {
        const p = this.perc, sr = sampleRate;
        const t0 = p.t / sr;

        // --- FM: mod sine(2400) × modGain(800→10/100ms) → carrier sine(1800+FM) → BP(2000,Q3) → gain 0.4→0.001/100ms ---
        if (t0 < 0.1) {
            const end = Math.min(n, ((0.1 * sr) | 0) - p.t);
            if (end > 0) {
                const te = (p.t + end) / sr;
                const m0 = this._ea(800, 10, t0, 0.1);
                const m1 = this._ea(800, 10, te, 0.1);
                const g0 = this._ea(0.4, 0.001, t0, 0.1);
                const g1 = this._ea(0.4, 0.001, te, 0.1);
                const mm = this._em(m0, m1, end);
                const gm = this._em(g0, g1, end);
                let modAmt = m0, gn = g0;
                let cp = p.cp, mp = p.mp;
                for (let i = 0; i < end; i++) {
                    const mod = Math.sin(TWO_PI * mp) * modAmt;
                    const cFreq = 1800 + mod;
                    out[i] += this._filt(p.cf, Math.sin(TWO_PI * cp)) * gn;
                    cp += cFreq / sr;
                    mp += 2400 / sr;
                    modAmt *= mm;
                    gn *= gm;
                }
                p.cp = cp - ((cp | 0) > 0 ? (cp | 0) : 0);
                p.mp = mp - ((mp | 0) > 0 ? (mp | 0) : 0);
            }
        }

        p.t += n;
        if (p.t / sr >= 0.15) p.on = false;
    }

    _renderCymbal(out, n) {
        const cy = this.cymbal, sr = sampleRate;
        const t0 = cy.t / sr;

        // --- Metal: 10 square oscs → HP(4000) → gain 0.12→0.001 / 1.0s ---
        if (t0 < 1.0) {
            const end = Math.min(n, ((1.0 * sr) | 0) - cy.t);
            if (end > 0) {
                const te = (cy.t + end) / sr;
                const g0 = this._ea(0.12, 0.001, t0, 1.0);
                const g1 = this._ea(0.12, 0.001, te, 1.0);
                const gm = this._em(g0, g1, end);
                let gn = g0;
                const ph = cy.ph, fr = cy.fr;
                for (let i = 0; i < end; i++) {
                    let mix = 0;
                    for (let j = 0; j < 10; j++) {
                        mix += ((ph[j] - ((ph[j] | 0) + (ph[j] < 0 ? -1 : 0))) < 0.5 ? 1 : -1);
                        ph[j] += fr[j] / sr;
                    }
                    out[i] += this._filt(cy.mf, mix) * gn;
                    gn *= gm;
                }
            }
        }

        // --- Noise: HP(9000) → gain 0.2→0.001 / 800ms, buffer 800ms ---
        if (t0 < 0.8) {
            const end = Math.min(n, ((0.8 * sr) | 0) - cy.t);
            if (end > 0) {
                const te = (cy.t + end) / sr;
                const g0 = this._ea(0.2, 0.001, t0, 0.8);
                const g1 = this._ea(0.2, 0.001, te, 0.8);
                const gm = this._em(g0, g1, end);
                let gn = g0;
                const nb = this.nBuf, nl = this.nLen;
                let ni = cy.ni;
                for (let i = 0; i < end; i++) {
                    out[i] += this._filt(cy.nf, nb[ni % nl]) * gn;
                    ni++;
                    gn *= gm;
                }
                cy.ni = ni;
            }
        }

        cy.t += n;
        if (cy.t / sr >= 1.1) cy.on = false;
    }

    _renderRim(out, n) {
        const r = this.rim, sr = sampleRate;
        const t0 = r.t / sr;

        // --- Click: square 1800→800 / 5ms, HP(1500), gain 0.5→0.001 / 25ms ---
        if (t0 < 0.025) {
            const end = Math.min(n, ((0.025 * sr) | 0) - r.t);
            if (end > 0) {
                const te = (r.t + end) / sr;
                const f0 = this._ea(1800, 800, t0, 0.005);
                const f1 = this._ea(1800, 800, te, 0.005);
                const g0 = this._ea(0.5, 0.001, t0, 0.025);
                const g1 = this._ea(0.5, 0.001, te, 0.025);
                const fm = this._em(f0, f1, end);
                const gm = this._em(g0, g1, end);
                let fr = f0, gn = g0, ph = r.cp;
                for (let i = 0; i < end; i++) {
                    const sq = ((ph - ((ph | 0) + (ph < 0 ? -1 : 0))) < 0.5) ? 1 : -1;
                    out[i] += this._filt(r.chp, sq) * gn;
                    ph += fr / sr;
                    fr *= fm;
                    gn *= gm;
                }
                r.cp = ph;
            }
        }

        // --- Body: triangle 400→200 / 10ms, BP(350, Q8), gain 0.4→0.001 / 50ms ---
        if (t0 < 0.05) {
            const end = Math.min(n, ((0.05 * sr) | 0) - r.t);
            if (end > 0) {
                const te = (r.t + end) / sr;
                const f0 = this._ea(400, 200, t0, 0.01);
                const f1 = this._ea(400, 200, te, 0.01);
                const g0 = this._ea(0.4, 0.001, t0, 0.05);
                const g1 = this._ea(0.4, 0.001, te, 0.05);
                const fm = this._em(f0, f1, end);
                const gm = this._em(g0, g1, end);
                let fr = f0, gn = g0, ph = r.bp;
                for (let i = 0; i < end; i++) {
                    const p = ph - (ph | 0);
                    out[i] += this._filt(r.bbp, 1 - 4 * Math.abs(p - 0.5)) * gn;
                    ph += fr / sr;
                    fr *= fm;
                    gn *= gm;
                }
                r.bp = ph;
            }
        }

        r.t += n;
        if (r.t / sr >= 0.1) r.on = false;
    }

    // ========= Main process =========

    process(inputs, outputs) {
        const out = outputs[0][0];
        if (!out) return true;
        const n = out.length;

        for (let i = 0; i < n; i++) out[i] = 0;

        if (this.kick.on) this._renderKick(out, n);
        if (this.snare.on) this._renderSnare(out, n);
        if (this.hihat.on) this._renderHihat(out, n);
        if (this.clap.on) this._renderClap(out, n);
        if (this.tom.on) this._renderTom(out, n);
        if (this.perc.on) this._renderPerc(out, n);
        if (this.cymbal.on) this._renderCymbal(out, n);
        if (this.rim.on) this._renderRim(out, n);

        // Copy mono to remaining channels
        for (let c = 1; c < outputs[0].length; c++) {
            outputs[0][c].set(out);
        }

        return true;
    }
}

registerProcessor('drum-engine-processor', DrumEngineProcessor);
