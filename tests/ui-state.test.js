'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { viewState } = require('../src/ui/interview-state');

test('turnLabel maps each turn state to its own status text, independent of captureState', () => {
  assert.equal(viewState({ turnState: 'transcribing' }).turnLabel, 'Transcribing question');
  assert.equal(viewState({ turnState: 'waiting' }).turnLabel, 'Waiting for the rest of the question');
  assert.equal(viewState({ turnState: 'speaking' }).turnLabel, 'Listening to the interviewer');
  assert.equal(viewState({ turnState: 'ready' }).turnLabel, 'Question captured');
  assert.equal(viewState({ turnState: 'idle' }).turnLabel, 'Ready for a question');
  // Same turnState, different captureState: turnLabel does not change.
  assert.equal(viewState({ turnState: 'transcribing', captureState: 'paused' }).turnLabel, 'Transcribing question');
  assert.equal(viewState({ turnState: 'transcribing', captureState: 'listening' }).turnLabel, 'Transcribing question');
});

test('turnLabel falls back to the idle label for an unknown or missing turnState', () => {
  assert.equal(viewState({}).turnLabel, 'Ready for a question');
  assert.equal(viewState({ turnState: 'not-a-real-state' }).turnLabel, 'Ready for a question');
});

test('answerLabel distinguishes preparing (no visible token yet) from writing (streaming)', () => {
  assert.equal(viewState({ questions: [{ state: 'generating' }] }).answerLabel, 'Preparing answer');
  assert.equal(viewState({ questions: [{ state: 'generating', answer: '' }] }).answerLabel, 'Preparing answer');
  assert.equal(viewState({ questions: [{ state: 'generating', answer: 'Sure, here' }] }).answerLabel, 'Writing answer');
});

test('answerLabel covers the rest of the question lifecycle', () => {
  assert.equal(viewState({ questions: [{ state: 'queued' }] }).answerLabel, 'Question queued');
  assert.equal(viewState({ questions: [{ state: 'completed', answer: 'Done' }] }).answerLabel, 'Answer ready');
  assert.equal(viewState({ questions: [{ state: 'cancelled' }] }).answerLabel, 'Answer stopped');
  assert.equal(viewState({ questions: [{ state: 'error' }] }).answerLabel, 'Answer needs attention');
  assert.equal(viewState({ questions: [{ state: 'overflow' }] }).answerLabel, 'Queue full - submit when ready');
  assert.equal(viewState({ questions: [] }).answerLabel, 'Ready for a question');
  assert.equal(viewState({}).answerLabel, 'Ready for a question');
});

test('a filled-in draft keeps Answer now enabled through every waiting/transcribing turn state, without a countdown field', () => {
  for (const turnState of ['idle', 'speaking', 'transcribing', 'waiting', 'ready']) {
    const state = viewState({ draft: 'What is your experience with distributed systems?', turnState, turnDeadlineAt: Date.now() + 5000 });
    assert.equal(state.canAnswer, true, `canAnswer should stay true while turnState is ${turnState}`);
    // The plan explicitly forbids a distracting live countdown in the view model.
    assert.equal('turnCountdown' in state, false);
    assert.equal('turnDeadlineAt' in state, false);
  }
});

test('an empty draft leaves Answer now disabled regardless of turn state', () => {
  assert.equal(viewState({ draft: '', turnState: 'waiting' }).canAnswer, false);
  assert.equal(viewState({ draft: '   ', turnState: 'ready' }).canAnswer, false);
  assert.equal(viewState({ turnState: 'ready' }).canAnswer, false);
});

test('captureLabel and turnLabel remain independently derived (no cross-talk)', () => {
  const listening = viewState({ captureState: 'listening', turnState: 'waiting', source: 'microphone' });
  assert.equal(listening.captureLabel, 'Listening to microphone');
  assert.equal(listening.turnLabel, 'Waiting for the rest of the question');
  const paused = viewState({ captureState: 'paused', turnState: 'waiting' });
  assert.equal(paused.captureLabel, 'Capture paused');
  assert.equal(paused.turnLabel, 'Waiting for the rest of the question');
});
