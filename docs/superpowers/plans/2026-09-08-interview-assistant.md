# Reliable Interview Assistant Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task in the current session.
> Steps use checkbox syntax for tracking.

**Goal:** Deliver a polished interview assistant that reliably captures call audio and streams relevant answers across general, system-design, coding, and behavioral questions.

**Architecture:** Extend the existing Electron application with a focused audio-capture module and an interview-session coordinator.
Keep existing speech and LLM adapters while unifying request lifecycle, prompt composition, and UI state.

**Tech Stack:** Existing Electron, CommonJS JavaScript, HTML/CSS, Node test runner, existing speech providers, and configured Gemini or OpenAI-compatible endpoint.

**Spec:** [Interview assistant design](../specs/2026-09-08-interview-assistant-design.md).

**Status:** Proposed plan based on source inspection; application behavior and live-call failures have not yet been runtime-verified.

## Global constraints

- Call audio is the default; microphone capture is optional, as confirmed by the user.
- Windows is the proposed first release target; preserve existing behavior on other platforms.
- Preserve the configured custom endpoint, API key, and model.
- Use the existing selected speech provider; no additional paid provider is required.
- Preserve existing uncommitted changes, including the Mistral integration and pnpm lockfile.
- Do not manually edit generated files or `CHANGELOG.md`.
- Keep application changes focused on this design; do not migrate frontend frameworks.
- Do not log API keys or raw interview content in normal diagnostics.
- Review the spec's acceptance criteria before marking any milestone complete.

## Delivery order

| Milestone | Tasks | Reviewable result |
| --- | --- | --- |
| Reliability baseline | 1 | Reproducible failures and portable local checks. |
| Reliable input | 2-3 | Call audio produces stable finalized questions with recovery. |
| Reliable answers | 4-5 | Questions stream once, survive provider failures, and support all interview categories. |
| Polished experience | 6-7 | Consistent session UI and working setup diagnostics. |
| Release verification | 8 | Measured performance and tested Windows package. |

## Shared contracts

Task 1 introduces a dependency-free `src/interview/contracts.js` containing JSDoc types and exported state constants.
Runtime validation belongs at IPC and provider boundaries.

```js
/** @typedef {'system'|'microphone'} AudioSource */
/** @typedef {'idle'|'starting'|'listening'|'paused'|'recovering'|'error'} CaptureState */
/** @typedef {'transcribing'|'queued'|'generating'|'completed'|'cancelled'|'error'} QuestionState */
/** @typedef {{sessionId:string, source:AudioSource, sequence:number,
 * sampleRate:16000, channels:1, pcm:ArrayBuffer}} AudioFrame */
/** @typedef {{sessionId:string, utteranceId:string, source:AudioSource,
 * text:string, final:boolean, endedAt:number}} TranscriptEvent */
/** @typedef {{sessionId:string, questionId:string, requestId:string,
 * state:QuestionState, delta?:string, errorCode?:string}} AnswerEvent */
```

The coordinator owns `startSession()`, `pause()`, `resume()`, `endSession()`, `clearSession()`, `acceptTranscript(event)`, `answerNow()`, `retry(questionId)`, and `stopAnswer(questionId)`.
`startSession()` returns the new session ID.
The UI observes snapshots and events; it does not independently infer backend state from button text or timers.
One finalized question owns one transcript and multiple explicit answer attempts, with only the active attempt allowed to stream.

## Task 1: Establish regression coverage and portable checks

**Files:** Create `src/interview/contracts.js`, `scripts/start-electron.js`, `scripts/clean.js`, `tests/helpers/fake-provider.js`, and `tests/regressions.test.js`.
Modify `package.json` and the existing lockfile only through the selected package manager if dependencies change.
Inspect `main.js`, `src/services/openrouter.service.js`, and `scripts/test-speech.js`.

- [ ] Record the working-tree baseline without resetting or staging existing application edits.
- [ ] Inspect the installed runtime and lockfiles to select the repository's actual package manager and Node version.
- [ ] Add a portable Node launcher that copies the environment, deletes `ELECTRON_RUN_AS_NODE`, and spawns the installed Electron executable with argument arrays and inherited stdio.
- [ ] Replace the shell-specific clean operation with Node removal of the explicitly resolved repository `dist` directory, guarded against paths outside the repository.
- [ ] Add `test` using `node --test`, and a syntax-check script over tracked application JavaScript; retain the speech diagnostic as a separate integration check.
- [ ] Build a local HTTP fixture server with complete, delayed, empty, malformed, interrupted, 401, 429, and 500 responses.
- [ ] Reproduce immediate buffered-fragment dispatch when a previous answer finishes before the new pause timer expires.
- [ ] Reproduce empty streamed output being treated as success and record the failing cases for Tasks 3-4.

