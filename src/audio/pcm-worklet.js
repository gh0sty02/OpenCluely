// Carry sample weights across render blocks so 44.1 kHz input does not drift.
class PcmResampler {
  constructor(inputRate) {
    this.ratio = inputRate / 16000;
    this.remaining = this.ratio;
    this.sum = 0;
  }

  process(channels) {
    if (!channels.length || !channels[0].length) return new Int16Array(0);
    const output = [];
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample /= channels.length;
      let weight = 1;
      while (weight > 1e-9) {
        const used = Math.min(weight, this.remaining);
        this.sum += sample * used;
        this.remaining -= used;
        weight -= used;
        if (this.remaining < 1e-9) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          output.push(Math.round(value * (value < 0 ? 32768 : 32767)));
          this.sum = 0;
          this.remaining = this.ratio;
        }
      }
    }
    return Int16Array.from(output);
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class PcmCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.resampler = new PcmResampler(sampleRate);
      this.frame = new Int16Array(320);
      this.offset = 0;
      this.energy = 0;
    }

    process(inputs) {
      const samples = this.resampler.process(inputs[0] || []);
      for (const sample of samples) {
        this.frame[this.offset++] = sample;
        this.energy += (sample / 32768) ** 2;
        if (this.offset === this.frame.length) {
          const pcm = this.frame.buffer;
          this.port.postMessage({ pcm, level: Math.sqrt(this.energy / this.frame.length) }, [pcm]);
          this.frame = new Int16Array(320);
          this.offset = 0;
          this.energy = 0;
        }
      }
      // The unmodified output buffers stay silent; captured audio is never replayed.
      return true;
    }
  }
  registerProcessor('pcm-capture', PcmCaptureProcessor);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { PcmResampler };
