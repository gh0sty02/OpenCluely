'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// LatencyMetrics logs a sanitized line per completed/failed record. Stub the
// logger (same pattern as tests/interview-prompts.test.js and
// tests/provider-streaming.test.js) so tests run without touching disk and
// can inspect exactly what was logged.
const loggedCalls = [];
const loggerPath = require.resolve('../src/core/logger');
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: {
    createServiceLogger: () => ({
      debug(message, meta) { loggedCalls.push({ level: 'debug', message, meta }); },
      info(message, meta) { loggedCalls.push({ level: 'info', message, meta }); },
      warn(message, meta) { loggedCalls.push({ level: 'warn', message, meta }); },
      error(message, meta) { loggedCalls.push({ level: 'error', message, meta }); },
      logPerformance() {}
    })
  }
};

const LatencyMetrics = require('../src/interview/latency-metrics');

test.beforeEach(() => { loggedCalls.length = 0; });

test('records stage durations without ever storing content', () => {
  const metrics = new LatencyMetrics({ limit: 50 });
  metrics.begin('q1', { speechEndedAt: 1000 });
  metrics.mark('q1', 'transcriptReadyAt', 1600);
  metrics.mark('q1', 'questionCommittedAt', 4000);
  metrics.mark('q1', 'firstVisibleTokenAt', 4500);
  const record = metrics.complete('q1', 5200);
  assert.equal(record.durations.transcriptionMs, 600);
  assert.equal(record.durations.endpointWaitMs, 2400);
  assert.equal(record.durations.firstTokenMs, 500);
  assert.equal(record.durations.totalMs, 4200);
  assert.equal('text' in record, false);
});

test('stores IDs, provider, model, source, and warm state', () => {
  const metrics = new LatencyMetrics();
  metrics.begin('q1', { speechEndedAt: 100, provider: 'openrouter', model: 'gpt-x', source: 'system', warm: true });
  const record = metrics.complete('q1', 900);
  assert.equal(record.id, 'q1');
  assert.equal(record.provider, 'openrouter');
  assert.equal(record.model, 'gpt-x');
  assert.equal(record.source, 'system');
  assert.equal(record.warm, true);
  assert.equal(record.status, 'completed');
  assert.equal(record.errorCode, null);
});

test('annotate attaches provider/model metadata to an active record after begin', () => {
  const metrics = new LatencyMetrics();
  metrics.begin('q1', { speechEndedAt: 100 });
  const attached = metrics.annotate('q1', { provider: 'gemini', model: 'flash', warm: false });
  assert.equal(attached, true);
  const record = metrics.complete('q1', 500);
  assert.equal(record.provider, 'gemini');
  assert.equal(record.model, 'flash');
  assert.equal(record.warm, false);
});

test('annotate on an unknown id is a safe no-op', () => {
  const metrics = new LatencyMetrics();
  assert.equal(metrics.annotate('missing', { provider: 'x' }), false);
});

test('mark() for an unknown question id is a safe no-op', () => {
  const metrics = new LatencyMetrics();
  assert.equal(metrics.mark('missing', 'transcriptReadyAt', 100), false);
});

test('mark() for an unknown stage name is a safe no-op', () => {
  const metrics = new LatencyMetrics();
  metrics.begin('q1', { speechEndedAt: 100 });
  assert.equal(metrics.mark('q1', 'notARealStage', 200), false);
});

test('complete() for a question never begun returns null and logs nothing', () => {
  const metrics = new LatencyMetrics();
  const record = metrics.complete('never-begun', 1000);
  assert.equal(record, null);
  assert.equal(loggedCalls.length, 0);
});

test('fail() for a question never begun returns null and logs nothing', () => {
  const metrics = new LatencyMetrics();
  const record = metrics.fail('never-begun', 1000, 'NETWORK_ERROR');
  assert.equal(record, null);
  assert.equal(loggedCalls.length, 0);
});

test('fail() records a sanitized error code and completes the record exactly once', () => {
  const metrics = new LatencyMetrics();
  metrics.begin('q1', { speechEndedAt: 100 });
  metrics.mark('q1', 'questionCommittedAt', 300);
  const record = metrics.fail('q1', 400, 'NETWORK_ERROR');
  assert.equal(record.status, 'error');
  assert.equal(record.errorCode, 'NETWORK_ERROR');
  // Completing an id twice (already removed from active) is a no-op.
  assert.equal(metrics.complete('q1', 500), null);
});

test('unrecognized or free-form error codes are sanitized to a fixed placeholder', () => {
  const metrics = new LatencyMetrics();
  metrics.begin('q1', { speechEndedAt: 100 });
  const record = metrics.fail('q1', 400, 'the user said something odd: leaked text');
  assert.equal(record.errorCode, 'UNKNOWN_ERROR');
});