Suggested fixture definition:

```js
const cases = [
  { name: 'empty-success', status: 200, chunks: ['data: [DONE]\n\n'] },
  { name: 'bad-key', status: 401, body: '{"error":{"message":"Invalid key"}}' },
  { name: 'split-frame', status: 200, chunks: [
    'data: {"choices":[{"delta":',
    '{"content":"Hello"}}]}\n\ndata: [DONE]\n\n'
  ] }
];
```

**Verify:** `npm start` launches from native PowerShell; `npm test` runs without credentials or a microphone.
Keep known regression failures explicit until the owning task fixes them; do not hide them with skipped tests.

## Task 2: Implement explicit call-audio capture

**Files:** Create `src/audio/capture.js`, `src/audio/pcm-worklet.js`, and `tests/audio-capture.test.js`.
Modify `src/ui/main-window.js`, `preload.js`, `main.js`, and `src/services/speech.service.js`.

**Interface:** `AudioCapture.start({sessionId, source, deviceId})` returns a promise; `stop()` is idempotent.
The module emits `frame` carrying `AudioFrame`, `level` carrying source and normalized level, and `state` carrying capture state and an optional error code.

- [ ] Verify the installed Electron capture API against local types and official documentation, then test loopback in a small development and packaged-build probe.
- [ ] Confirm the actual capture scope: whole-system or per-application audio, and label the source accurately.
- [ ] Write lifecycle tests using fake media streams: missing audio track, permission denial, double start, repeated stop, track ended, and device disconnect.
- [ ] Implement the validated system capture path and retain microphone capture as an explicit alternative.
- [ ] Replace renderer main-thread sample processing with an AudioWorklet; normalize actual sample rates to 16 kHz mono signed 16-bit PCM.
- [ ] Keep source identity on frames and avoid mixing microphone speech into automatically answered call questions.
- [ ] Add level metering and a no-audio indication that does not confuse normal silence with missing capture permission.
- [ ] Stop all owned media tracks and close audio nodes when paused, ended, or the window closes.
- [ ] Validate trusted IPC sender, active session ID, frame format, and bounded frame size before forwarding audio.

PCM verification example:

```js
// One second of 48 kHz input becomes one second of 16 kHz mono PCM16.
assert.equal(outputPcm.byteLength, 16000 * 2);
assert.equal(frame.sampleRate, 16000);
assert.equal(frame.channels, 1);
```

**Verify:** A locally played spoken fixture transcribes with the microphone disabled.
Failure to obtain system audio produces an actionable source error, never a silent microphone substitution.
If built-in loopback fails the probe, document the failure and revise this task's capture implementation before proceeding.

## Task 3: Make question boundaries and session lifecycle deterministic

**Files:** Create `src/interview/session-controller.js` and `tests/interview-session.test.js`.
Modify `main.js`, `src/services/speech.service.js`, `src/services/whisper-worker.service.js`, and `src/managers/session.manager.js`.

**Interface:** Implement the coordinator methods listed in Shared contracts with injected speech, generation, clock, and ID dependencies.
Emit capture snapshots and `AnswerEvent` updates.

- [ ] Write fake-clock tests for fragmented questions, short follow-ups, duplicate final events, an answer finishing during a new pause, and a question arriving during generation.
- [ ] Route speech start/end and final transcript events through one coordinator; retain pre-roll and existing speech detection initially.
- [ ] Replace the raw string buffer and immediate recursive dispatch with finalized question records and a bounded queue.
- [ ] Deduplicate by utterance identity, never globally by question text.
- [ ] Store the finalized user question once; retain optional microphone transcripts as context without automatically answering them.
- [ ] Implement Answer now, pause/resume, stop answer, End session, and Clear session with the spec's distinct cancellation semantics.
- [ ] Reject late speech and LLM events from old sessions or old generation attempts.
- [ ] Reuse worker warmup, reject all pending requests when the worker exits, and bound restart attempts with visible recovery status.
- [ ] Preserve overflow transcripts for manual submission when three finalized questions are already pending.

Critical regression sequence:

```js
// A is generating; B contains only its first fragment.
// Complete A before B's silence boundary.
assert.equal(generationCalls.length, 1);
// Deliver B's final fragment and advance past its endpointing deadline.
assert.equal(generationCalls.length, 2);
assert.equal(generationCalls[1].text, 'Explain how an LLM is trained');
```

**Verify:** Each finalized utterance creates exactly one question, all queue transitions are visible, and clearing a session prevents all late updates.

