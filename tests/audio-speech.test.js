const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function service() {
  const filename = path.join(__dirname, '../src/services/speech.service.js');
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const context = { window: {}, Buffer, console, process: { ...process, env: {} }, setTimeout, clearTimeout,
    setInterval, clearInterval, setImmediate, module: { exports: {} }, require(name) {
      if (name === '../core/logger') return { createServiceLogger: () => logger };
      if (name === '../core/config') return { get: () => undefined };
      if (name === './mistral.service') return { getApiKey: () => '' };
      if (name === './whisper-worker.service') return class { isConfigured() { return false; } releaseWhenIdle() {} close() {} };
      if (name === 'microsoft-cognitiveservices-speech-sdk' || name === 'node-record-lpcm16') return {};
      return require(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const speech = context.module.exports;
  speech.provider = 'whisper';
  speech.available = true;
  speech._startSegmentWatchdog = () => {};
  speech.on('error', () => {});
  return speech;
}

function buffer(speech, value) {
  const data = Buffer.from([value, 0]);
  speech.segmentBuffers.push(data);
  speech.segmentBytes += data.length;
}

test('recording started advertises renderer capture before listeners run', () => {
  const speech = service();
  let started;
  speech.on('recording-started', metadata => {
    started = { metadata, renderer: speech.useRendererCapture };
  });
  speech.startRecording();
  assert.equal(started.renderer, true);
  assert.equal(started.metadata.useRendererCapture, true);
  assert.ok(started.metadata.captureId);
  assert.equal(speech._getWhisperCaptureMode(), 'vad');
  speech.stopRecording({ cancel: true });
});

test('pause drains in-flight and buffered utterances individually with identities', async () => {
  const speech = service();
  const finals = [];
  let finishFirst;
  speech.on('transcription', (text, metadata) => finals.push({ text, metadata }));
  speech._transcribeWhisperBuffer = data => data[0] === 1
    ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve(`question-${data[0]}`);
  speech.startRecording();
  buffer(speech, 1);
  const first = speech._flushWhisperSegment({ final: false });
  await Promise.resolve();
  buffer(speech, 2);
  speech._flushWhisperSegment({ final: false });
  buffer(speech, 3);
  let stopped = false;
  const stopping = Promise.resolve(speech.stopRecording()).then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finishFirst('question-1');
  await first;
  await stopping;
  assert.deepEqual(finals.map(item => item.text), ['question-1', 'question-2', 'question-3']);
  assert.equal(new Set(finals.map(item => item.metadata.utteranceId)).size, 3);
  assert.equal(new Set(finals.map(item => item.metadata.captureId)).size, 1);
  assert.equal(speech.isProcessingAudio, false);
});

test('cancel and immediate restart ignores old transcription and preserves new buffers', async () => {
  const speech = service();
  const finals = [];
  let finishOld;
  speech.on('transcription', text => finals.push(text));
  speech._transcribeWhisperBuffer = () => new Promise(resolve => { finishOld = resolve; });
  speech.startRecording();
  buffer(speech, 1);
  const old = speech._flushWhisperSegment({ final: false });
  await Promise.resolve();
  await speech.stopRecording({ cancel: true });
  speech.startRecording();
  buffer(speech, 2);
  finishOld('old question');
  await old;
  assert.deepEqual(finals, []);
  assert.equal(speech.isRecording, true);
  assert.equal(speech.segmentBytes, 2);
  await speech.stopRecording({ cancel: true });
});

test('renderer PCM is routed to Azure push stream without microphone capture', () => {
  const speech = service();
  speech.provider = 'azure';
  speech.isRecording = true;
  speech.useRendererCapture = true;
  let received;
  speech.pushStream = { write: data => { received = Buffer.from(data); } };
  speech.handleAudioChunkFromRenderer(new Uint8Array([1, 2]).buffer);
  assert.deepEqual(received, Buffer.from([1, 2]));
});
