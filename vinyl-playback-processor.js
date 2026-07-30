class VinylPlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buf = null;
        this.nch = 0;
        this.len = 0;
        this.pos = 0;
        this.rate = 0;
        this.target = 0;
        this.state = 0; // 0=stopped, 1=playing, 2=braking, 3=scratching
        this.tau = 0.30;
        this.scratchTarget = 0;

        this.port.onmessage = (e) => {
            const m = e.data;
            switch (m.cmd) {
                case 'load':
                    this.buf = m.buffer;
                    this.nch = m.channels;
                    this.len = m.length;
                    this.pos = 0;
                    this.rate = 0;
                    this.state = 0;
                    break;
                case 'play':
                    this.pos = m.offset * sampleRate;
                    this.target = m.rate;
                    this.tau = 0.30;
                    this.state = 1;
                    break;
                case 'pause':
                    this.target = 0;
                    this.tau = m.brake || 0.16;
                    this.state = 2;
                    break;
                case 'stop':
                    this.state = 0;
                    this.rate = 0;
                    break;
                case 'scratch':
                    this.scratchTarget = m.position * sampleRate;
                    this.state = 3;
                    break;
                case 'release':
                    if (m.resume) {
                        this.target = m.rate;
                        this.tau = 0.30;
                        this.state = 1;
                    } else {
                        this.state = 0;
                        this.rate = 0;
                    }
                    break;
                case 'rate':
                    this.target = m.value;
                    if (this.state === 1) this.tau = 0.015;
                    break;
                case 'seek':
                    this.pos = m.position * sampleRate;
                    break;
            }
        };
    }

    cubic(ch, p) {
        const i = p | 0;
        const f = p - i;
        const len = this.len;
        const y0 = ch[Math.max(0, i - 1)];
        const y1 = ch[Math.min(len - 1, i)];
        const y2 = ch[Math.min(len - 1, i + 1)];
        const y3 = ch[Math.min(len - 1, i + 2)];
        const c1 = 0.5 * (y2 - y0);
        const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        return ((c3 * f + c2) * f + c1) * f + y1;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        const n = out[0].length;

        if (!this.buf || this.state === 0) {
            for (let c = 0; c < out.length; c++)
                for (let i = 0; i < n; i++) out[c][i] = 0;
            return true;
        }

        const sr = sampleRate;
        const len = this.len;
        const alpha = 1 - Math.exp(-1 / (sr * Math.max(0.001, this.tau)));

        for (let i = 0; i < n; i++) {
            if (this.state === 3) {
                const diff = this.scratchTarget - this.pos;
                this.pos += diff * 0.015;
            } else {
                this.rate += (this.target - this.rate) * alpha;
                this.pos += this.rate;
                if (this.state === 2 && Math.abs(this.rate) < 0.001) {
                    this.state = 0;
                    this.rate = 0;
                }
            }

            if (this.pos < 0) this.pos = 0;
            if (this.pos >= len - 1) {
                this.pos = 0;
                this.state = 0;
                this.rate = 0;
                this.port.postMessage({ event: 'ended' });
                for (let c = 0; c < out.length; c++)
                    for (let j = i; j < n; j++) out[c][j] = 0;
                return true;
            }

            for (let c = 0; c < out.length; c++) {
                const ch = c < this.nch ? this.buf[c] : this.buf[0];
                out[c][i] = this.cubic(ch, this.pos);
            }
        }

        return true;
    }
}

registerProcessor('vinyl-playback-processor', VinylPlaybackProcessor);