## Task 4: Harden provider streaming and recovery

**Files:** Create `src/services/sse-parser.js` and `tests/provider-streaming.test.js`.
Modify `src/services/openrouter.service.js`, `src/services/llm.service.js`, `src/services/llm.factory.js`, `main.js`, and `src/core/config.js`.

**Interface:** `generateAnswer({messages, signal, onDelta})` returns `Promise<{text, finishReason, timing}>` through the selected adapter.
Provider errors carry `code`, `retryable`, and optional `retryAfterMs`; they must not carry credentials to the UI.

- [ ] Test split byte chunks, CRLF framing, multiple events per chunk, Unicode, completion markers, malformed payloads, EOF before completion, and empty output.
- [ ] Implement a bounded SSE parser with buffered event framing and explicit provider-error handling.
- [ ] Pass AbortSignal from the coordinator through both selected provider adapters to the actual request.
- [ ] Implement 15-second first-token, 15-second idle, and 90-second total deadlines with exactly one terminal event.
- [ ] Retry eligible pre-output failures at most twice, within the total deadline and bounded Retry-After.
- [ ] Preserve partial output on interruption; user retry starts a new request ID and replaces the failed attempt coherently.
- [ ] Remove successful-answer presentation of canned error fallbacks from the interview flow.
- [ ] Make configuration changes match the active adapter; prefer switching only while idle, with an explicit pending-change state during an active session.
- [ ] Probe a real minimal model response for Test connection and report endpoint, model, or credential problems separately.

Error expectations:

```js
assert.equal(emptyStreamError.code, 'EMPTY_RESPONSE');
assert.equal(authenticationError.retryable, false);
assert.equal(cancelledRequest.code, 'CANCELLED');
assert.equal(terminalEvents.length, 1);
```

**Verify:** Every fixture ends in completed, cancelled, or error state within its deadline; no fixture leaves a pending spinner or duplicates streamed content.
Retain existing screenshot functionality and explicitly report unsupported image models.

## Task 5: Introduce coherent interview prompts and context

**Files:** Create `prompts/interview.md`, `prompts/general.md`, `prompts/behavioral.md`, `tests/interview-prompts.test.js`, and `tests/fixtures/interview-questions.json`.
Modify `prompt-loader.js`, `main.js`, `src/managers/session.manager.js`, and both LLM adapters.
Adjust existing system-design and coding prompts only where their rules conflict with the new interview flow.

- [ ] Create a 30-question evaluation corpus, including conceptual, system-design, coding, behavioral, and follow-up questions with an answer rubric for each.
- [ ] Add Auto interview as the new default and preserve existing saved specialized modes.
- [ ] Share a single prompt-composition path across speech and text, and apply the same policy to supported screenshot requests.
- [ ] Ask the answer model to select the suitable response structure in the generation request; do not add a classifier round trip.
- [ ] Apply programming-language constraints only to relevant code, never to conceptual prose.
- [ ] Remove contradictory instructions that require brevity and an exhaustive answer at the same time.
- [ ] Bound recent context by the configured input budget with a conservative estimate and headroom; include the current question exactly once.
- [ ] Test missing personal facts so behavioral suggestions never invent the candidate's biography.

Required evaluation fixture:

```json
{
  "question": "How does an LLM work?",
  "followUp": "How is it trained?",
  "mustCover": ["tokens", "embeddings", "attention", "next-token prediction", "training versus inference"],
  "mustAvoid": ["forced C++ solution", "DSA-only refusal", "invented personal experience"]
}
```

**Verify:** Unit tests prove prompt composition and history boundaries; separately score actual model answers against the corpus rubric.
Do not treat keyword matching alone as proof of answer quality.

## Task 6: Polish the session and answer interfaces

**Files:** Modify `index.html`, `chat.html`, `llm-response.html`, `src/styles/common.css`, `src/ui/main-window.js`, `src/ui/chat-window.js`, and `src/managers/window.manager.js`.
Create `src/ui/interview-state.js` and `tests/ui-state.test.js`.

- [ ] Define shared typography, spacing, surfaces, accent, focus, and status tokens in the existing stylesheet.
- [ ] Build the compact session controls, current question display, readable answer area, and collapsible recent-question list described in the spec.
- [ ] Bind rendering to coordinator snapshots and request IDs rather than independent loading flags in each window.
- [ ] Show capture and generation statuses independently, including listening during an in-flight answer.
- [ ] Add transcript editing, Answer now, retry, and stop answer actions using the coordinator contract.
- [ ] Render conceptual and behavioral answers without empty code panels.
- [ ] Batch streaming DOM updates, preserve selection, and stop automatic scrolling when the user scrolls up.
- [ ] Audit the modified Markdown rendering path for unsafe HTML and links; sanitize model content before insertion where required.
- [ ] Test out-of-order events, repeated final events, empty answers, very long questions, and retry replacement without duplicate bubbles.
- [ ] Inspect real Electron screenshots at compact and expanded sizes, keyboard-only navigation, reduced motion, and 100%, 125%, and 150% display scaling.

