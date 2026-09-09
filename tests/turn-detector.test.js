'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const TurnDetector = require('../src/interview/turn-detector');

function createClock(start = 0) {
  let now = start;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, delay) {
      const id = ++sequence;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      let due;
      do {
        due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at);
        due.forEach(([id, timer]) => {
          timers.delete(id);
          timer.fn();
        });
      } while (due.length);
    }
  };
}

function setup(start = 0) {
  const clock = createClock(start);
  const detector = new TurnDetector({
    silenceMs: 3000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  const readyEvents = [];
  detector.on('ready', event => readyEvents.push(event));
  detector.begin({ sessionId: 'session-1', captureId: 7 });
  return { clock, detector, readyEvents };
}

test('speech resuming before an earlier transcript settles cannot release the turn', () => {
  const { clock, detector, readyEvents } = setup(1000);
  detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  detector.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  clock.advance(2200);
  detector.noteSpeechStarted({ captureId: 7, utteranceId: 'u2', at: 3200 });
  detector.noteTranscriptionSettled({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000, text: 'first', errorCode: null });
  clock.advance(5000);
  assert.equal(readyEvents.length, 0);
  assert.equal(detector.snapshot().turnState, 'speaking');
});

test('a silence deadline waits for the final pending transcription', () => {
  const { clock, detector, readyEvents } = setup(5000);
  detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u2', speechEndedAt: 5000 });
  detector.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u2', speechEndedAt: 5000 });
  clock.advance(3000);
  assert.equal(readyEvents.length, 0);
  detector.noteTranscriptionSettled({ captureId: 7, utteranceId: 'u2', speechEndedAt: 5000, text: 'second', errorCode: null });
  assert.deepEqual(readyEvents, [{ sessionId: 'session-1', captureId: 7, speechEndedAt: 5000 }]);
});

test('the newest acoustic boundary owns the deadline after a natural pause', () => {
  const { clock, detector, readyEvents } = setup(1000);
  detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  detector.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  detector.noteTranscriptionSettled({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000, text: 'first', errorCode: null });
  clock.advance(2000);
  detector.noteSpeechStarted({ captureId: 7, utteranceId: 'u2', at: 3000 });
  clock.advance(1500);
  detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u2', speechEndedAt: 4500 });
  detector.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u2', speechEndedAt: 4500 });
  detector.noteTranscriptionSettled({ captureId: 7, utteranceId: 'u2', speechEndedAt: 4500, text: 'second', errorCode: null });
  clock.advance(2999);
  assert.equal(readyEvents.length, 0);
  assert.equal(detector.snapshot().turnDeadlineAt, 7500);
  clock.advance(1);
  assert.deepEqual(readyEvents, [{ sessionId: 'session-1', captureId: 7, speechEndedAt: 4500 }]);
});

test('stale, malformed, and duplicate lifecycle events leave current state unchanged', () => {
  const { detector } = setup(1000);
  detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  detector.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  const expected = detector.snapshot();

  detector.noteSpeechStarted({ captureId: 6, utteranceId: 'old', at: 1100 });
  detector.noteSpeechEnded({ captureId: 6, utteranceId: 'old', speechEndedAt: 1100 });
  detector.noteTranscriptionStarted({ captureId: 6, utteranceId: 'old', speechEndedAt: 1100 });
  detector.noteTranscriptionSettled({ captureId: 6, utteranceId: 'old', speechEndedAt: 1100, text: 'stale', errorCode: null });
  detector.noteSpeechStarted({ captureId: 7, utteranceId: 'bad' });
  detector.noteSpeechEnded({ captureId: 7, utteranceId: 'bad', speechEndedAt: NaN });
  detector.noteTranscriptionStarted({ captureId: 7, utteranceId: '', speechEndedAt: 1000 });
  detector.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  detector.noteTranscriptionSettled({ captureId: 7, utteranceId: 'unknown', speechEndedAt: 1000, text: '', errorCode: 'FAILED' });

  assert.deepEqual(detector.snapshot(), expected);
});

test('a failed transcription releases its identity and permits readiness', () => {
  const { clock, detector, readyEvents } = setup(1000);
  detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  detector.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  clock.advance(3000);
  detector.noteTranscriptionSettled({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000, text: '', errorCode: 'TRANSCRIPTION_FAILED' });
  assert.equal(detector.snapshot().pendingTranscriptions, 0);
  assert.equal(readyEvents.length, 1);
});

test('begin and cancel isolate captures from late timers and events', () => {
  const { clock, detector, readyEvents } = setup(1000);
  detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  detector.begin({ sessionId: 'session-2', captureId: 8 });
  detector.noteTranscriptionSettled({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000, text: 'late', errorCode: null });
  clock.advance(3000);
  assert.equal(readyEvents.length, 0);
  assert.deepEqual(detector.snapshot(), {
    sessionId: 'session-2', captureId: 8, turnState: 'idle', turnDeadlineAt: null,
    pendingTranscriptions: 0, speakerActive: false, speechEndedAt: null
  });
  detector.cancel();
  detector.noteSpeechStarted({ captureId: 8, utteranceId: 'u2', at: 4000 });
  assert.equal(detector.snapshot().turnState, 'idle');
});

test('forceReady bypasses only the silence wait and still emits once', () => {
  const { detector, readyEvents } = setup(1000);
  detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  detector.forceReady();
  detector.forceReady();
  assert.deepEqual(readyEvents, [{ sessionId: 'session-1', captureId: 7, speechEndedAt: 1000 }]);
});

test('the pending transcription backlog is bounded at 100 identities', () => {
  const { detector } = setup(1000);
  const warnings = [];
  detector.on('warning', warning => warnings.push(warning));
  for (let index = 0; index < 101; index++) {
    detector.noteTranscriptionStarted({ captureId: 7, utteranceId: `u${index}`, speechEndedAt: 1000 + index });
  }
  assert.equal(detector.snapshot().pendingTranscriptions, 100);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'TRANSCRIPTION_BACKLOG');
});

test('reaching the transcription backlog cap is safe without diagnostic listeners', () => {
  const { detector } = setup(1000);
  assert.doesNotThrow(() => {
    for (let index = 0; index < 101; index++) {
      detector.noteTranscriptionStarted({ captureId: 7, utteranceId: `u${index}`, speechEndedAt: 1000 + index });
    }
  });
  assert.equal(detector.snapshot().pendingTranscriptions, 100);
});
