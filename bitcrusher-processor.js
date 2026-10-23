// crush 0–8: fewer bits (16 → 4) and a lower sample rate (down to ~1/15) together, which is what makes it sound lo-fi
class BitcrusherProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.crushAmount = 0;
        this.step = 0;
        this.hold = 1;
        this.phase = 0;
        this.held = new Float32Array(2);

        this.port.onmessage = (event) => {
            if (event.data.crushAmount === undefined) return;
            const a = Math.max(0, Math.min(8, event.data.crushAmount));
            this.crushAmount = a;
            this.step = Math.pow(0.5, 16 - 1.5 * a);
            this.hold = 1 + 0.6 * Math.pow(a, 1.5);
        };
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0]) return true;

        if (this.crushAmount === 0) {
            for (let channel = 0; channel < output.length; channel++) {
                output[channel].set(input[channel] || input[0]);
            }
            return true;
        }

        const step = this.step;
        const rate = 1 / this.hold;
        const held = this.held;
        const n = output[0].length;
        let phase = this.phase;

        for (let i = 0; i < n; i++) {
            phase += rate;
            const take = phase >= 1;
            if (take) phase -= 1;
            for (let channel = 0; channel < output.length && channel < 2; channel++) {
                const inputChannel = input[channel] || input[0];
                if (take) held[channel] = Math.round(inputChannel[i] / step) * step;
                output[channel][i] = held[channel];
            }
        }

        this.phase = phase;
        return true;
    }
}

registerProcessor('bitcrusher-processor', BitcrusherProcessor);
