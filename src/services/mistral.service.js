/**
 * Mistral Voxtral Speech Service
 * Audio transcription via https://api.mistral.ai/v1/audio/transcriptions
 * (OpenAI-compatible multipart/form-data endpoint). Zero new npm deps —
 * raw `https` + a hand-rolled multipart body, mirroring openrouter.service.js.
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('MISTRAL');
const config = require('../core/config');

const MISTRAL_HOST = 'api.mistral.ai';
const TRANSCRIPTIONS_PATH = '/v1/audio/transcriptions';
const MODELS_PATH = '/v1/models';

function getApiKey(override) {
  const key = override || config.getApiKey('MISTRAL');
  if (!key || key === 'your_mistral_api_key_here') {
    return null;
  }
  return key;
}

/**
 * Build a multipart/form-data body from a set of string fields plus one
 * file field. Returns { body: Buffer, contentType: string }.
 */
function buildMultipartBody(fields, fileField) {
  const boundary = `----OpenCluelyMistral${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }

  const filename = path.basename(fileField.path);
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${filename}"\r\n` +
    `Content-Type: ${fileField.contentType || 'audio/wav'}\r\n\r\n`
  ));
  parts.push(fileField.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

/**
 * Transcribe an audio file with Mistral Voxtral. Same contract as
 * speech.service.js's _transcribeWhisperFile: takes a file path, returns
 * the transcribed text string.
 */
async function transcribeFile(audioFilePath, options = {}) {
  const apiKey = getApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY not configured');
  }

  const model = options.model || config.get('speech.mistral.model') || 'voxtral-mini-latest';
  const timeout = options.timeoutMs || config.get('speech.mistral.timeout') || 30000;
  const language = options.language || config.get('speech.mistral.language') || 'auto';

  const audioBuffer = fs.readFileSync(audioFilePath);
  const fields = { model };
  if (language && language !== 'auto' && language !== 'detect') {
    fields.language = language;
  }

  const { body, contentType } = buildMultipartBody(fields, {
    name: 'file',
    path: audioFilePath,
    buffer: audioBuffer,
    contentType: 'audio/wav'
  });

  const options_ = {
    hostname: MISTRAL_HOST,
    path: TRANSCRIPTIONS_PATH,
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': body.length
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options_, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) {
          let errMsg = `HTTP ${res.statusCode}`;
          try {
            const parsed = JSON.parse(data);
            errMsg = parsed.message || (parsed.error && parsed.error.message) || `${errMsg}: ${data}`;
          } catch (_) {
            errMsg = `${errMsg}: ${data.substring(0, 300)}`;
          }
          reject(new Error(errMsg));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(typeof parsed.text === 'string' ? parsed.text : '');
        } catch (e) {
          reject(new Error(`Failed to parse Mistral response: ${e.message}`));
        }
      });
      res.on('error', (err) => { clearTimeout(timer); reject(new Error(`Response error: ${err.message}`)); });
    });

    const timer = setTimeout(() => { req.destroy(); reject(new Error('Mistral transcription request timed out')); }, timeout);
    req.on('error', (err) => { clearTimeout(timer); reject(new Error(`Request failed: ${err.message}`)); });
    req.write(body);
    req.end();
  });
}

/**
 * Verify the configured API key works via a lightweight GET /v1/models call.
 */
async function testConnection(apiKeyOverride) {
  const apiKey = getApiKey(apiKeyOverride);
  if (!apiKey) {
    return { success: false, message: 'MISTRAL_API_KEY not configured' };
  }

  const startTime = Date.now();
  return new Promise((resolve) => {
    const req = https.request({
      hostname: MISTRAL_HOST,
      path: MODELS_PATH,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        const latency = Date.now() - startTime;
        if (res.statusCode === 200) {
          logger.info('Mistral connection test successful', { latency });
          resolve({ success: true, message: 'Mistral API key valid', latency });
        } else {
          resolve({ success: false, message: `HTTP ${res.statusCode}: ${data.substring(0, 200)}` });
        }
      });
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ success: false, message: 'Mistral connection test timed out' }); }, 10000);
    req.on('error', (err) => { clearTimeout(timer); resolve({ success: false, message: err.message }); });
    req.end();
  });
}

module.exports = { transcribeFile, testConnection, getApiKey };
