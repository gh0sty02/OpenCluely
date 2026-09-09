'use strict';

const { EventEmitter } = require('events');

const MAX_PENDING_TRANSCRIPTIONS = 100;

class TurnDetector extends EventEmitter {
  constructor({ silenceMs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    if (!Number.isFinite(silenceMs) || silenceMs <= 0) {
      throw new TypeError('silenceMs must be a positive finite number');
    }
    this.silenceMs = silenceMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sessionId = null;
    this.captureId = null;
    this.speakerActive = false;
    this.lastSpeechEndedAt = null;
    this.pending = new Set();
    this.transcriptions = new Set();
    this.speechEvents = new Map();
    this.deadlineAt = null;
    this.timer = null;
    this.timerGeneration = 0;
    this.readyEmitted = false;
  }

  begin({ sessionId, captureId } = {}) {
    this._clearDeadline();
    this.sessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
    this.captureId = Number.isFinite(captureId) ? captureId : null;
    this.speakerActive = false;
    this.lastSpeechEndedAt = null;
    this.pending = new Set();
    this.transcriptions = new Set();
    this.speechEvents = new Map();
    this.readyEmitted = false;
    this.emit('state', this.snapshot());
  }

  cancel() {
    this._clearDeadline();
    this.sessionId = null;
    this.captureId = null;
    this.speakerActive = false;
    this.lastSpeechEndedAt = null;
    this.pending = new Set();
    this.transcriptions = new Set();
    this.speechEvents = new Map();
    this.readyEmitted = false;
    this.emit('state', this.snapshot());
  }

  noteSpeechStarted(event) {
    if (!this._matches(event, 'at') || !this._validUtterance(event)) return;
    if (this.speechEvents.has(event.utteranceId)) return;
    this.speechEvents.set(event.utteranceId, 'started');
    this.speakerActive = true;
    this.readyEmitted = false;
    this._clearDeadline();
    this.emit('state', this.snapshot());
  }

  noteSpeechEnded(event) {
    if (!this._matches(event, 'speechEndedAt') || !this._validUtterance(event)) return;
    if (this.speechEvents.get(event.utteranceId) === 'ended') return;
    this.speechEvents.set(event.utteranceId, 'ended');
    this.speakerActive = false;
    this.readyEmitted = false;
    this.lastSpeechEndedAt = Math.max(this.lastSpeechEndedAt || 0, event.speechEndedAt);
    this._scheduleIfEligible();
  }

  noteTranscriptionStarted(event) {
    if (!this._matches(event, 'speechEndedAt') || !this._validUtterance(event)) return;
    if (this.transcriptions.has(event.utteranceId)) return;
    if (this.pending.size >= MAX_PENDING_TRANSCRIPTIONS) {
      const error = Object.assign(new Error('Too many transcriptions are pending.'), {
        code: 'TRANSCRIPTION_BACKLOG'
      });
      this.emit('warning', error);
      return;
    }
    this.transcriptions.add(event.utteranceId);
    this.pending.add(event.utteranceId);
    this._clearDeadline();
    this.emit('state', this.snapshot());
  }

  noteTranscriptionSettled(event) {
    if (!this._matches(event, 'speechEndedAt') || !this._validUtterance(event)) return;
    if (!this.pending.delete(event.utteranceId)) return;
    if (this.speakerActive) {
      this.emit('state', this.snapshot());
      return;
    }
    this._scheduleIfEligible();
  }

  forceReady() {
    if (this.sessionId === null || this.captureId === null || this.speakerActive ||
      this.pending.size || this.lastSpeechEndedAt === null || this.readyEmitted) return;
    this._clearDeadline();
    this._emitReady();
  }

  snapshot() {
    let turnState = 'idle';
    if (this.readyEmitted) turnState = 'ready';
    else if (this.speakerActive) turnState = 'speaking';
    else if (this.pending.size) turnState = 'transcribing';
    else if (this.lastSpeechEndedAt !== null) turnState = 'waiting';
    return {
      sessionId: this.sessionId,
      captureId: this.captureId,
      turnState,
      turnDeadlineAt: this.deadlineAt,
      pendingTranscriptions: this.pending.size,
      speakerActive: this.speakerActive,
      speechEndedAt: this.lastSpeechEndedAt
    };
  }

  _matches(event, timestampField) {
    return this.sessionId !== null && this.captureId !== null && event &&
      event.captureId === this.captureId && Number.isFinite(event[timestampField]);
  }

  _validUtterance(event) {
    return typeof event.utteranceId === 'string' && event.utteranceId.length > 0;
  }

  _scheduleIfEligible() {
    this._clearDeadline();
    if (this.speakerActive || this.pending.size || this.lastSpeechEndedAt === null) {
      this.emit('state', this.snapshot());
      return;
    }
    this.deadlineAt = this.lastSpeechEndedAt + this.silenceMs;
    const delay = Math.max(0, this.deadlineAt - this.now());
    const generation = this.timerGeneration;
    if (delay === 0) {
      this._tryReady(generation);
      return;
    }
    this.timer = this.setTimer(() => this._tryReady(generation), delay);
    this.emit('state', this.snapshot());
  }

  _tryReady(generation) {
    if (generation !== this.timerGeneration) return;
    this.timer = null;
    if (this.sessionId === null || this.captureId === null || this.readyEmitted ||
      this.speakerActive || this.pending.size || this.deadlineAt === null ||
      this.lastSpeechEndedAt === null || this.now() < this.deadlineAt) return;
    this._emitReady();
  }

  _emitReady() {
    this.readyEmitted = true;
    this.deadlineAt = null;
    const event = {
      sessionId: this.sessionId,
      captureId: this.captureId,
      speechEndedAt: this.lastSpeechEndedAt
    };
    this.emit('state', this.snapshot());
    this.emit('ready', event);
  }

  _clearDeadline() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.deadlineAt = null;
    this.timerGeneration++;
  }
}

module.exports = TurnDetector;