UI state invariant:

```js
assert.equal(view.captureStatus, 'listening');
assert.equal(view.questionStatus, 'generating');
assert.equal(view.answerCards.filter(card => card.questionId === questionId).length, 1);
```

**Verify:** All states are understandable without opening logs, controls remain visible, and answers are comfortable to read throughout streaming.
Fix visual or test defects found in the touched flows before moving on.

## Task 7: Make setup and diagnostics usable

**Files:** Modify `onboarding.html`, `onboarding.js`, `settings.html`, `src/ui/settings-window.js`, `src/core/first-run.js`, `src/core/config.js`, `src/core/logger.js`, and `env.example`.
Create `tests/settings.test.js`.

- [ ] Organize setup into AI connection, audio setup, and answer preferences with consistent session styling.
- [ ] Preserve endpoint, model, and credential values while distinguishing text-generation settings from speech-provider settings.
- [ ] Add model-request testing, source level testing, a short transcript test, and worker warmup status.
- [ ] Enable session start when required checks pass and retain typed input when audio is unavailable.
- [ ] Persist source and interview mode in the existing user-data configuration path with validated values and backward-compatible defaults.
- [ ] Display whether a setting applies immediately, after the session ends, or after restart.
- [ ] Provide inline recovery actions for denied permissions, missing local transcription dependencies, invalid keys, model errors, and absent audio tracks.
- [ ] Replace raw transcript or credential logging in touched paths with stage timings, identifiers, and sanitized error codes.
- [ ] Test settings round trips, existing-config migration, invalid fields, and credentials being absent from diagnostics.

Diagnostic record shape:

```js
const diagnostic = {
  sessionId, questionId, requestId,
  stage: 'generation', durationMs: 1200, errorCode: null
};
```

**Verify:** A fresh profile can configure the existing provider, hear call audio, see a transcript, and receive an answer without editing `.env` manually.

## Task 8: Validate the complete interview flow and package

**Files:** Create `tests/interview-flow.test.js`, `tests/fixtures/audio/README.md`, and `docs/testing/interview-acceptance.md`.
Modify `README.md` and packaging configuration only for verified setup or distribution requirements.

- [ ] Add fixture-driven integration tests across capture events, transcription, queueing, provider streaming, and UI state.
- [ ] Use locally recorded or synthetic interview audio with fixture provenance; do not commit personal interview recordings.
- [ ] Run `npm test`, the syntax check, and `npm run test-speech` with the configured environment.
- [ ] Run the 30-question corpus with the chosen model and score relevance, correctness, concise opening, and follow-up continuity.
- [ ] Run a 30-minute Windows call-audio session with microphone disabled, then exercise optional microphone, pause/resume, device changes, long speech, network loss, and retry.
- [ ] Measure p50 and p95 for transcription, dispatch, first token, and total answer time; document hardware, provider, model, sample counts, and cold versus warm worker state.
- [ ] Verify p95 dispatch below 200 ms after finalization, UI feedback within 100 ms, and the 5-second first-answer target under the documented test conditions.
- [ ] Run `npm run build:win` and test installation from a clean profile without project `.env`, development Python, or development assets.
- [ ] Check required prompt files, audio worklet, styles, and worker resources are packaged; generate assets through their build tooling.
- [ ] Record observed limitations and recovery behavior, then update setup documentation to match the actual implementation.

**Release gate:** All deterministic checks pass; no duplicate answer, stale-session update, lost finalized question, uncaught crash, or permanently stuck loading state occurs in the acceptance run.
Performance or answer-quality misses must be reported and addressed before describing the flow as seamless.

## Review checklist

- [ ] Call audio is confirmed in a real Windows package, with no microphone substitution.
- [ ] A general LLM question and contextual follow-up work in default mode.
- [ ] Coding, system design, and behavioral questions each use the appropriate answer structure.
- [ ] Cancellation and recovery preserve the question and keep the UI usable.
- [ ] Setup, session view, chat, and overlay share consistent visual treatment.
- [ ] Existing working-tree changes and custom-provider configuration remain intact.
- [ ] Every completion claim is backed by a recorded check or clearly scoped manual observation.
