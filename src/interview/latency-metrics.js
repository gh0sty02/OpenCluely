'use strict';

// Content-free latency diagnostics for one interview turn's answer pipeline.
//
// LatencyMetrics never sees the question text, transcript, or answer, only
// question/request IDs, provider/model/source metadata, and stage
// timestamps supplied by the caller. It tracks a bounded ring of in-flight
// ("active") records and a bounded ring of finished ("completed") records,
// and can summarize completed durations as p50/p95.
//
// Stage timestamps, in the order a turn normally reaches them:
//   speechEndedAt       - the acoustic turn detector's last speech-ended time
//   transcriptReadyAt   - when the last pending transcription job settled
//   questionCommittedAt - when the turn was finalized and queued for an answer
//   firstVisibleTokenAt - the first non-empty, already-filtered answer delta
//
// Durations derived from those stages:
//   transcriptionMs - transcriptReadyAt - speechEndedAt
//   endpointWaitMs  - questionCommittedAt - transcriptReadyAt
//   firstTokenMs    - firstVisibleTokenAt - questionCommittedAt
//   totalMs         - completedAt - (speechEndedAt ?? questionCommittedAt)

const logger = require('../core/logger').createServiceLogger('LATENCY');

const DEFAULT_COMPLETED_LIMIT = 50;
const DEFAULT_ACTIVE_LIMIT = 10;
const STAGE_NAMES = ['transcriptReadyAt', 'questionCommittedAt', 'firstVisibleTokenAt'];
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function durationOrNull(end, start) {
  return Number.isFinite(end) && Number.isFinite(start) ? end - start : null;
}

function sanitizeErrorCode(code) {
  if (!code) return null;
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'UNKNOWN_ERROR';
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const rank = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[rank];
}

class LatencyMetrics {
  constructor({ limit = DEFAULT_COMPLETED_LIMIT, activeLimit = DEFAULT_ACTIVE_LIMIT, now = Date.now } = {}) {
    this.limit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_COMPLETED_LIMIT;
    this.activeLimit = Number.isFinite(activeLimit) && activeLimit > 0 ? activeLimit : DEFAULT_ACTIVE_LIMIT;
    this.now = typeof now === 'function' ? now : Date.now;
    this.active = new Map(); // id -> record, insertion order = age order
    this.completed = []; // bounded ring, oldest first
  }

  // Begin tracking one question's answer pipeline. `context` may carry the
  // acoustic speechEndedAt timestamp plus provider/model/source/warm
  // metadata, never question/transcript/answer text.
  begin(id, context = {}) {
    if (typeof id !== 'string' || !id) return null;
    if (!this.active.has(id) && this.active.size >= this.activeLimit) {
      const oldestId = this.active.keys().next().value;
      if (oldestId !== undefined) this.active.delete(oldestId);
    }
    const record = {
      id,
      provider: context.provider ?? null,
      model: context.model ?? null,
      source: context.source ?? null,
      warm: context.warm ?? null,
      timestamps: {
        speechEndedAt: numberOrNull(context.speechEndedAt),
        transcriptReadyAt: null,
        questionCommittedAt: null,
        firstVisibleTokenAt: null,
      },
    };
    this.active.set(id, record);
    return record;
  }

  // Attach/update provider/model/source/warm metadata on an active record
  // (e.g. once the caller knows which provider is handling the request).
  // Safe no-op for an unknown id.
  annotate(id, fields = {}) {
    const record = this.active.get(id);
    if (!record) return false;
    if ('provider' in fields) record.provider = fields.provider ?? record.provider;
    if ('model' in fields) record.model = fields.model ?? record.model;
    if ('source' in fields) record.source = fields.source ?? record.source;
    if ('warm' in fields) record.warm = fields.warm ?? record.warm;
    return true;
  }

  // Record a stage timestamp on an active record. Safe no-op for an
  // unknown id or an unrecognized stage name.
  mark(id, stage, at) {
    const record = this.active.get(id);
    if (!record || !STAGE_NAMES.includes(stage) || !Number.isFinite(at)) return false;
    record.timestamps[stage] = at;
    return true;
  }

  // Terminal event: the answer completed successfully.
  complete(id, at) {
    return this._finish(id, at, null);
  }

  // Terminal event: the answer failed or was cancelled. `errorCode` is
  // sanitized to a known-shape code so no free-form error text (which could
  // contain provider-echoed content) ever reaches storage or logs.
  fail(id, at, errorCode) {
    return this._finish(id, at, sanitizeErrorCode(errorCode) || 'UNKNOWN_ERROR');
  }

  _finish(id, at, errorCode) {
    const record = this.active.get(id);
    if (!record) return null;
    this.active.delete(id);

    const completedAt = Number.isFinite(at) ? at : this.now();
    const t = record.timestamps;
    const durations = {
      transcriptionMs: durationOrNull(t.transcriptReadyAt, t.speechEndedAt),
      endpointWaitMs: durationOrNull(t.questionCommittedAt, t.transcriptReadyAt),
      firstTokenMs: durationOrNull(t.firstVisibleTokenAt, t.questionCommittedAt),
      totalMs: durationOrNull(completedAt, t.speechEndedAt ?? t.questionCommittedAt),
    };
    const completedRecord = {
      id: record.id,
      provider: record.provider,
      model: record.model,
      source: record.source,
      warm: record.warm,
      status: errorCode ? 'error' : 'completed',
      errorCode: errorCode || null,
      durations,
    };

    this.completed.push(completedRecord);
    while (this.completed.length > this.limit) this.completed.shift();
    this._log(completedRecord);
    return completedRecord;
  }

  _log(record) {
    logger.info('interview answer latency', {
      questionId: record.id,
      provider: record.provider,
      model: record.model,
      source: record.source,
      warm: record.warm,
      status: record.status,
      errorCode: record.errorCode,
      durations: record.durations,
    });
  }

  // count, p50, p95 for each latency stage across completed records.
  getSummary() {
    const summarize = key => {
      const sorted = this.completed
        .map(record => record.durations[key])
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
    };
    return {
      count: this.completed.length,
      transcriptionMs: summarize('transcriptionMs'),
      endpointWaitMs: summarize('endpointWaitMs'),
      firstTokenMs: summarize('firstTokenMs'),
      totalMs: summarize('totalMs'),
    };
  }
}

module.exports = LatencyMetrics;
