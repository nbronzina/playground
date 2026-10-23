// mk-1 looper: records what goes into the limiter, uncompressed, from an exact start frame to an exact stop frame.
// Chunks go to the main thread and come back to be filled again, so process() allocates nothing
const CHUNK = 8192;
const POOL = 32;

class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.free = [];
        for (let i = 0; i < POOL; i++) {
            this.free.push({ type: 'chunk', take: 0, frames: 0, L: new Float32Array(CHUNK), R: new Float32Array(CHUNK) });
        }
        this.end = { type: 'end', take: 0, lost: 0 };
        this.cur = null;
        this.pos = 0;
        this.take = 0;
        this.startFrame = 0;
        this.stopFrame = Infinity;
        this.recording = false;
        this.lost = 0;

        this.port.onmessage = (e) => {
            const d = e.data;
            if (d.type === 'start') {
                if (this.recording) this.finish();
                this.take = d.take;
                this.startFrame = d.frame;
                this.stopFrame = Infinity;
                this.lost = 0;
                this.recording = true;
            } else if (d.type === 'stop') {
                if (d.take === this.take) this.stopFrame = Math.max(this.startFrame, d.frame);
            } else if (d.type === 'return') {
                this.free.push(d.chunk);
            }
        };
    }

    flush() {
        const c = this.cur;
        if (!c) return;
        c.take = this.take;
        c.frames = this.pos;
        this.port.postMessage(c, [c.L.buffer, c.R.buffer]);
        this.cur = null;
        this.pos = 0;
    }

    finish() {
        this.flush();
        this.end.take = this.take;
        this.end.lost = this.lost;
        this.port.postMessage(this.end);
        this.recording = false;
    }

    process(inputs) {
        if (!this.recording) return true;
        const input = inputs[0];
        const L = input && input[0];
        const R = input && (input[1] || input[0]);
        const n = L ? L.length : 128;
        const from = Math.max(0, this.startFrame - currentFrame);
        const to = Math.min(n, this.stopFrame - currentFrame);

        for (let i = from; i < to; i++) {
            if (!this.cur) {
                this.cur = this.free.length ? this.free.pop() : null;
                // the main thread hasn't given chunks back for seconds: count what can't be kept rather than allocate
                if (!this.cur) {
                    this.lost++;
                    continue;
                }
            }
            this.cur.L[this.pos] = L ? L[i] : 0;
            this.cur.R[this.pos] = R ? R[i] : 0;
            if (++this.pos === CHUNK) this.flush();
        }

        if (currentFrame + n >= this.stopFrame) this.finish();
        return true;
    }
}

registerProcessor('recorder-processor', RecorderProcessor);
