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
        const frequency = options.processorOptions.frequency;
        this.bufferSize = Math.round(sampleRate / frequency);
        this.buffer = new Float32Array(this.bufferSize);
        this.readIndex = 0;
        this.brightness = 0.5;
        this.alive = true;

        for (let i = 0; i < this.bufferSize; i++) {
            this.buffer[i] = (Math.random() * 2 - 1) * 0.8;
        }

        this.port.onmessage = (event) => {
            if (event.data.stop) this.alive = false;
        };
    }

    process(inputs, outputs, parameters) {
        if (!this.alive) return false;

        const output = outputs[0][0];
        const damping = parameters.damping[0];
        const buf = this.buffer;
        const size = this.bufferSize;
        const brightness = this.brightness;
        let idx = this.readIndex;

        for (let i = 0; i < output.length; i++) {
            output[i] = buf[idx];
            const nextIdx = (idx + 1) % size;
            buf[idx] = (brightness * buf[idx] + (1 - brightness) * buf[nextIdx]) * damping;
            idx = nextIdx;
        }

        this.readIndex = idx;
        return true;
    }
}

registerProcessor('karplus-strong-processor', KarplusStrongProcessor);
