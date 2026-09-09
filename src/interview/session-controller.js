'use strict';
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { CAPTURE_STATES } = require('./contracts');
const TurnDetector = require('./turn-detector');

// Finalized transcripts accumulate into `draft`. Explicit actions submit the
// draft immediately. Automatic submission waits for the acoustic detector to
// observe drained transcription work and a complete silence window.
class SessionController extends EventEmitter {
  constructor({ generate, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.generate = generate;
    this.source = 'system';
    this.mode = 'interview';
    this.sessionId = randomUUID();
    this.captureState = 'idle';
    this.questions = [];
    this.queue = [];
    this.draft = '';
    this.draftSource = 'system';
    this.seen = new Set();
    this.active = null;
    this.level = 0;
    this.statusMessage = '';
    this.autoAnswer = false;
    this.autoAnswerSilenceMs = 3000;
    this.activeCaptureId = null;
    this.turnDetector = new TurnDetector({
      silenceMs: this.autoAnswerSilenceMs,
      now,
      setTimer,
      clearTimer
    });
    this.turnDetector.on('state', () => this.publish());
    this.turnDetector.on('ready', event => this._commitReadyTurn(event));
    this.turnDetector.on('warning', warning => this.emit('warning', warning));
  }

  snapshot() {
    const turn = this.turnDetector.snapshot();
    return { sessionId: this.sessionId, captureState: this.captureState, source: this.source,
      mode: this.mode, level: this.level, draft: this.draft, statusMessage: this.statusMessage,
      questions: this.questions.map(q => ({ ...q })), activeQuestionId: this.active?.question.id || null,
      queueLength: this.queue.length, autoAnswer: this.autoAnswer, autoAnswerSilenceMs: this.autoAnswerSilenceMs,
      turnState: turn.turnState, turnDeadlineAt: turn.turnDeadlineAt,
      pendingTranscriptions: turn.pendingTranscriptions,
      hasVisibleAnswer: this.questions.some(question => Boolean(question.answer && question.answer.trim())) };
  }

  publish() { this.emit('state', this.snapshot()); }
  setCaptureState(state, message = '') {
    if (!CAPTURE_STATES.includes(state)) return;
    this.captureState = state;
    this.statusMessage = message;
    if (state !== 'listening') this.level = 0;
    this.publish();
  }
  setLevel(level) { this.level = Math.max(0, Math.min(1, Number(level) || 0)); this.publish(); }
  setMode(mode) { this.mode = mode; this.publish(); }
  setAutoAnswer(enabled, silenceMs) {
    this.autoAnswer = Boolean(enabled);
    if (Number.isFinite(silenceMs) && silenceMs > 0) {
      this.autoAnswerSilenceMs = silenceMs;
      this.turnDetector.silenceMs = silenceMs;
    }
    if (!this.autoAnswer) this._resetTurnDetector();
    this.publish();
  }
  beginCapture(captureId) {
    if (!Number.isFinite(captureId)) return;
    this.activeCaptureId = captureId;
    this.turnDetector.begin({ sessionId: this.sessionId, captureId });
  }
  noteSpeechStarted(event) { this.turnDetector.noteSpeechStarted(event); }
  noteSpeechEnded(event) { this.turnDetector.noteSpeechEnded(event); }
  noteTranscriptionStarted(event) { this.turnDetector.noteTranscriptionStarted(event); }
  noteTranscriptionSettled(event) { this.turnDetector.noteTranscriptionSettled(event); }

  startSession({ source = this.source, mode = this.mode } = {}) {
    this.clearSession();
    this.source = source;
    this.mode = mode;
    this.setCaptureState('starting');
    return this.sessionId;
  }
  pause() {
    this.setCaptureState('paused');
    this.activeCaptureId = null;
    this.turnDetector.cancel();
    this.answerNow();
  }
  resume() { this.setCaptureState('starting'); }
  endSession() {
    this.activeCaptureId = null;
    this.turnDetector.cancel();
    this._cancelActive();
    this.queue.forEach(q => { q.state = 'cancelled'; });
    this.queue = [];
    this.sessionId = randomUUID();
    this.seen.clear();
    this.setCaptureState('idle');
  }
  clearSession() {
    this.endSession();
    this.questions = [];
    this.draft = '';
    this.publish();
  }

  acceptTranscript(event) {
    if (!event || event.sessionId !== this.sessionId || !event.final || !event.utteranceId) return;
    if (Number.isFinite(event.captureId) && event.captureId !== this.activeCaptureId) return;
    const identity = `${event.source}:${event.utteranceId}`;
    if (this.seen.has(identity)) return;
    this.seen.add(identity);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text || /^(\[.*\]|\(.*\)|um|uh|hmm|hm|ah)[.!?]*$/i.test(text)) return;
    this.draft = this.draft ? `${this.draft} ${text}` : text;
    this.draftSource = event.source || this.source;
    this.publish();
  }

