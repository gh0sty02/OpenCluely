const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AUTO_ANSWER_SILENCE_PRESETS,
  AUTO_ANSWER_SILENCE_MIN_MS,
  AUTO_ANSWER_SILENCE_MAX_MS,
  AUTO_ANSWER_SILENCE_DEFAULT_MS,
  getAutoAnswerDefault,
  getAutoAnswerSilenceMs,
  coerceAutoAnswerPreset,
} = require('../src/core/auto-answer-config');

test('getAutoAnswerSilenceMs honors an explicit non-preset env value', () => {
  // Regression: an explicit AUTO_ANSWER_SILENCE_MS=2000 must not be
  // silently collapsed to the 3000 default just because 2000 isn't one of
  // the three settings-UI presets (2500/3000/4500).
  assert.equal(getAutoAnswerSilenceMs({ AUTO_ANSWER_SILENCE_MS: '2000' }), 2000);
  assert.ok(!AUTO_ANSWER_SILENCE_PRESETS.has(2000), 'sanity: 2000 is not a preset');
});

test('getAutoAnswerSilenceMs honors any positive explicit value, not just presets', () => {
  assert.equal(getAutoAnswerSilenceMs({ AUTO_ANSWER_SILENCE_MS: '1750' }), 1750);
  assert.equal(getAutoAnswerSilenceMs({ AUTO_ANSWER_SILENCE_MS: '5000' }), 5000);
});

test('getAutoAnswerSilenceMs falls back to the default when unset', () => {
  assert.equal(getAutoAnswerSilenceMs({}), AUTO_ANSWER_SILENCE_DEFAULT_MS);
});

test('getAutoAnswerSilenceMs falls back to the default for invalid values', () => {
  assert.equal(getAutoAnswerSilenceMs({ AUTO_ANSWER_SILENCE_MS: 'not-a-number' }), AUTO_ANSWER_SILENCE_DEFAULT_MS);
  assert.equal(getAutoAnswerSilenceMs({ AUTO_ANSWER_SILENCE_MS: '0' }), AUTO_ANSWER_SILENCE_DEFAULT_MS);
  assert.equal(getAutoAnswerSilenceMs({ AUTO_ANSWER_SILENCE_MS: '-500' }), AUTO_ANSWER_SILENCE_DEFAULT_MS);
});

test('getAutoAnswerSilenceMs clamps out-of-range explicit values to a sane bound', () => {
  assert.equal(getAutoAnswerSilenceMs({ AUTO_ANSWER_SILENCE_MS: '50' }), AUTO_ANSWER_SILENCE_MIN_MS);
  assert.equal(getAutoAnswerSilenceMs({ AUTO_ANSWER_SILENCE_MS: '999999' }), AUTO_ANSWER_SILENCE_MAX_MS);
});

test('getAutoAnswerDefault reflects AUTO_ANSWER, defaulting to true when unset', () => {
  assert.equal(getAutoAnswerDefault({}), true);
  assert.equal(getAutoAnswerDefault({ AUTO_ANSWER: 'true' }), true);
  assert.equal(getAutoAnswerDefault({ AUTO_ANSWER: 'false' }), false);
});

test('coerceAutoAnswerPreset only accepts the three named settings-UI presets', () => {
  assert.equal(coerceAutoAnswerPreset(2500), 2500);
  assert.equal(coerceAutoAnswerPreset(3000), 3000);
  assert.equal(coerceAutoAnswerPreset(4500), 4500);
  // Unlike getAutoAnswerSilenceMs, this is the narrower UI-only constraint:
  // a non-preset value falls back to the default rather than being honored.
  assert.equal(coerceAutoAnswerPreset(2000), AUTO_ANSWER_SILENCE_DEFAULT_MS);
  assert.equal(coerceAutoAnswerPreset('garbage'), AUTO_ANSWER_SILENCE_DEFAULT_MS);
});