test('missing stages yield null durations instead of NaN or throwing', () => {
  const metrics = new LatencyMetrics();
  metrics.begin('q1', {});
  metrics.mark('q1', 'questionCommittedAt', 100);
  const record = metrics.complete('q1', 300);
  assert.equal(record.durations.transcriptionMs, null);
  assert.equal(record.durations.endpointWaitMs, null);
  assert.equal(record.durations.firstTokenMs, null);
  assert.equal(record.durations.totalMs, 200);
});

test('the completed ring is bounded at the configured limit', () => {
  const metrics = new LatencyMetrics({ limit: 3 });
  for (let i = 0; i < 5; i++) {
    metrics.begin(`q${i}`, { speechEndedAt: i * 10 });
    metrics.complete(`q${i}`, i * 10 + 5);
  }
  const summary = metrics.getSummary();
  assert.equal(summary.count, 3);
});

test('the active ring is bounded at 10 in-flight records', () => {
  const metrics = new LatencyMetrics();
  for (let i = 0; i < 11; i++) metrics.begin(`q${i}`, { speechEndedAt: i });
  // The oldest active record (q0) should have been evicted to make room.
  assert.equal(metrics.mark('q0', 'questionCommittedAt', 100), false);
  // The newest is still tracked.
  assert.equal(metrics.mark('q10', 'questionCommittedAt', 100), true);
});

test('getSummary reports count, p50, and p95 for each latency stage', () => {
  const metrics = new LatencyMetrics();
  const samples = [
    { speechEndedAt: 0, transcriptReadyAt: 100, questionCommittedAt: 200, firstVisibleTokenAt: 400, completedAt: 500 },
    { speechEndedAt: 0, transcriptReadyAt: 200, questionCommittedAt: 400, firstVisibleTokenAt: 900, completedAt: 1000 },
    { speechEndedAt: 0, transcriptReadyAt: 300, questionCommittedAt: 600, firstVisibleTokenAt: 1400, completedAt: 1500 },
  ];
  samples.forEach((sample, index) => {
    metrics.begin(`q${index}`, { speechEndedAt: sample.speechEndedAt });
    metrics.mark(`q${index}`, 'transcriptReadyAt', sample.transcriptReadyAt);
    metrics.mark(`q${index}`, 'questionCommittedAt', sample.questionCommittedAt);
    metrics.mark(`q${index}`, 'firstVisibleTokenAt', sample.firstVisibleTokenAt);
    metrics.complete(`q${index}`, sample.completedAt);
  });
  const summary = metrics.getSummary();
  assert.equal(summary.count, 3);
  assert.equal(summary.transcriptionMs.count, 3);
  assert.ok(Number.isFinite(summary.transcriptionMs.p50));
  assert.ok(Number.isFinite(summary.transcriptionMs.p95));
  assert.ok(Number.isFinite(summary.endpointWaitMs.p50));
  assert.ok(Number.isFinite(summary.firstTokenMs.p50));
  assert.ok(Number.isFinite(summary.totalMs.p50));
});

test('getSummary on an empty ring reports zero count and null percentiles', () => {
  const metrics = new LatencyMetrics();
  const summary = metrics.getSummary();
  assert.equal(summary.count, 0);
  assert.equal(summary.transcriptionMs.p50, null);
  assert.equal(summary.transcriptionMs.p95, null);
});

test('logs a sanitized record with no prompt, transcript, answer, or credential fields', () => {
  const metrics = new LatencyMetrics();
  metrics.begin('q1', { speechEndedAt: 100, provider: 'openrouter', model: 'gpt-x', source: 'system' });
  metrics.mark('q1', 'transcriptReadyAt', 200);
  metrics.mark('q1', 'questionCommittedAt', 300);
  metrics.complete('q1', 900);

  assert.ok(loggedCalls.length >= 1);
  // Only the shape (field names, and the fixed diagnostic message) is
  // allowed to mention these words, not any logged *meta value* containing
  // prompt/transcript/answer/credential content. ("transcriptionMs" is an
  // expected field name, and "interview answer latency" a fixed message;
  // neither should trip this, since only dynamic values matter.)
  const values = [];
  const collectValues = value => {
    if (value && typeof value === 'object') Object.values(value).forEach(collectValues);
    else values.push(String(value));
  };
  loggedCalls.forEach(call => collectValues(call.meta));
  const serializedValues = values.join(' ').toLowerCase();
  ['prompt', 'transcript', 'answer', 'apikey', 'api_key', 'authorization', 'credential'].forEach(forbidden => {
    assert.equal(serializedValues.includes(forbidden.toLowerCase()), false, `logged value leaked "${forbidden}"`);
  });
  const call = loggedCalls[0];
  assert.equal(call.meta.questionId, 'q1');
  assert.equal(call.meta.provider, 'openrouter');
});
