const { test } = require('node:test');
const assert = require('node:assert/strict');
const SessionController = require('../src/interview/session-controller');

function setup() {
  let tick = 0;
  const timers = new Map();
  const calls = [];
  const controller = new SessionController({
    generate: (question, options) => new Promise((resolve, reject) => calls.push({ question, options, resolve, reject })),
    setTimer: (fn) => { timers.set(++tick, fn); return tick; },
    clearTimer: (id) => timers.delete(id)
  });
  controller.startSession();
  const transcript = (text, utteranceId = String(++tick), source = 'system') => controller.acceptTranscript({
    sessionId: controller.sessionId, text, utteranceId, source, final: true
  });
  // autoAnswer defaults to false, so this fires no timer and just stands in
  // for the explicit "Stop listening" trigger most tests below use.
  const flush = () => controller.answerNow();
  // Only meaningful once autoAnswer is enabled — simulates its silence timer elapsing.
  const advanceTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  return { controller, calls, transcript, flush, advanceTimers };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('completion does not dispatch a second unfinished question', async () => {
  const { controller, calls, transcript, flush } = setup();
  transcript('How does an LLM work?'); flush();
  assert.equal(calls.length, 1);
  transcript('Explain how');
  calls[0].resolve({ response: 'A language model predicts tokens.' });
  await settle();
  assert.equal(calls.length, 1);
  transcript('an LLM is trained'); flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].question.text, 'Explain how an LLM is trained');
  assert.equal(controller.snapshot().questions.length, 2);
});

test('duplicate final identities are ignored but repeated questions are allowed', async () => {
  const { calls, transcript, flush } = setup();
  transcript('Why?', 'one'); transcript('Why?', 'one'); flush();
  assert.equal(calls[0].question.text, 'Why?');
  calls[0].resolve({ response: 'Because...' }); await settle();
  transcript('Why?', 'two'); flush();
  assert.equal(calls.length, 2);
});

test('clear aborts work and ignores late output and completion', async () => {
  const { controller, calls, transcript, flush } = setup();
  transcript('Explain attention'); flush();
  const oldSession = controller.sessionId;
  controller.clearSession();
  assert.equal(calls[0].options.signal.aborted, true);
  calls[0].options.onDelta('stale');
  calls[0].resolve({ response: 'stale' }); await settle();
  controller.acceptTranscript({ sessionId: oldSession, text: 'late', final: true, utteranceId: 'late' });
  assert.deepEqual(controller.snapshot().questions, []);
});

test('queue saturation preserves overflow for explicit submission', () => {
  const { controller, transcript, flush, calls } = setup();
  for (let i = 0; i < 5; i++) { transcript(`Question ${i}?`); flush(); }
  assert.equal(calls.length, 1);
  assert.equal(controller.snapshot().queueLength, 3);
  assert.equal(controller.snapshot().questions[4].state, 'overflow');
  assert.equal(controller.snapshot().questions[4].text, 'Question 4?');
});

test('a transcript never dispatches on its own — only an explicit action does', () => {
  const { controller, calls, transcript } = setup();
  transcript('Could you explain that?', 'mic-1', 'microphone');
  assert.equal(calls.length, 0);
  controller.answerNow();
  assert.equal(calls.length, 1);
});

test('system-audio speech accumulates in the draft and never auto-dispatches, even across a long pause', () => {
  const { controller, calls, transcript } = setup();
  transcript('Tell me about yourself');
  assert.equal(calls.length, 0);
  assert.equal(controller.snapshot().draft, 'Tell me about yourself');
  // No timer exists to advance — this stands in for "arbitrarily long silence".
  transcript('and your background');
  assert.equal(calls.length, 0);
  assert.equal(controller.snapshot().draft, 'Tell me about yourself and your background');
  // "Stop listening" is the only thing that starts generation.
  controller.pause();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].question.text, 'Tell me about yourself and your background');
});

test('auto-answer dispatches system audio after the configured silence gap, but microphone still waits', () => {
  const { controller, calls, transcript, advanceTimers } = setup();
  controller.setAutoAnswer(true, 5000);
  transcript('What is polymorphism?');
  assert.equal(calls.length, 0, 'draft accumulates, does not dispatch immediately');
  advanceTimers();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].question.text, 'What is polymorphism?');

  transcript('Could you clarify?', 'mic-1', 'microphone');
  advanceTimers();
  assert.equal(calls.length, 1, 'microphone drafts still require an explicit trigger even in auto mode');
});

