'use strict';

/** @typedef {'system'|'microphone'} AudioSource */
/** @typedef {{sessionId:string, source:AudioSource, sequence:number,
 * sampleRate:16000, channels:1, pcm:ArrayBuffer}} AudioFrame */
/** @typedef {{sessionId:string, utteranceId:string, source:AudioSource,
 * text:string, final:boolean, endedAt?:number}} TranscriptEvent */
const CAPTURE_STATES = Object.freeze(['idle', 'starting', 'listening', 'paused', 'recovering', 'error']);
const QUESTION_STATES = Object.freeze(['queued', 'generating', 'completed', 'cancelled', 'error', 'overflow']);
module.exports = { CAPTURE_STATES, QUESTION_STATES };
