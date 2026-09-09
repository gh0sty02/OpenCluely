'use strict';

const { StringDecoder } = require('node:string_decoder');
const VisibleAnswerFilter = require('./visible-answer-filter');

function providerError(code, message, retryable = false, extra = {}) {
  return Object.assign(new Error(message), { code, retryable, ...extra });
}

function httpError(status, retryAfter) {
  const code = status === 401 || status === 403 ? 'AUTH_ERROR'
    : status === 402 ? 'CREDITS_ERROR' : status === 404 ? 'MODEL_ERROR'
      : status === 429 ? 'RATE_LIMIT_ERROR' : 'PROVIDER_ERROR';
  const descriptions = { AUTH_ERROR: 'Check the API key and its permissions.', CREDITS_ERROR: 'Check the provider account balance.', MODEL_ERROR: 'Check the configured endpoint and model.', RATE_LIMIT_ERROR: 'The provider rate limit was reached.' };
  const error = providerError(code, descriptions[code] || `The provider rejected the request (HTTP ${status}).`, status === 429 || status >= 500);
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay)) error.retryAfterMs = Math.min(5000, Math.max(0, delay));
  }
  return error;
}

class SSEParser {
  constructor(onEvent, { maxEventBytes = 256 * 1024 } = {}) {
    this.onEvent = onEvent;
    this.maxEventBytes = maxEventBytes;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.data = [];
    this.eventBytes = 0;
  }

  push(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.line(line);
    }
    this.checkSize(Buffer.byteLength(this.buffer));
  }

  checkSize(pending = 0) {
    if (this.eventBytes + pending > this.maxEventBytes) throw providerError('MALFORMED_RESPONSE', 'The provider sent an oversized stream event.');
  }

  line(line) {
    if (!line) {
      const data = this.data.join('\n');
      this.data = [];
      this.eventBytes = 0;
      if (data) this.onEvent(data);
      return;
    }
    this.eventBytes += Buffer.byteLength(line);
    this.checkSize();
    if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
  }

  end() {
    this.buffer += this.decoder.end();
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ''));
    this.buffer = '';
    this.line('');
  }
}

