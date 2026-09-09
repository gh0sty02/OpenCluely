'use strict';

/** @typedef {'system'|'microphone'} AudioSource */
/** @typedef {{sessionId:string, source:AudioSource, sequence:number,
 * sampleRate:16000, channels:1, pcm:ArrayBuffer}} AudioFrame */
/** @typedef {{sessionId:string, utteranceId:string, source:AudioSource,
 * text:string, final:boolean, endedAt?:number}} TranscriptEvent */
/** @typedef {{captureId:number, utteranceId:string, at:number}} SpeechStartedEvent */
/** @typedef {{captureId:number, utteranceId:string, speechEndedAt:number}} SpeechEndedEvent */
/** @typedef {{captureId:number, utteranceId:string, speechEndedAt:number}} TranscriptionStartedEvent */
/** @typedef {{captureId:number, utteranceId:string, speechEndedAt:number,
 * text:string, errorCode:string|null}} TranscriptionSettledEvent */
const CAPTURE_STATES = Object.freeze(['idle', 'starting', 'listening', 'paused', 'recovering', 'error']);
const QUESTION_STATES = Object.freeze(['queued', 'generating', 'completed', 'cancelled', 'error', 'overflow']);
const TURN_STATES = Object.freeze(['idle', 'speaking', 'transcribing', 'waiting', 'ready']);
module.exports = { CAPTURE_STATES, QUESTION_STATES, TURN_STATES };
