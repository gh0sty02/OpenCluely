const test = require('node:test');
const assert = require('node:assert/strict');
const AudioCapture = require('../src/audio/capture');
const { PcmResampler } = require('../src/audio/pcm-worklet');

function harness(t, getDisplayMedia) {
  const tracks = ['audio', 'video'].map(kind => ({ kind, stopped: false, readyState: 'live',
    stop() { this.stopped = true; }, addEventListener(name, callback) { this[name] = callback; } }));
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks.filter(x => x.kind === 'audio') };
  const nodes = [];
  class Context {
    constructor() { this.audioWorklet = { addModule: async () => {} }; this.destination = {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { this.closed = true; }
  }
  class Node {
    constructor() { this.port = {}; nodes.push(this); }
    connect() {}
    disconnect() {}
  }
  const globals = { navigator: { mediaDevices: {
    getDisplayMedia: getDisplayMedia || (async () => stream),
    getUserMedia: async () => { throw new Error('Must not fall back to microphone'); }
  } }, AudioContext: Context, AudioWorkletNode: Node };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  return { tracks, stream, nodes };
}

test('system capture emits identified PCM frames and stops every track', async t => {
  const { tracks, nodes } = harness(t);
  const frames = [];
  const capture = new AudioCapture({ onFrame: frame => frames.push(frame) });
  await capture.start({ sessionId: 'session-1', source: 'system' });
  nodes[0].port.onmessage({ data: { pcm: new ArrayBuffer(640), level: 0.2 } });
  assert.deepEqual({ ...frames[0], pcm: undefined }, {
    sessionId: 'session-1', source: 'system', sequence: 0, sampleRate: 16000, channels: 1, pcm: undefined
  });
  const staleCallback = nodes[0].port.onmessage;
  await capture.stop();
  staleCallback({ data: { pcm: new ArrayBuffer(640), level: 0.2 } });
  assert.equal(frames.length, 1);
  assert.ok(tracks.every(track => track.stopped));
});

test('stop during permission request releases late stream without restarting', async t => {
  let resolve;
  const { tracks, stream, nodes } = harness(t, () => new Promise(done => { resolve = done; }));
  const capture = new AudioCapture();
  const starting = capture.start({ sessionId: 'old', source: 'system' });
  await capture.stop();
  resolve(stream);
  await starting;
  assert.ok(tracks.every(track => track.stopped));
  assert.equal(nodes.length, 0);
});

test('system stream without audio fails explicitly and releases video', async t => {
  const { stream, tracks } = harness(t);
  stream.getAudioTracks = () => [];
  const capture = new AudioCapture();
  await assert.rejects(capture.start({ sessionId: 's', source: 'system' }), /audio/i);
  assert.ok(tracks.every(track => track.stopped));
});

test('ended audio track reports capture failure and releases resources', async t => {
  const { tracks } = harness(t);
  const states = [];
  const capture = new AudioCapture({ onState: state => states.push(state) });
  await capture.start({ sessionId: 's', source: 'system' });
  await tracks[0].ended();
  assert.equal(states.at(-1).state, 'error');
  assert.ok(tracks.every(track => track.stopped));
});

test('resampling preserves timing across chunks at 44.1 and 48 kHz', () => {
  for (const rate of [44100, 48000]) {
    const resampler = new PcmResampler(rate);
    const chunks = [];
    for (let offset = 0; offset < rate; offset += 128) {
      chunks.push(...resampler.process([new Float32Array(Math.min(128, rate - offset)).fill(0.5)]));
    }
    assert.equal(chunks.length, 16000);
    assert.ok(chunks.every(sample => Math.abs(sample - 16384) <= 1));
  }
});

test('resampling mixes stereo and clips signed PCM safely', () => {
  const resampler = new PcmResampler(16000);
  assert.deepEqual([...resampler.process([Float32Array.from([2, -2, 1]), Float32Array.from([2, -2, -1])])], [32767, -32768, 0]);
});