function parseJSON(payload) {
  let json;
  try { json = JSON.parse(payload); }
  catch (_) { throw providerError('MALFORMED_RESPONSE', 'The provider sent malformed stream data.'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw providerError('MALFORMED_RESPONSE', 'The provider sent an invalid stream event.');
  if (json.error) throw httpError(Number(json.error.code || json.error.status) || 500);
  return json;
}

function openAIEvent(payload) {
  if (payload.trim() === '[DONE]') return { done: true, finishReason: 'stop' };
  const json = parseJSON(payload);
  const choice = json.choices?.[0];
  if (!choice) {
    if (Array.isArray(json.choices) && json.choices.length === 0 && json.usage) return {};
    throw providerError('MALFORMED_RESPONSE', 'The provider stream contained no answer choice.');
  }
  const delta = choice.delta?.content;
  if (delta != null && typeof delta !== 'string') throw providerError('MALFORMED_RESPONSE', 'The model returned unsupported answer content.');
  return { delta: delta || '', done: Boolean(choice.finish_reason), finishReason: choice.finish_reason };
}

function geminiEvent(payload) {
  const json = parseJSON(payload);
  if (json.promptFeedback?.blockReason) throw providerError('CONTENT_BLOCKED', 'The provider blocked this request.');
  const candidate = json.candidates?.[0];
  if (!candidate) {
    if (json.usageMetadata) return {};
    throw providerError('MALFORMED_RESPONSE', 'The provider stream contained no answer candidate.');
  }
  const parts = candidate.content?.parts || [];
  const delta = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
  return { delta, done: Boolean(candidate.finishReason), finishReason: candidate.finishReason };
}

function streamAttempt(options, remainingMs, reportDelta) {
  const { transport, requestOptions, body, parseEvent, signal, firstTokenMs = 15000, idleMs = 15000 } = options;
  return new Promise((resolve, reject) => {
    let request, response, terminal = false, text = '', firstToken = null, idleTimer;
    const visibleAnswer = new VisibleAnswerFilter();
    const started = Date.now();
    const totalTimer = setTimeout(() => finish(providerError('TOTAL_TIMEOUT', 'The answer exceeded its total time limit.')), remainingMs);
    const firstTimer = setTimeout(() => finish(providerError('FIRST_TOKEN_TIMEOUT', 'The provider did not start an answer in time.', true)), firstTokenMs);
    const abort = () => finish(providerError('CANCELLED', 'Answer stopped.'));

    function finish(error, finishReason) {
      if (terminal) return;
      terminal = true;
      try {
        appendVisible(visibleAnswer.finish());
      } catch (flushError) {
        error = flushError.code ? flushError : providerError('MALFORMED_RESPONSE', 'The provider stream could not be processed.');
      }
      clearTimeout(totalTimer);
      clearTimeout(firstTimer);
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', abort);
      response?.destroy();
      request?.destroy();
      if (!error && !text.trim()) error = providerError('EMPTY_RESPONSE', 'The provider returned no answer.');
      if (error) {
        error.partialText = text;
        if (text) error.retryable = false;
        reject(error);
      } else resolve({ text: text.trim(), finishReason, timing: { firstTokenMs: firstToken == null ? null : firstToken - started, totalMs: Date.now() - started } });
    }

    function appendVisible(delta) {
      if (!delta) return;
      text += delta;
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw providerError('RESPONSE_TOO_LARGE', 'The provider answer exceeded the supported size.');
      if (firstToken == null) firstToken = Date.now();
      clearTimeout(firstTimer);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(providerError('IDLE_TIMEOUT', 'The provider stopped sending the answer.')), idleMs);
      reportDelta(delta);
    }

    const parser = new SSEParser(payload => {
      if (terminal) return;
      const event = parseEvent(payload);
      if (event.delta) appendVisible(visibleAnswer.push(event.delta));
      if (terminal || !event.done) return;
      const reason = event.finishReason;
      if (!['stop', 'STOP', 'end_turn'].includes(reason)) {
        const blocked = ['content_filter', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(reason);
        finish(providerError(blocked ? 'CONTENT_BLOCKED' : 'INCOMPLETE_RESPONSE', blocked ? 'The provider blocked the answer.' : 'The provider stopped before completing the answer.'));
      } else finish(null, reason);
    });

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      request = transport.request(requestOptions, res => {
        response = res;
        if (terminal) { res.destroy(); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(httpError(res.statusCode, res.headers['retry-after']));
          return;
        }
        res.on('data', chunk => {
          if (terminal) return;
          try { parser.push(chunk); }
          catch (error) { finish(error.code ? error : providerError('MALFORMED_RESPONSE', 'The provider stream could not be processed.')); }
        });
        res.on('end', () => {
          if (terminal) return;
          try { parser.end(); }
          catch (error) { finish(error); }
          if (!terminal) finish(providerError('INCOMPLETE_RESPONSE', 'The provider connection ended before completion.'));
        });
        res.on('error', () => finish(providerError('NETWORK_ERROR', 'The provider connection was interrupted.', true)));
        res.on('aborted', () => finish(providerError('INCOMPLETE_RESPONSE', 'The provider connection ended before completion.', true)));
        res.on('close', () => { if (!terminal) finish(providerError('INCOMPLETE_RESPONSE', 'The provider connection closed before completion.', true)); });
      });
      request.on('error', () => finish(providerError('NETWORK_ERROR', 'Cannot reach the configured provider.', true)));
      request.end(body);
    } catch (_) { finish(providerError('NETWORK_ERROR', 'Cannot reach the configured provider.', true)); }
  });
}

function retryDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(providerError('CANCELLED', 'Answer stopped.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function streamCompletion(options) {
  const started = Date.now();
  const totalMs = options.totalMs ?? 90000;
  const maxRetries = Math.min(2, Math.max(0, options.maxRetries ?? 2));
  let emitted = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) throw providerError('CANCELLED', 'Answer stopped.', false, { partialText: '' });
    const remaining = totalMs - (Date.now() - started);
    if (remaining <= 0) throw providerError('TOTAL_TIMEOUT', 'The answer exceeded its total time limit.', false, { partialText: '' });
    try {
      const result = await streamAttempt(options, remaining, delta => { emitted = true; options.onDelta?.(delta); });
      result.timing.firstTokenMs += Date.now() - started - result.timing.totalMs;
      result.timing.totalMs = Date.now() - started;
      result.timing.attempts = attempt + 1;
      return result;
    } catch (error) {
      if (emitted || !error.retryable || attempt === maxRetries) throw error;
      const delay = error.retryAfterMs ?? (options.retryDelayMs ?? 250) * (attempt + 1);
      if (Date.now() - started + delay >= totalMs) throw providerError('TOTAL_TIMEOUT', 'The answer exceeded its total time limit.', false, { partialText: '' });
      await retryDelay(delay, options.signal);
    }
  }
}

module.exports = { SSEParser, streamCompletion, openAIEvent, geminiEvent, providerError, httpError };
