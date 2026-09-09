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
  return { controller, calls, transcript, flush };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function setupTurnLifecycle({ source = 'system' } = {}) {
  const clock = createClock(1000);
  const generationCalls = [];
  const controller = new SessionController({
    generate: (question, options) => {
      generationCalls.push({ question, options });
      return new Promise(() => {});
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  controller.startSession({ source });
  controller.setAutoAnswer(true, 3000);
  controller.beginCapture(7);
  const startSpeech = (utteranceId) => controller.noteSpeechStarted({
    captureId: 7, utteranceId, at: clock.now()
  });
  const settleTranscript = (text, utteranceId, speechEndedAt, errorCode = null) => {
    controller.noteSpeechEnded({ captureId: 7, utteranceId, speechEndedAt });
    controller.noteTranscriptionStarted({ captureId: 7, utteranceId, speechEndedAt });
    controller.acceptTranscript({
      sessionId: controller.sessionId, captureId: 7, source, final: true,
      utteranceId, speechEndedAt, text: errorCode ? '' : text
    });
    controller.noteTranscriptionSettled({ captureId: 7, utteranceId, speechEndedAt, text, errorCode });
  };
  return { clock, controller, generationCalls, startSpeech, settleTranscript };
}

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

test('a two-second planning pause remains one automatically submitted question', () => {
  const { clock, generationCalls, startSpeech, settleTranscript } = setupTurnLifecycle();
  settleTranscript('Explain how transformers work', 'u1', 1000);
  clock.advance(2000);
  startSpeech('u2');
  clock.advance(1500);
  settleTranscript('and how they are trained', 'u2', 4500);
  clock.advance(2999);
  assert.equal(generationCalls.length, 0);
  clock.advance(1);
  assert.equal(generationCalls[0].question.text,
    'Explain how transformers work and how they are trained');
});

test('stale, failed, and duplicate lifecycle events do not change the current turn', () => {
  const { controller, settleTranscript } = setupTurnLifecycle();
  settleTranscript('Explain queues', 'u1', 1000);
  const beforeStale = controller.snapshot();
  controller.noteSpeechStarted({ captureId: 6, utteranceId: 'stale', at: 1100 });
  controller.noteSpeechEnded({ captureId: 6, utteranceId: 'stale', speechEndedAt: 1200 });
  controller.noteTranscriptionStarted({ captureId: 6, utteranceId: 'stale', speechEndedAt: 1200 });
  controller.acceptTranscript({
    sessionId: controller.sessionId, captureId: 6, source: 'system', final: true,
    utteranceId: 'stale', speechEndedAt: 1200, text: 'stale text'
  });
  controller.noteTranscriptionSettled({
    captureId: 6, utteranceId: 'stale', speechEndedAt: 1200,
    text: 'stale text', errorCode: null
  });
  assert.equal(controller.snapshot().draft, beforeStale.draft);
  assert.equal(controller.snapshot().pendingTranscriptions, beforeStale.pendingTranscriptions);
  assert.equal(controller.snapshot().turnDeadlineAt, beforeStale.turnDeadlineAt);

  controller.noteTranscriptionStarted({ captureId: 7, utteranceId: 'failed', speechEndedAt: 1200 });
  controller.noteTranscriptionStarted({ captureId: 7, utteranceId: 'failed', speechEndedAt: 1200 });
  controller.acceptTranscript({
    sessionId: controller.sessionId, captureId: 7, source: 'system', final: true,
    utteranceId: 'failed', speechEndedAt: 1200, text: ''
  });
  controller.noteTranscriptionSettled({
    captureId: 7, utteranceId: 'failed', speechEndedAt: 1200,
    text: '', errorCode: 'TRANSCRIPTION_FAILED'
  });
  controller.noteTranscriptionSettled({
    captureId: 7, utteranceId: 'failed', speechEndedAt: 1200,
    text: '', errorCode: 'TRANSCRIPTION_FAILED'
  });
  assert.equal(controller.snapshot().draft, 'Explain queues');
  assert.equal(controller.snapshot().pendingTranscriptions, 0);
});

test('Answer now submits immediately while the acoustic deadline is pending', () => {
  const { controller, generationCalls, settleTranscript } = setupTurnLifecycle();
  settleTranscript('What is dynamic programming?', 'u1', 1000);
  assert.equal(controller.snapshot().turnState, 'waiting');
  controller.answerNow();
  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].question.text, 'What is dynamic programming?');
});

test('microphone lifecycle never automatically submits a draft', () => {
  const { clock, controller, generationCalls, settleTranscript } = setupTurnLifecycle({ source: 'microphone' });
  settleTranscript('Tell them about my background', 'u1', 1000);
  clock.advance(10000);
  assert.equal(generationCalls.length, 0);
  assert.equal(controller.snapshot().draft, 'Tell them about my background');
});

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

test('acceptTranscript appends text without owning an automatic-answer timer', () => {
  let scheduled = 0;
  const controller = new SessionController({
    generate: () => new Promise(() => {}),
    setTimer: () => { scheduled++; return scheduled; },
    clearTimer: () => {}
  });
  controller.startSession();
  controller.setAutoAnswer(true, 3000);
  controller.acceptTranscript({
    sessionId: controller.sessionId, text: 'What is recursion?', utteranceId: 'u1',
    source: 'system', final: true, speechEndedAt: Date.now() - 4000
  });
  assert.equal(scheduled, 0);
  assert.equal(controller.snapshot().draft, 'What is recursion?');
});

test('auto-answer restarts its silence timer on every new fragment', () => {
  const { clock, generationCalls, startSpeech, settleTranscript } = setupTurnLifecycle();
  settleTranscript('Explain the', 'u1', 1000);
  clock.advance(2000);
  startSpeech('u2');
  settleTranscript('event loop', 'u2', 3000);
  // The second speech onset must replace the earlier acoustic deadline.
  clock.advance(3000);
  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].question.text, 'Explain the event loop');
});

test('turning auto-answer off cancels a pending acoustic deadline', () => {
  const { clock, controller, generationCalls, settleTranscript } = setupTurnLifecycle();
  settleTranscript('Some question', 'u1', 1000);
  assert.equal(controller.snapshot().turnState, 'waiting');
  controller.setAutoAnswer(false);
  clock.advance(3000);
  assert.equal(generationCalls.length, 0);
  assert.equal(controller.snapshot().turnDeadlineAt, null);
});

test('clear invalidates late lifecycle events from the previous capture', () => {
  const { clock, controller, generationCalls } = setupTurnLifecycle();
  const oldSessionId = controller.sessionId;
  controller.noteSpeechEnded({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  controller.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
  controller.clearSession();
  controller.acceptTranscript({
    sessionId: oldSessionId, captureId: 7, source: 'system', final: true,
    utteranceId: 'u1', speechEndedAt: 1000, text: 'stale question'
  });
  controller.noteTranscriptionSettled({
    captureId: 7, utteranceId: 'u1', speechEndedAt: 1000,
    text: 'stale question', errorCode: null
  });
  clock.advance(10000);
  assert.equal(generationCalls.length, 0);
  assert.equal(controller.snapshot().draft, '');
  assert.equal(controller.snapshot().turnState, 'idle');
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
