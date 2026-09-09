'use strict';

// Named presets (Responsive/Balanced/Patient) offered by the settings UI's
// auto-answer silence dropdown — a UI-scoping concern only, kept separate
// from what an explicit AUTO_ANSWER_SILENCE_MS in .env is allowed to be.
// See getAutoAnswerSilenceMs() below.
const AUTO_ANSWER_SILENCE_PRESETS = new Set([2500, 3000, 4500]);
const AUTO_ANSWER_SILENCE_MIN_MS = 1000;
const AUTO_ANSWER_SILENCE_MAX_MS = 10000;
const AUTO_ANSWER_SILENCE_DEFAULT_MS = 3000;

function getAutoAnswerDefault(env = process.env) {
  return env.AUTO_ANSWER === undefined ? true : env.AUTO_ANSWER === 'true';
}

/**
 * Plan spec: `Number(process.env.AUTO_ANSWER_SILENCE_MS) || 3000` — any
 * positive value the user explicitly configured in .env is honored, not
 * silently collapsed to 3000 just because it doesn't match one of the three
 * named settings-UI presets (e.g. a hand-edited `AUTO_ANSWER_SILENCE_MS=2000`).
 * Clamped to a sane range so an accidental value (too large, zero, negative,
 * non-numeric) can't produce a silence window that never fires or fires
 * instantly.
 */
function getAutoAnswerSilenceMs(env = process.env) {
  const configured = Number(env.AUTO_ANSWER_SILENCE_MS);
  if (!Number.isFinite(configured) || configured <= 0) return AUTO_ANSWER_SILENCE_DEFAULT_MS;
  return Math.min(AUTO_ANSWER_SILENCE_MAX_MS, Math.max(AUTO_ANSWER_SILENCE_MIN_MS, configured));
}

/**
 * Coerce a value coming from the settings UI's auto-answer silence dropdown.
 * Unlike getAutoAnswerSilenceMs() above, only the three named presets are
 * valid here — this is a narrower, UI-only constraint and must not be
 * applied to an explicit env value.
 */
function coerceAutoAnswerPreset(value) {
  const n = Number(value);
  return AUTO_ANSWER_SILENCE_PRESETS.has(n) ? n : AUTO_ANSWER_SILENCE_DEFAULT_MS;
}

module.exports = {
  AUTO_ANSWER_SILENCE_PRESETS,
  AUTO_ANSWER_SILENCE_MIN_MS,
  AUTO_ANSWER_SILENCE_MAX_MS,
  AUTO_ANSWER_SILENCE_DEFAULT_MS,
  getAutoAnswerDefault,
  getAutoAnswerSilenceMs,
  coerceAutoAnswerPreset
};