  answerNow(text) {
    this.turnDetector.cancel();
    const question = typeof text === 'string' ? text.trim() : this.draft.trim();
    if (!question) {
      this._resumeTurnDetection();
      return;
    }
    this.draft = '';
    const questionId = this.submit(question, this.draftSource);
    this._resumeTurnDetection();
    return questionId;
  }
  submit(text, source = 'typed') {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Enter a question first.');
    if (text.length > 20000) throw new Error('Keep the question under 20,000 characters.');
    const q = { id: randomUUID(), text: text.trim(), source, state: 'queued', answer: '', error: '', requestId: null };
    this.questions.push(q);
    // Keep completed history bounded without discarding pending questions.
    while (this.questions.length > 100) {
      const i = this.questions.findIndex(item => ['completed', 'cancelled'].includes(item.state));
      if (i < 0) break;
      this.questions.splice(i, 1);
    }
    this.emit('question', { ...q });
    if (this.queue.length >= 3) {
      q.state = 'overflow';
      q.error = 'The answer queue is full. Retry this question when a slot opens.';
    } else this.queue.push(q);
    this.publish();
    this._pump();
    return q.id;
  }

  retry(questionId) {
    const q = this.questions.find(item => item.id === questionId);
    if (!q || !['error', 'cancelled', 'overflow', 'completed'].includes(q.state)) return;
    if (this.queue.length >= 3) throw new Error('The answer queue is full. Try again after an answer completes.');
    q.state = 'queued'; q.error = ''; q.answer = ''; q.requestId = null;
    this.queue.push(q); this.publish(); this._pump();
  }
  stopAnswer(questionId) {
    if (this.active?.question.id === questionId) this._cancelActive();
    else {
      const q = this.queue.find(item => item.id === questionId);
      if (q) { q.state = 'cancelled'; this.queue = this.queue.filter(item => item !== q); }
    }
    this.publish(); this._pump();
  }
  _commitReadyTurn(event) {
    if (!this.autoAnswer || this.source === 'microphone') return;
    if (event.sessionId !== this.sessionId || event.captureId !== this.activeCaptureId || !this.draft.trim()) return;
    this.answerNow();
  }
  _resetTurnDetector() {
    this.turnDetector.cancel();
    this._resumeTurnDetection();
  }
  _resumeTurnDetection() {
    if (this.activeCaptureId === null || !['starting', 'listening', 'recovering'].includes(this.captureState)) return;
    this.turnDetector.begin({ sessionId: this.sessionId, captureId: this.activeCaptureId });
  }
  _cancelActive() {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    active.question.state = 'cancelled';
    active.abort.abort();
  }
  _pump() {
    if (this.active || !this.queue.length) return;
    const question = this.queue.shift();
    const attempt = { question, sessionId: this.sessionId, abort: new AbortController() };
    this.active = attempt;
    question.state = 'generating';
    question.requestId = randomUUID();
    question.answer = '';
    question.error = '';
    this.publish();
    const isCurrent = () => this.active === attempt && this.sessionId === attempt.sessionId;
    const onDelta = delta => {
      if (!isCurrent() || typeof delta !== 'string') return;
      question.answer += delta;
      this.publish();
    };
    let result;
    try { result = this.generate({ ...question }, { signal: attempt.abort.signal, onDelta }); }
    catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(value => {
      if (!isCurrent()) return;
      const text = typeof value === 'string' ? value : value?.response ?? value?.text;
      if (!text?.trim()) throw Object.assign(new Error('The model returned no answer. Retry this question.'), { code: 'EMPTY_RESPONSE' });
      question.answer = text;
      question.state = 'completed';
      this.emit('answer', { ...question });
    }).catch(error => {
      if (!isCurrent()) return;
      question.state = error.code === 'CANCELLED' ? 'cancelled' : 'error';
      question.error = error.message || 'The answer could not be completed. Try again.';
    }).finally(() => {
      if (!isCurrent()) return;
      this.active = null;
      this.publish();
      this._pump();
    });
  }
}
module.exports = SessionController;
