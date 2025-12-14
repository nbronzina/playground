class BitcrusherProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.crushAmount = 0;

        this.port.onmessage = (event) => {
            if (event.data.crushAmount !== undefined) {
                this.crushAmount = event.data.crushAmount;
            }
        };
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0]) return true;

        for (let channel = 0; channel < output.length; channel++) {
            const inputChannel = input[channel] || input[0];
            const outputChannel = output[channel];

            if (this.crushAmount === 0) {
                // No crushing - pass through
                outputChannel.set(inputChannel);
            } else {
                // Reduce bit depth
                const step = Math.pow(0.5, 16 - this.crushAmount);
                for (let i = 0; i < inputChannel.length; i++) {
                    outputChannel[i] = Math.round(inputChannel[i] / step) * step;
                }
            }
        }

        return true;
    }
}

registerProcessor('bitcrusher-processor', BitcrusherProcessor);
