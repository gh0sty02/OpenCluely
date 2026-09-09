'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SSEParser, streamCompletion, openAIEvent, geminiEvent } = require('../src/services/sse-parser');

const event = (text, reason = null) => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: reason }] })}\r\n\r\n`;

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { transport: http, requestOptions: { hostname: '127.0.0.1', port: server.address().port, method: 'POST' }, body: '{}', parseEvent: openAIEvent, retryDelayMs: 1 };
}

test('SSE parser preserves split UTF-8, CRLF, comments and multiline data', () => {
  const events = [];
  const parser = new SSEParser(data => events.push(data));
  const bytes = Buffer.from(': ping\r\ndata: hello 🌍\r\ndata: world\r\n\r\ndata: last\n\n');
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(events, ['hello 🌍\nworld', 'last']);
});

test('SSE parser bounds incomplete frames', () => {
  const parser = new SSEParser(() => {}, { maxEventBytes: 20 });
  assert.throws(() => parser.push('data: ' + 'x'.repeat(21)), { code: 'MALFORMED_RESPONSE' });
});

test('multiple events, Unicode, and completion resolve exactly once', async t => {
  const options = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(event('Hello 🌍') + event('!', 'stop') + 'data: [DONE]\n\n');
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end();
  });
  const deltas = [];
  const result = await streamCompletion({ ...options, onDelta: delta => deltas.push(delta) });
  assert.equal(result.text, 'Hello 🌍!');
  assert.equal(deltas.join(''), result.text);
  assert.equal(result.finishReason, 'stop');
  assert.ok(result.timing.firstTokenMs >= 0);
});

test('stream completion emits and returns only text after split leading reasoning blocks', async t => {
  const options = await fixture(t, (_req, res) => {
    res.write(event('<thi'));
    res.write(event('nk>private'));
    res.end(event('</think>\n\nVisible answer', 'stop'));
  });
  const deltas = [];
  const result = await streamCompletion({ ...options, onDelta: delta => deltas.push(delta) });
  assert.equal(result.text, 'Visible answer');
  assert.deepEqual(deltas, ['Visible answer']);
});

test('stream completion rejects reasoning-only output as empty', async t => {
  const options = await fixture(t, (_req, res) => {
    res.end(event('<analysis>private</analysis>', 'stop'));
  });
  await assert.rejects(streamCompletion(options), error =>
    error.code === 'EMPTY_RESPONSE' && error.partialText === '');
});

test('stream errors retain visible partial output without hidden reasoning', async t => {
  const options = await fixture(t, (_req, res) => {
    res.end(event('<reasoning>private</reasoning>\nPartial'));
  });
  await assert.rejects(streamCompletion(options), error =>
    error.code === 'INCOMPLETE_RESPONSE' && error.partialText === 'Partial');
});

test('oversized leading whitespace rejects instead of leaving completion pending', async t => {
  const options = await fixture(t, (_req, res) => {
    const chunk = ' '.repeat(64 * 1024);
    for (let index = 0; index < 65; index++) res.write(event(chunk));
    res.end(event('', 'stop'));
  });
  let watchdog;
  const pending = streamCompletion({ ...options, maxRetries: 0, firstTokenMs: 1200, totalMs: 1200 });
  const timed = new Promise((_, reject) => {
    watchdog = setTimeout(() => reject(Object.assign(new Error('Completion remained pending.'), {
      code: 'TEST_TIMEOUT'
    })), 1000);
  });
  try {
    await assert.rejects(Promise.race([pending, timed]), { code: 'RESPONSE_TOO_LARGE' });
  } finally {
    clearTimeout(watchdog);
  }
});

test('each retry attempt starts with a fresh visible-answer filter', async t => {
  let calls = 0;
  const options = await fixture(t, (_req, res) => {
    calls++;
    if (calls === 1) {
      res.write(event('<think>private'));
      setTimeout(() => res.destroy(), 10);
      return;
    }
    res.end(event('Recovered answer', 'stop'));
  });
  const result = await streamCompletion(options);
  assert.equal(result.text, 'Recovered answer');
  assert.equal(calls, 2);
});

for (const [name, body, code, partial] of [
  ['empty', 'data: [DONE]\n\n', 'EMPTY_RESPONSE', ''],
  ['malformed', 'data: {broken}\n\n', 'MALFORMED_RESPONSE', ''],
  ['incomplete', event('Partial'), 'INCOMPLETE_RESPONSE', 'Partial'],
  ['truncated', event('Partial', 'length'), 'INCOMPLETE_RESPONSE', 'Partial'],
  ['provider error', 'data: {"error":{"code":401,"message":"secret key must not leak"}}\n\n', 'AUTH_ERROR', '']
]) {
  test(`${name} stream rejects explicitly and preserves partial output`, async t => {
    let calls = 0;
    const options = await fixture(t, (_req, res) => { calls++; res.end(body); });
    await assert.rejects(streamCompletion(options), error => {
      assert.equal(error.code, code);
      assert.equal(error.partialText, partial);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('retries eligible failures before output only', async t => {
  let calls = 0;
  const options = await fixture(t, (_req, res) => {
    calls++;
    if (calls < 3) { res.writeHead(503); res.end('unavailable'); }
    else res.end(event('Recovered', 'stop'));
  });
  const result = await streamCompletion(options);
  assert.equal(result.text, 'Recovered');
  assert.equal(calls, 3);
});

test('authentication errors are sanitized and never retried', async t => {
  let calls = 0;
  const options = await fixture(t, (_req, res) => { calls++; res.writeHead(401); res.end('Bearer private-credential'); });
  await assert.rejects(streamCompletion(options), error => error.code === 'AUTH_ERROR' && !error.retryable && !error.message.includes('private-credential'));
  assert.equal(calls, 1);
});

test('abort stops the request and retains visible output without retries', async t => {
  let calls = 0;
  const options = await fixture(t, (_req, res) => { calls++; res.write(event('Partial')); });
  const controller = new AbortController();
  await assert.rejects(streamCompletion({ ...options, signal: controller.signal, onDelta: () => controller.abort() }), error => error.code === 'CANCELLED' && error.partialText === 'Partial');
  assert.equal(calls, 1);
});

test('first-token, idle and total deadlines terminate stalled streams', async t => {
  const options = await fixture(t, (_req, res) => { res.writeHead(200); res.flushHeaders(); });
  await assert.rejects(streamCompletion({ ...options, firstTokenMs: 20, totalMs: 200, maxRetries: 0 }), { code: 'FIRST_TOKEN_TIMEOUT' });
  const idle = await fixture(t, (_req, res) => res.write(event('Partial')));
  await assert.rejects(streamCompletion({ ...idle, idleMs: 20, totalMs: 200 }), error => error.code === 'IDLE_TIMEOUT' && error.partialText === 'Partial');
  await assert.rejects(streamCompletion({ ...options, firstTokenMs: 200, totalMs: 20 }), { code: 'TOTAL_TIMEOUT' });
});

test('Gemini completion and safety markers have explicit semantics', () => {
  assert.deepEqual(geminiEvent(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Answer' }, { thought: true, text: 'private reasoning' }] }, finishReason: 'STOP' }] })), { delta: 'Answer', done: true, finishReason: 'STOP' });
  assert.throws(() => geminiEvent('{"promptFeedback":{"blockReason":"SAFETY"}}'), { code: 'CONTENT_BLOCKED' });
  assert.throws(() => geminiEvent('{bad'), { code: 'MALFORMED_RESPONSE' });
});
