'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Unlike tests/latency-metrics.test.js and tests/interview-session.test.js
// (which stub src/core/logger entirely so LatencyMetrics/SessionController
// tests don't touch disk), this file requires the real, unstubbed logger so
// its credential/URL redaction logic is actually exercised.
const logger = require('../src/core/logger');
const { redactMeta, redactValue } = logger;

test('a key exactly matching the sensitive-key pattern is redacted', () => {
  const input = { apiKey: 'sk-live-12345', token: 'abc.def.ghi', password: 'hunter2', secret: 'shh', credential: 'x', authorization: 'Bearer y' };
  const output = redactMeta(input);
  assert.equal(output.apiKey, '[REDACTED]');
  assert.equal(output.token, '[REDACTED]');
  assert.equal(output.password, '[REDACTED]');
  assert.equal(output.secret, '[REDACTED]');
  assert.equal(output.credential, '[REDACTED]');
  assert.equal(output.authorization, '[REDACTED]');
});

test('the sensitive-key pattern is case-insensitive and tolerates a trailing plural or hyphen/underscore variant', () => {
  const input = { ApiKey: 'a', API_KEY: 'b', 'api-key': 'c', tokens: 'd', Passwords: 'e', SECRET: 'f' };
  const output = redactMeta(input);
  assert.equal(output.ApiKey, '[REDACTED]');
  assert.equal(output.API_KEY, '[REDACTED]');
  assert.equal(output['api-key'], '[REDACTED]');
  assert.equal(output.tokens, '[REDACTED]');
  assert.equal(output.Passwords, '[REDACTED]');
  assert.equal(output.SECRET, '[REDACTED]');
});

test('a URL value carrying a query string has the query string stripped', () => {
  const url = 'https://api.example.com/v1/models?key=sk-live-12345&user=me';
  assert.equal(redactValue(url, 0), 'https://api.example.com/v1/models?[REDACTED]');

  const output = redactMeta({ endpoint: url });
  assert.equal(output.endpoint, 'https://api.example.com/v1/models?[REDACTED]');
});

test('a URL value with no query string passes through unchanged', () => {
  const url = 'https://api.example.com/v1/models';
  assert.equal(redactValue(url, 0), url);
});

test('non-sensitive keys and plain string/number/boolean values pass through unredacted', () => {
  const input = { questionId: 'q1', provider: 'openrouter', durationMs: 420, warm: true, note: 'hello world' };
  const output = redactMeta(input);
  assert.deepEqual(output, input);
});

test('nested objects are redacted recursively within the depth cap', () => {
  const input = { level1: { level2: { level3: { apiKey: 'deep-secret', ok: 'fine' } } } };
  const output = redactMeta(input);
  assert.equal(output.level1.level2.level3.apiKey, '[REDACTED]');
  assert.equal(output.level1.level2.level3.ok, 'fine');
});

test('redaction also recurses into arrays of objects', () => {
  const input = { items: [{ token: 'a' }, { token: 'b' }, { note: 'plain' }] };
  const output = redactMeta(input);
  assert.equal(output.items[0].token, '[REDACTED]');
  assert.equal(output.items[1].token, '[REDACTED]');
  assert.equal(output.items[2].note, 'plain');
});

test('past the depth cap, redaction stops and nested content is returned as-is', () => {
  // redactMeta bails out (returns `meta` unchanged) once depth > 6. Seven
  // levels of nesting (a..g) pushes the object holding the sensitive key
  // past that cap, so it comes back unredacted -- this test documents that
  // real, current behavior rather than asserting a stricter guarantee.
  const deepest = { apiKey: 'should-not-be-redacted-past-cap', note: 'deep' };
  const input = { a: { b: { c: { d: { e: { f: { g: deepest } } } } } } };
  const output = redactMeta(input);
  assert.equal(output.a.b.c.d.e.f.g.apiKey, 'should-not-be-redacted-past-cap');
  assert.deepEqual(output.a.b.c.d.e.f.g, deepest);
});

test('within the depth cap, a sensitive key several levels deep is still redacted', () => {
  const input = { a: { b: { c: { d: { apiKey: 'within-cap' } } } } };
  const output = redactMeta(input);
  assert.equal(output.a.b.c.d.apiKey, '[REDACTED]');
});

test('redactMeta is a safe no-op for non-object or null meta', () => {
  assert.equal(redactMeta(null), null);
  assert.equal(redactMeta(undefined), undefined);
  assert.equal(redactMeta('plain string'), 'plain string');
  assert.equal(redactMeta(42), 42);
});
