// A plucked string: a noise burst circulating in a delay line, averaged a little on every pass.
// It starts on its exact sample (startAt) and stops on the one it's told (stopAt), both on the audio clock
class KarplusStrongProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [{
            name: 'damping',
            defaultValue: 0.996,
            minValue: 0.990,
            maxValue: 0.999,
            automationRate: 'k-rate'
        }];
    }

    constructor(options) {
        super();
        const o = options.processorOptions || {};
        // Averaging a sample with the next one written shortens the loop by half a sample, and an integer line
        // can't hit the period: the high notes ran sharp (C6 by about 14 cents). A first-order allpass makes up the fraction
        const period = sampleRate / o.frequency;
        const size = Math.max(2, Math.floor(period + 0.4));
        const fraction = period + 0.5 - size;
        this.c = (1 - fraction) / (1 + fraction);
        this.apIn = 0;
        this.apOut = 0;
        this.bufferSize = size;
        this.buffer = new Float32Array(size);
        this.readIndex = 0;
        this.startFrame = typeof o.startAt === 'number' ? Math.round(o.startAt * sampleRate) : 0;
        this.stopFrame = Infinity;

        for (let i = 0; i < size; i++) {
            this.buffer[i] = (Math.random() * 2 - 1) * 0.8;
        }

        this.port.onmessage = (event) => {
            if (typeof event.data.stopAt === 'number') this.stopFrame = Math.round(event.data.stopAt * sampleRate);
        };
    }

    process(inputs, outputs, parameters) {
        if (currentFrame >= this.stopFrame) return false;

        const output = outputs[0][0];
        const n = output.length;
        const from = this.startFrame - currentFrame;
        if (from >= n) return true;

        const damping = parameters.damping[0];
        const buf = this.buffer;
        const size = this.bufferSize;
        const c = this.c;
        let apIn = this.apIn;
        let apOut = this.apOut;
        let idx = this.readIndex;

        for (let i = from > 0 ? from : 0; i < n; i++) {
            const now = buf[idx];
            output[i] = now;
            const nextIdx = idx + 1 === size ? 0 : idx + 1;
            const avg = 0.5 * (now + buf[nextIdx]) * damping;
            const ap = c * avg + apIn - c * apOut;
            apIn = avg;
            apOut = ap;
            buf[idx] = ap;
            idx = nextIdx;
        }

        this.apIn = apIn;
        this.apOut = apOut;
        this.readIndex = idx;
        return true;
    }
}

registerProcessor('karplus-strong-processor', KarplusStrongProcessor);
