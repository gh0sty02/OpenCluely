(function(root) {
  class AudioCapture {
    constructor({ onFrame = () => {}, onLevel = () => {}, onState = () => {} } = {}) {
      this.onFrame = onFrame;
      this.onLevel = onLevel;
      this.onState = onState;
      this.active = null;
    }

    async start({ sessionId, source = 'system', deviceId } = {}) {
      if (!sessionId) throw new Error('An audio session ID is required');
      if (!['system', 'microphone'].includes(source)) throw new Error('Unsupported audio source');
      const previous = this.active;
      const capture = { sessionId, source, sequence: 0 };
      this.active = capture;
      if (previous) await this._release(previous);
      if (this.active !== capture) return;
      this._state(capture, 'starting');
      try {
        const devices = root.navigator.mediaDevices;
        capture.stream = source === 'system'
          ? await devices.getDisplayMedia({ video: true, audio: true })
          : await devices.getUserMedia({ audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            channelCount: 1, echoCancellation: true, noiseSuppression: true
          }, video: false });
        if (this.active !== capture) { await this._release(capture); return; }
        const audioTracks = capture.stream.getAudioTracks();
        if (!audioTracks.length) throw new Error('The selected source did not provide audio. Choose a source with audio enabled.');
        for (const track of audioTracks) {
          track.addEventListener('ended', async () => {
            if (this.active !== capture) return;
            this.active = null;
            await this._release(capture);
            if (!this.active) this._state(capture, 'error', 'The audio source disconnected. Select it again to resume.');
          }, { once: true });
        }
        capture.context = new root.AudioContext();
        const workletUrl = root.document
          ? new URL('src/audio/pcm-worklet.js', root.document.baseURI).href
          : 'src/audio/pcm-worklet.js';
        await capture.context.audioWorklet.addModule(workletUrl);
        if (this.active !== capture) { await this._release(capture); return; }
        if (audioTracks.some(track => track.readyState === 'ended')) throw new Error('The audio source disconnected while starting');
        capture.input = capture.context.createMediaStreamSource(capture.stream);
        capture.node = new root.AudioWorkletNode(capture.context, 'pcm-capture');
        capture.node.port.onmessage = ({ data }) => {
          if (this.active !== capture || !data.pcm) return;
          this.onLevel(data.level);
          this.onFrame({ sessionId, source, sequence: capture.sequence++, sampleRate: 16000, channels: 1, pcm: data.pcm });
        };
        capture.input.connect(capture.node);
        capture.node.connect(capture.context.destination);
        await capture.context.resume();
        if (this.active !== capture) { await this._release(capture); return; }
        this._state(capture, 'listening');
      } catch (error) {
        const current = this.active === capture;
        if (current) this.active = null;
        await this._release(capture);
        if (current) {
          this._state(capture, 'error', error.message);
          throw error;
        }
      }
    }

    async stop() {
      const capture = this.active;
      if (!capture) return;
      this.active = null;
      await this._release(capture);
      if (!this.active) {
        this.onLevel(0);
        this._state(capture, 'paused');
      }
    }

    _state(capture, state, error) {
      this.onState({ state, sessionId: capture.sessionId, source: capture.source, ...(error ? { error } : {}) });
    }

    async _release(capture) {
      if (capture.node) { capture.node.port.onmessage = null; capture.node.disconnect(); capture.node = null; }
      if (capture.input) { capture.input.disconnect(); capture.input = null; }
      if (capture.stream) { capture.stream.getTracks().forEach(track => track.stop()); capture.stream = null; }
      if (capture.context) {
        const context = capture.context;
        capture.context = null;
        if (context.state !== 'closed') await context.close().catch(() => {});
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = AudioCapture;
  else root.AudioCapture = AudioCapture;
})(globalThis);