test('auto-answer restarts its silence timer on every new fragment', () => {
  const { controller, calls, transcript, advanceTimers } = setup();
  controller.setAutoAnswer(true, 3000);
  transcript('Explain the');
  transcript('event loop');
  // Only the LAST scheduled timer should still be pending — earlier
  // fragments must not each independently fire their own dispatch.
  advanceTimers();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].question.text, 'Explain the event loop');
});

test('turning auto-answer off cancels a pending silence timer', () => {
  const { controller, calls, transcript, advanceTimers } = setup();
  controller.setAutoAnswer(true, 3000);
  transcript('Some question');
  controller.setAutoAnswer(false);
  advanceTimers();
  assert.equal(calls.length, 0);
});

test('auto-answer counts the gap from when speech actually ended, not from a slow transcription arriving late', () => {
  let scheduledDelay = null;
  const controller = new SessionController({
    generate: () => new Promise(() => {}),
    setTimer: (fn, delay) => { scheduledDelay = delay; return 1; },
    clearTimer: () => {}
  });
  controller.startSession();
  controller.setAutoAnswer(true, 5000);
  // Whisper took 4s to transcribe this fragment — the speaker actually fell
  // silent 4s ago, so only ~1s of the 5s pause budget should remain, not a
  // fresh 5s counted from this (late) arrival.
  controller.acceptTranscript({
    sessionId: controller.sessionId, text: 'What is recursion?', utteranceId: 'u1',
    source: 'system', final: true, speechEndedAt: Date.now() - 4000
  });
  assert.ok(scheduledDelay <= 1200 && scheduledDelay >= 800, `expected ~1000ms remaining, got ${scheduledDelay}`);
});

test('noteActivity holds off a pending auto-answer the instant speech resumes, ahead of that fragment ever transcribing', () => {
  const { controller, calls, transcript, advanceTimers } = setup();
  controller.setAutoAnswer(true, 3000);
  transcript('What is the time');
  controller.noteActivity();
  advanceTimers();
  assert.equal(calls.length, 0, 'activity signal cancelled the pending dispatch before it could fire');
  transcript('complexity of merge sort?');
  advanceTimers();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].question.text, 'What is the time complexity of merge sort?');
});

test('provider errors preserve partial answer and retry gets a new request identity', async () => {
  const { controller, calls, transcript, flush } = setup();
  transcript('Explain transformers'); flush();
  calls[0].options.onDelta('Attention ');
  const firstId = controller.snapshot().questions[0].requestId;
  calls[0].reject(Object.assign(new Error('Connection interrupted'), { code: 'NETWORK_ERROR' }));
  await settle();
  assert.equal(controller.snapshot().questions[0].answer, 'Attention ');
  assert.equal(controller.snapshot().questions[0].state, 'error');
  controller.retry(controller.snapshot().questions[0].id);
  assert.notEqual(controller.snapshot().questions[0].requestId, firstId);
  calls[0].options.onDelta('old request');
  assert.equal(controller.snapshot().questions[0].answer, '');
});

test('silence artifacts do not generate, short real follow-ups do', () => {
  const { calls, transcript, flush } = setup();
  transcript('[BLANK_AUDIO]'); transcript('um'); flush();
  assert.equal(calls.length, 0);
  transcript('Why?'); flush();
  assert.equal(calls.length, 1);
});

test('paused capture and an active answer are independent states', () => {
  const { controller, calls, transcript, flush } = setup();
  controller.setCaptureState('listening');
  transcript('Explain tokens'); flush();
  controller.pause();
  assert.equal(controller.snapshot().captureState, 'paused');
  assert.equal(controller.snapshot().questions[0].state, 'generating');
  assert.equal(calls[0].options.signal.aborted, false);
});

test('stop answer aborts only that attempt and proceeds to a finalized queued question', () => {
  const { controller, calls, transcript, flush } = setup();
  transcript('First?'); flush(); transcript('Second?'); flush();
  controller.stopAnswer(controller.snapshot().questions[0].id);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(calls.length, 2);
  assert.equal(controller.snapshot().questions[0].state, 'cancelled');
});
