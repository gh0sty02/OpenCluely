const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function service(overrides = {}) {
  const filename = path.join(__dirname, '../src/services/speech.service.js');
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const context = { window: {}, Buffer, console, process: { ...process, env: {} }, setTimeout, clearTimeout,
    setInterval, clearInterval, setImmediate, module: { exports: {} }, require(name) {
      if (name === '../core/logger') return { createServiceLogger: () => logger };
      if (name === '../core/config') return { get: () => undefined };
      if (name === './mistral.service') return { getApiKey: () => '' };
      if (name === './whisper-worker.service') return class { isConfigured() { return false; } releaseWhenIdle() {} close() {} };
      if (name === 'microsoft-cognitiveservices-speech-sdk') return overrides.sdk || {};
      if (name === 'node-record-lpcm16') return {};
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

test('stop waits for in-flight and queued utterances when no final audio remains', async () => {
  const speech = service();
  const settlements = [];
  let finishFirst;
  speech.on('transcription-settled', event => settlements.push(event));
  speech._transcribeWhisperBuffer = data => data[0] === 1
    ? new Promise(resolve => { finishFirst = resolve; })
    : Promise.resolve('question-2');
  speech.startRecording();
  buffer(speech, 1);
  const first = speech._flushWhisperSegment(1000);
  await Promise.resolve();
  buffer(speech, 2);
  const second = speech._flushWhisperSegment(2000);

  let stopped = false;
  const stopping = Promise.resolve(speech.stopRecording()).then(() => { stopped = true; });
  await Promise.resolve();
  const stoppedBeforeDrain = stopped;
  finishFirst('question-1');
  await first;
  await stopping;
  const queuedState = await Promise.race([
    second.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('pending'), 0))
  ]);
  assert.equal(stoppedBeforeDrain, false);
  assert.equal(queuedState, 'settled');
  assert.equal(settlements.length, 2);
  assert.deepEqual(settlements.map(event => event.text), ['question-1', 'question-2']);
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

test('voiced frames emit one speech start when VAD enters an utterance', async () => {
  const speech = service();
  const starts = [];
  const activities = [];
  speech.on('speech-started', event => starts.push(event));
  speech.on('speech-activity', event => activities.push(event));
  speech.startRecording();
  const frame = Buffer.alloc(3200);
  for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(12000, offset);
  speech._ingestWhisperAudio(frame);
  speech._ingestWhisperAudio(frame);
  assert.equal(starts.length, 1);
  assert.equal(activities.length, 1);
  assert.equal(starts[0].captureId, speech.captureId);
  assert.ok(Number.isFinite(starts[0].at));
  assert.ok(starts[0].utteranceId);
  await speech.stopRecording({ cancel: true });
});

test('Whisper emits one ordered lifecycle around every successful transcription', async () => {
  const speech = service();
  const events = [];
  for (const name of ['speech-ended', 'transcription-started', 'transcription', 'transcription-settled']) {
    speech.on(name, (textOrEvent, metadata) => events.push({ name, textOrEvent, metadata }));
  }
  speech._transcribeWhisperBuffer = async () => 'What is a closure?';
  speech.startRecording();
  buffer(speech, 1);
  const speechEndedAt = 1234;
  await speech._flushWhisperSegment(speechEndedAt);

  assert.deepEqual(events.map(event => event.name), [
    'speech-ended', 'transcription-started', 'transcription', 'transcription-settled'
  ]);
  const ended = events[0].textOrEvent;
  const started = events[1].textOrEvent;
  const transcriptMetadata = events[2].metadata;
  const settled = events[3].textOrEvent;
  assert.equal(new Set([ended.utteranceId, started.utteranceId, transcriptMetadata.utteranceId, settled.utteranceId]).size, 1);
  assert.equal(new Set([ended.captureId, started.captureId, transcriptMetadata.captureId, settled.captureId]).size, 1);
  assert.equal(new Set([ended.speechEndedAt, started.speechEndedAt, transcriptMetadata.speechEndedAt, settled.speechEndedAt]).size, 1);
  assert.equal(settled.text, 'What is a closure?');
  assert.equal(settled.errorCode, null);
  await speech.stopRecording({ cancel: true });
});

test('a failed Whisper transcription settles once without emitting transcript text', async () => {
  const speech = service();
  const transcripts = [];
  const settlements = [];
  speech.on('transcription', text => transcripts.push(text));
  speech.on('transcription-settled', event => settlements.push(event));
  speech._transcribeWhisperBuffer = async () => { throw new Error('decoder failed'); };
  speech.startRecording();
  buffer(speech, 1);
  await assert.rejects(speech._flushWhisperSegment(1234), /decoder failed/);
  assert.deepEqual(transcripts, []);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].text, '');
  assert.ok(settlements[0].errorCode);
  await speech.stopRecording({ cancel: true });
});

test('cancelled in-flight work settles once and never leaks into a restarted capture', async () => {
  const speech = service();
  const transcripts = [];
  const settlements = [];
  let finishOld;
  speech.on('transcription', text => transcripts.push(text));
  speech.on('transcription-settled', event => settlements.push(event));
  speech._transcribeWhisperBuffer = () => new Promise(resolve => { finishOld = resolve; });
  speech.startRecording();
  const oldCaptureId = speech.captureId;
  buffer(speech, 1);
  const oldWork = speech._flushWhisperSegment(1234);
  await Promise.resolve();
  await speech.stopRecording({ cancel: true });
  speech.startRecording();
  finishOld('old question');
  await oldWork;
  assert.deepEqual(transcripts, []);
  assert.equal(settlements.filter(event => event.captureId === oldCaptureId).length, 1);
  assert.equal(settlements[0].errorCode, 'CANCELLED');
  await speech.stopRecording({ cancel: true });
});

test('Azure final recognition emits one ordered lifecycle with stable identity', async () => {
  let recognizer;
  const sdk = {
    ResultReason: { RecognizingSpeech: 1, RecognizedSpeech: 2 },
    AudioInputStream: { createPushStream: () => ({ close() {} }) },
    AudioConfig: { fromStreamInput: () => ({ close() {} }) },
    SpeechRecognizer: class {
      constructor() { recognizer = this; }
      startContinuousRecognitionAsync(resolve) { resolve(); }
      stopContinuousRecognitionAsync(resolve) { resolve(); }
      close() {}
    }
  };
  const speech = service({ sdk });
  speech.provider = 'azure';
  speech.speechConfig = {};
  speech.available = true;
  const events = [];
  for (const name of ['speech-started', 'speech-ended', 'transcription-started', 'transcription', 'transcription-settled']) {
    speech.on(name, (textOrEvent, metadata) => events.push({ name, textOrEvent, metadata }));
  }

  speech.startRecording();
  recognizer.recognizing(null, { result: { reason: sdk.ResultReason.RecognizingSpeech, text: 'What' } });
  recognizer.recognizing(null, { result: { reason: sdk.ResultReason.RecognizingSpeech, text: 'What is' } });
  recognizer.recognized(null, { result: { reason: sdk.ResultReason.RecognizedSpeech, text: 'What is Azure?' } });

  assert.deepEqual(events.map(event => event.name), [
    'speech-started', 'speech-ended', 'transcription-started', 'transcription', 'transcription-settled'
  ]);
  const identities = [events[0].textOrEvent, events[1].textOrEvent, events[2].textOrEvent,
    events[3].metadata, events[4].textOrEvent].map(event => event.utteranceId);
  assert.equal(new Set(identities).size, 1);
  assert.equal(events[4].textOrEvent.text, 'What is Azure?');
  assert.equal(events[4].textOrEvent.errorCode, null);
  await speech.stopRecording({ cancel: true });
});
