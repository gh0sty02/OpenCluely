# Turn Detection and Visible Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably combine speech separated by natural two-second pauses, automatically submit a complete interview question with controlled latency, and prevent model reasoning tags from appearing in answers or session history.

**Architecture:** Keep the current short VAD segments for responsive transcription, but move question completion into an acoustic turn detector that tracks active speech, the latest speech boundary, and pending transcription work.
Route every streamed answer through one stateful visible-answer filter before updating session state, history, or UI.
Add content-free stage timing so latency can be tuned using measurements.

**Tech Stack:** Electron 29, CommonJS JavaScript, Web Audio API, existing speech adapters, the existing SSE pipeline, and Node's built-in test runner.

**Spec:** [Reliable Interview Assistant Design](../specs/2026-09-08-interview-assistant-design.md).

## Global Constraints

- System audio remains the default source on Windows, with microphone capture optional.
- Automatic answering becomes the default when `AUTO_ANSWER` is absent.
- The default end-of-turn silence window is 3000 ms so a two-second interviewer pause remains part of one question.
- The 700 ms VAD silence hangover remains a transcription segmentation boundary, not a question boundary.
- Manual mode and Answer now remain available.
- Microphone transcripts do not auto-submit.
- Keep the configured custom endpoint, API key, model, and selected speech provider.
- Never store or log hidden model reasoning, credentials, or raw interview text in diagnostic records.
- Preserve specialized interview modes and current session queue behavior.
- Do not add another model request solely to decide whether a question is complete.
- Use `npm.cmd` for package scripts in PowerShell.
- Do not use em dashes in new copy or comments.

---

## File and Interface Map

| File | Responsibility after this milestone |
| --- | --- |
| `src/interview/turn-detector.js` | Own acoustic activity, transcription drain state, and the end-of-turn deadline. |
| `src/interview/session-controller.js` | Own transcript text, questions, answer attempts, and queueing. |
| `src/services/speech.service.js` | Emit capture-scoped utterance lifecycle events around transcription. |
| `src/services/visible-answer-filter.js` | Remove leading hidden-reasoning blocks across arbitrary stream chunks. |
| `src/services/sse-parser.js` | Feed only visible deltas to consumers and retain visible partial output on errors. |
| `src/services/openrouter.service.js` | Ignore OpenAI-compatible reasoning fields and use shared streaming. |
| `src/services/llm.service.js` | Ignore Gemini thought parts and use shared streaming. |
| `src/interview/latency-metrics.js` | Record bounded, content-free timing samples. |
| `main.js` | Translate speech events into coordinator calls and remove old coalescing. |
| `src/ui/interview-panel.js` | Show listening, transcription, waiting, and answer states. |
| `src/ui/interview-state.js` | Derive stable labels and actions from snapshots. |

The speech service produces these events:

```js
/** @typedef {{captureId:number, utteranceId:string, at:number}} SpeechStartedEvent */
/** @typedef {{captureId:number, utteranceId:string, speechEndedAt:number}} SpeechEndedEvent */
/** @typedef {{captureId:number, utteranceId:string, speechEndedAt:number}} TranscriptionStartedEvent */
/** @typedef {{captureId:number, utteranceId:string, speechEndedAt:number,
 * text:string, errorCode:string|null}} TranscriptionSettledEvent */
```

The turn detector exposes this contract:

```js
class TurnDetector extends EventEmitter {
  constructor({ silenceMs, now, setTimer, clearTimer });
  begin({ sessionId, captureId });
  noteSpeechStarted(event);
  noteSpeechEnded(event);
  noteTranscriptionStarted(event);
  noteTranscriptionSettled(event);
  forceReady();
  cancel();
  snapshot();
}
```

`TurnDetector` emits `ready` once only when speech is inactive, the latest acoustic speech end is at least `silenceMs` in the past, no transcription remains pending, and session and capture identities still match.

The interview snapshot adds:

```js
{
  turnState: 'idle' | 'speaking' | 'transcribing' | 'waiting' | 'ready',
  turnDeadlineAt: number | null,
  pendingTranscriptions: number,
  hasVisibleAnswer: boolean
}
```

---

## Red Phase for Task 1: Lock Down Turn-Boundary Failures

**Files:**

- Create: `tests/turn-detector.test.js`
- Modify: `tests/interview-session.test.js`
- Modify: `tests/audio-speech.test.js`

**Interfaces:**

- Consumes: Existing injected timers, session controller, and speech events.
- Produces: Failing tests for the timing race and drain barrier.

- [ ] **Step 1: Add a deadline-aware fake clock**

```js
function createClock(start = 0) {
  let now = start;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, delay) {
      const id = ++sequence;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      let due;
      do {
        due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at);
        due.forEach(([id, timer]) => {
          timers.delete(id);
          timer.fn();
        });
      } while (due.length);
    }
  };
}
```

- [ ] **Step 2: Reproduce speech resuming before the earlier transcript arrives**

```js
detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
detector.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
clock.advance(2200);
detector.noteSpeechStarted({ captureId: 7, utteranceId: 'u2', at: 3200 });
detector.noteTranscriptionSettled({ captureId: 7, utteranceId: 'u1', speechEndedAt: 1000 });
clock.advance(5000);
assert.equal(readyEvents.length, 0);
```

- [ ] **Step 3: Reproduce a silence deadline firing while a final transcript is pending**

```js
detector.noteSpeechEnded({ captureId: 7, utteranceId: 'u2', speechEndedAt: 5000 });
detector.noteTranscriptionStarted({ captureId: 7, utteranceId: 'u2', speechEndedAt: 5000 });
clock.advance(3000);
assert.equal(readyEvents.length, 0);
detector.noteTranscriptionSettled({ captureId: 7, utteranceId: 'u2', speechEndedAt: 5000 });
assert.equal(readyEvents.length, 1);
```

- [ ] **Step 4: Define the two-second-pause acceptance case**

```js
settleTranscript('Explain how transformers work', 'u1', 1000);
clock.advance(2000);
startSpeech('u2');
settleTranscript('and how they are trained', 'u2', 4500);
clock.advance(2999);
assert.equal(generationCalls.length, 0);
clock.advance(1);
assert.equal(generationCalls[0].question.text,
  'Explain how transformers work and how they are trained');
```

- [ ] **Step 5: Cover stale capture, duplicate lifecycle, failed transcription, manual Answer now, and microphone behavior**

Each stale or duplicate event must leave the current timer, draft, and pending count unchanged.
A failed transcription must release its pending identity without appending text.
Answer now must submit immediately even while the automatic deadline is pending.

- [ ] **Step 6: Verify that the new tests fail for the intended missing behavior**

Run: `node --test tests/turn-detector.test.js tests/interview-session.test.js tests/audio-speech.test.js`

Expected: The new tests fail because the acoustic detector and transcription barrier do not exist.

- [ ] **Step 7: Continue directly to Task 1 without committing failing tests**

Keep the verified failures in the working tree so the detector implementation completes the same red-green delivery unit.

---

### Task 1: Implement Acoustic Turn Detection

**Files:**

- Create: `src/interview/turn-detector.js`
- Modify: `src/interview/contracts.js`
- Test: `tests/turn-detector.test.js`

**Interfaces:**

- Consumes: Capture-scoped speech and transcription lifecycle events.
- Produces: The `TurnDetector` contract from the File and Interface Map.

- [ ] **Step 1: Implement `begin()` and `cancel()` so every capture receives isolated state**

Reset the active speaker flag, last speech timestamps, pending identity set, deadline, timer, and emitted-ready flag.
Reject events with a different capture ID or missing finite timestamps.

- [ ] **Step 2: Record speech start even if no timer exists**

```js
noteSpeechStarted(event) {
  if (!this._matches(event)) return;
  this.speakerActive = true;
  this.readyEmitted = false;
  this._clearDeadline();
  this.emit('state', this.snapshot());
}
```

- [ ] **Step 3: Record the newest acoustic speech end**

```js
noteSpeechEnded(event) {
  if (!this._matches(event)) return;
  this.speakerActive = false;
  this.lastSpeechEndedAt = Math.max(this.lastSpeechEndedAt || 0, event.speechEndedAt);
  this._scheduleIfEligible();
}
```

- [ ] **Step 4: Track transcription work by utterance identity**

`noteTranscriptionStarted()` adds one valid utterance ID and clears the deadline.
`noteTranscriptionSettled()` deletes that identity and reschedules only when the speaker is inactive.
Cap the pending set at 100 identities and emit `TRANSCRIPTION_BACKLOG` when the cap is reached.

- [ ] **Step 5: Schedule from the latest acoustic boundary**

```js
_scheduleIfEligible() {
  this._clearDeadline();
  if (this.speakerActive || this.pending.size || this.lastSpeechEndedAt === null) return;
  this.deadlineAt = this.lastSpeechEndedAt + this.silenceMs;
  const delay = Math.max(0, this.deadlineAt - this.now());
  this.timer = this.setTimer(() => this._tryReady(), delay);
  this.emit('state', this.snapshot());
}
```

- [ ] **Step 6: Recheck all invariants when the timer fires**

Emit one `ready` event only when the detector is still inactive, drained, current, and past the stored deadline.
Include `sessionId`, `captureId`, and `speechEndedAt` in the ready event.

- [ ] **Step 7: Run the detector tests**

Run: `node --test tests/turn-detector.test.js`

Expected: One ready event is emitted for each completed turn and no stale event releases a turn.

- [ ] **Step 8: Commit the detector**

```bash
git add src/interview/turn-detector.js src/interview/contracts.js tests/turn-detector.test.js
git commit -m "feat(audio): detect complete interview turns"
```

---

### Task 2: Emit a Complete Speech Lifecycle

**Files:**

- Modify: `src/services/speech.service.js`
- Modify: `src/services/whisper-worker.service.js`
- Modify: `src/services/mistral.service.js`
- Test: `tests/audio-speech.test.js`

**Interfaces:**

- Consumes: Existing VAD state, capture IDs, utterance sequence, and speech adapters.
- Produces: Exactly one transcription start and settlement for every utterance.

- [ ] **Step 1: Assign identity before transcription begins**

```js
const lifecycle = {
  captureId: this.captureId,
  utteranceId: `${this.captureId}:${++this.utteranceSequence}`,
  speechEndedAt: Date.now()
};
```

- [ ] **Step 2: Emit `speech-started` only when VAD changes from silence to speech**

Repeated voiced frames during one utterance must not emit additional starts.
Use the current capture ID and current clock time.

- [ ] **Step 3: Emit `speech-ended` and `transcription-started` before queueing work**

Attach the same immutable lifecycle object to the queued audio item.
Do not recalculate `speechEndedAt` after transcription completes.

- [ ] **Step 4: Emit `transcription-settled` in `finally`**

```js
try {
  const text = await this._transcribeBuffer(item.audioBuffer);
  if (this.captureId === item.captureId && text.trim()) {
    this.emit('transcription', text.trim(), item);
  }
  settled.text = text.trim();
} catch (error) {
  settled.errorCode = this._speechErrorCode(error);
  this.emit('error', this._safeSpeechMessage(error));
} finally {
  this.emit('transcription-settled', settled);
}
```

- [ ] **Step 5: Give Azure final recognition the same event order**

Emit speech end, transcription start, final transcript, and transcription settlement for one generated utterance identity.
Keep renderer PCM routing unchanged.

- [ ] **Step 6: Settle cancelled work without transcript text**

`stopRecording({ cancel: true })` and immediate restart settle invalidated work with `errorCode: 'CANCELLED'`.
They must never emit transcript text from an older capture.

- [ ] **Step 7: Replace active use of the ambiguous `speech-activity` event**

Keep a compatibility emission only if repository search finds a remaining consumer after `main.js` is migrated.

- [ ] **Step 8: Run speech tests**

Run: `node --test tests/audio-speech.test.js tests/audio-capture.test.js`

Expected: Every queued segment settles once and stale captures remain silent.

- [ ] **Step 9: Commit the lifecycle**

```bash
git add src/services/speech.service.js src/services/whisper-worker.service.js src/services/mistral.service.js tests/audio-speech.test.js
git commit -m "fix(speech): expose utterance drain lifecycle"
```

---

### Task 3: Integrate Automatic Turn Submission

**Files:**

- Modify: `src/interview/session-controller.js`
- Modify: `main.js`
- Modify: `env.example`
- Modify: `settings.html`
- Modify: `src/ui/settings-window.js`
- Test: `tests/interview-session.test.js`
- Test: `tests/turn-detector.test.js`

**Interfaces:**

- Consumes: `TurnDetector`, the four speech lifecycle events, existing interview actions, and snapshot broadcasting.
- Produces: One automatic question after 3000 ms of drained acoustic silence.

- [ ] **Step 1: Inject one detector into `SessionController` and forward detector snapshots**

The controller creates the detector with the same injected clock and timers used by its tests.
The controller maps detector state to `turnState`, `turnDeadlineAt`, and `pendingTranscriptions`.

- [ ] **Step 2: Remove timer ownership from `acceptTranscript()`**

`acceptTranscript()` validates identity, filters noise, appends text, and publishes state.
It must not calculate elapsed silence or schedule generation.

- [ ] **Step 3: Commit a matching non-empty draft when the detector emits ready**

```js
_commitReadyTurn(event) {
  if (!this.autoAnswer || this.source === 'microphone') return;
  if (event.sessionId !== this.sessionId || !this.draft.trim()) return;
  this.answerNow();
}
```

- [ ] **Step 4: Preserve manual actions**

Pause and Answer now cancel the detector deadline and submit immediately.
Clear and End cancel the detector and invalidate every late event.

- [ ] **Step 5: Wire all lifecycle events in `main.js`**

Map speech capture IDs to the interview session captured when recording started.
Forward only events whose capture ID matches the active interview capture.

- [ ] **Step 6: Make automatic mode and 3000 ms the missing-value defaults**

```js
const autoAnswer = process.env.AUTO_ANSWER === undefined
  ? true
  : process.env.AUTO_ANSWER === 'true';
const silenceMs = Number(process.env.AUTO_ANSWER_SILENCE_MS) || 3000;
```

Set `AUTO_ANSWER=true` and `AUTO_ANSWER_SILENCE_MS=3000` in `env.example`.
Preserve an existing explicit false value.

- [ ] **Step 7: Replace raw time choices with named presets**

Use Responsive at 2500 ms, Balanced at 3000 ms, and Patient at 4500 ms.
Select Balanced when the saved value is missing or unsupported.

- [ ] **Step 8: Remove superseded coalescing from `main.js`**

Remove `_utteranceBuffer`, `_utteranceTimer`, `_utteranceDispatchInFlight`, `_utteranceCoalesceMs`, `handleTranscriptionFragment()`, `dispatchCoalescedUtterance()`, and `processTranscriptionWithLLM()` after `rg` confirms they have no active callers.

- [ ] **Step 9: Run controller and speech tests**

Run: `node --test tests/turn-detector.test.js tests/interview-session.test.js tests/audio-speech.test.js`

Expected: A two-second pause produces one generation call and a slow transcript cannot release a partial question.

- [ ] **Step 10: Commit automatic submission**

```bash
git add src/interview/session-controller.js main.js env.example settings.html src/ui/settings-window.js tests/interview-session.test.js tests/turn-detector.test.js
git commit -m "fix(interview): join natural speech pauses"
```

---

### Task 4: Filter Hidden Reasoning Across Stream Chunks

**Files:**

- Create: `src/services/visible-answer-filter.js`
- Create: `tests/visible-answer-filter.test.js`
- Modify: `src/services/sse-parser.js`
- Modify: `tests/provider-streaming.test.js`

**Interfaces:**

- Consumes: Arbitrary answer deltas after SSE event parsing.
- Produces: `VisibleAnswerFilter.push(text)` and `VisibleAnswerFilter.finish()`.

- [ ] **Step 1: Write split-tag tests**

```js
const filter = new VisibleAnswerFilter();
assert.equal(filter.push('<thi'), '');
assert.equal(filter.push('nk>private chain'), '');
assert.equal(filter.push('</think>\n\nPublic answer'), 'Public answer');
assert.equal(filter.finish(), '');
```

- [ ] **Step 2: Protect literal tags in visible text and code**

```js
assert.equal(new VisibleAnswerFilter().push('Use `<think>` as text.'),
  'Use `<think>` as text.');
const code = '```xml\n<think>example</think>\n```';
assert.equal(new VisibleAnswerFilter().push(code), code);
```

- [ ] **Step 3: Cover every supported leading tag and terminal state**

Test case-insensitive `think`, `thinking`, `analysis`, and `reasoning` tags.
Test multiple leading blocks, whitespace before the first block, split closing tags, an unclosed block at EOF, hidden content over 64 KiB, and reasoning-only streams.

- [ ] **Step 4: Implement explicit probing, hidden, and visible states**

The probing state buffers only enough text to decide whether the response begins with a recognized opening tag.
The hidden state discards content until the matching close tag, including split close tags.
The visible state returns all content unchanged.
At EOF, an unclosed hidden block is discarded and no private content is released.

- [ ] **Step 5: Apply one filter to each `streamCompletion()` attempt**

Create a new filter for every retry attempt.
Append and emit only filtered text.
Populate `error.partialText` with visible output only.
Reject reasoning-only streams as `EMPTY_RESPONSE`.

- [ ] **Step 6: Run focused tests**

Run: `node --test tests/visible-answer-filter.test.js tests/provider-streaming.test.js`

Expected: No recognized leading reasoning block reaches deltas, final text, or partial errors.

- [ ] **Step 7: Commit the filter**

```bash
git add src/services/visible-answer-filter.js src/services/sse-parser.js tests/visible-answer-filter.test.js tests/provider-streaming.test.js
git commit -m "fix(ai): hide streamed reasoning blocks"
```

---

### Task 5: Normalize Provider Reasoning Semantics

**Files:**

- Modify: `src/services/openrouter.service.js`
- Modify: `src/services/llm.service.js`
- Modify: `main.js`
- Modify: `tests/provider-streaming.test.js`
- Modify: `tests/interview-prompts.test.js`

**Interfaces:**

- Consumes: The shared visible-delta streaming contract.
- Produces: Visible-only output for interview, typed, speech, and screenshot requests.

- [ ] **Step 1: Test structured reasoning fields**

```js
assert.equal(openAIEvent({
  choices: [{ delta: { reasoning: 'private', content: 'Visible' } }]
}).delta, 'Visible');
assert.equal(geminiEvent({ candidates: [{ content: { parts: [
  { thought: true, text: 'private' }, { text: 'Visible' }
] } }] }).delta, 'Visible');
```

- [ ] **Step 2: Ignore structured reasoning at each provider mapper**

OpenAI-compatible parsing reads visible `delta.content` and does not concatenate `reasoning` or `reasoning_content`.
Gemini parsing joins text only from parts where `thought !== true`.

- [ ] **Step 3: Route every active generation path through `generateAnswer()`**

Keep provider-specific message construction.
Delegate interview, typed, speech, and screenshot generation to `generateAnswer({ messages, signal, onDelta })`.

- [ ] **Step 4: Remove duplicate active stream parsing**

Make legacy `processTextWithSkillStream`, `processTranscriptionWithIntelligentResponseStream`, and `processImageWithSkillStream` delegate to message construction plus `generateAnswer()` while preserving their positional signatures.

- [ ] **Step 5: Verify reasoning never enters session memory**

```js
assert.equal(sessionManager.getConversationHistory(10)
  .some(event => /<think>|private chain/i.test(event.content)), false);
```

- [ ] **Step 6: Run provider and interview tests**

Run: `node --test tests/provider-streaming.test.js tests/interview-prompts.test.js tests/interview-session.test.js`

Expected: Every entry point returns only visible answer text and cancellation remains intact.

- [ ] **Step 7: Commit provider normalization**

```bash
git add src/services/openrouter.service.js src/services/llm.service.js main.js tests/provider-streaming.test.js tests/interview-prompts.test.js
git commit -m "refactor(ai): unify visible response streaming"
```

---

### Task 6: Add Content-Free Latency Diagnostics

**Files:**

- Create: `src/interview/latency-metrics.js`
- Create: `tests/latency-metrics.test.js`
- Modify: `src/interview/session-controller.js`
- Modify: `main.js`
- Modify: `src/core/logger.js`

**Interfaces:**

- Consumes: Question IDs, request IDs, provider metadata, and stage timestamps.
- Produces: A bounded metrics ring and p50/p95 summaries without content.

- [ ] **Step 1: Write timing tests**

```js
const metrics = new LatencyMetrics({ limit: 50 });
metrics.begin('q1', { speechEndedAt: 1000 });
metrics.mark('q1', 'transcriptReadyAt', 1600);
metrics.mark('q1', 'questionCommittedAt', 4000);
metrics.mark('q1', 'firstVisibleTokenAt', 4500);
const record = metrics.complete('q1', 5200);
assert.equal(record.durations.transcriptionMs, 600);
assert.equal(record.durations.endpointWaitMs, 2400);
assert.equal(record.durations.firstTokenMs, 500);
assert.equal('text' in record, false);
```

- [ ] **Step 2: Implement bounded active and completed records**

Keep at most 10 active records and 50 completed records.
Store IDs, provider, model, source, warm state, timestamps, durations, and sanitized error codes.

- [ ] **Step 3: Mark all stages exactly once**

Mark speech end from acoustic lifecycle, transcript readiness after the last pending job settles, question commitment before queue submission, first visible token on the first filtered delta, and completion or failure at the terminal event.

- [ ] **Step 4: Add sanitized logs and summaries**

`getSummary()` returns count, p50, and p95 for transcription, endpoint wait, provider first token, and total latency.
Logs contain no prompt, transcript, answer, credential, or endpoint query parameter.

- [ ] **Step 5: Run metrics and full tests**

Run: `node --test tests/latency-metrics.test.js tests/*.test.js`

Expected: Metrics are correct and the complete deterministic suite remains green.

- [ ] **Step 6: Commit diagnostics**

```bash
git add src/interview/latency-metrics.js src/interview/session-controller.js src/core/logger.js main.js tests/latency-metrics.test.js
git commit -m "perf(interview): measure answer latency stages"
```

---

### Task 7: Clarify Turn and Answer Status in the UI

**Files:**

- Modify: `src/ui/interview-state.js`
- Modify: `src/ui/interview-panel.js`
- Modify: `src/styles/common.css`
- Modify: `index.html`
- Modify: `chat.html`
- Modify: `llm-response.html`
- Create: `tests/ui-state.test.js`

**Interfaces:**

- Consumes: Turn state, deadline, pending count, and visible-only answer content.
- Produces: Stable capture and answer labels with immediate manual actions.

- [ ] **Step 1: Test independent status labels**

```js
assert.equal(viewState({ turnState: 'transcribing' }).turnLabel,
  'Transcribing question');
assert.equal(viewState({ turnState: 'waiting' }).turnLabel,
  'Waiting for the rest of the question');
assert.equal(viewState({ questions: [{ state: 'generating' }] }).answerLabel,
  'Preparing answer');
```

- [ ] **Step 2: Map the full turn lifecycle**

Use Listening to the interviewer, Transcribing question, Waiting for the rest of the question, Question captured, and Ready for a question.

- [ ] **Step 3: Keep Answer now enabled while a non-empty draft waits**

The action submits without stopping capture.
Do not display a distracting live countdown.

- [ ] **Step 4: Distinguish provider preparation from visible streaming**

Show Preparing answer before the first visible token and Writing answer afterward.
Do not replace the answer DOM when a filtered delta is empty.

- [ ] **Step 5: Preserve scroll, selection, keyboard focus, and display scaling**

Auto-follow only when the reader remains within 48 px of the bottom.
Inspect compact and expanded windows at 100%, 125%, and 150% scaling.

- [ ] **Step 6: Run UI tests and syntax checks**

Run: `node --test tests/ui-state.test.js`

Run: `npm.cmd run check`

Expected: UI state tests pass and every JavaScript file parses.

- [ ] **Step 7: Commit UI feedback**

```bash
git add src/ui/interview-state.js src/ui/interview-panel.js src/styles/common.css index.html chat.html llm-response.html tests/ui-state.test.js
git commit -m "feat(ui): clarify interview turn status"
```

---

### Task 8: Run Audio, Provider, and Package Acceptance

**Files:**

- Create: `tests/fixtures/audio/README.md`
- Create: `docs/testing/turn-detection-acceptance.md`
- Modify: `progress.md`
- Modify: `handover.md`

**Interfaces:**

- Consumes: The complete system-audio, transcription, turn detection, provider, and UI flow.
- Produces: Reproducible evidence, latency measurements, and an exact handover state.

- [ ] **Step 1: Document non-personal audio fixture provenance**

Record sample rate, duration, pause length, expected combined transcript, and generation or recording source.

- [ ] **Step 2: Exercise required pause scenarios**

| Case | Pause | Expected questions |
| --- | ---: | ---: |
| Continuous question | 0.5 s | 1 |
| Natural planning pause | 2.0 s | 1 |
| Boundary margin | 2.8 s | 1 |
| Separate question | 4.0 s | 2 |
| Slow second transcription | 2.0 s | 1 |

- [ ] **Step 3: Exercise reasoning-output fixtures**

Split leading reasoning tags at every character boundary.
Cover structured OpenAI reasoning, Gemini thought parts, unclosed blocks, visible code containing `<think>`, and reasoning-only output.

- [ ] **Step 4: Run deterministic verification**

Run: `npm.cmd test`

Run: `npm.cmd run check`

Expected: Zero failed tests and zero syntax failures.

- [ ] **Step 5: Run a live Windows system-audio interview**

Play a two-part question with a two-second pause and confirm one combined question appears.
Confirm no answer starts before the second segment and no reasoning tag appears.
Use Answer now once to verify the immediate bypass.

- [ ] **Step 6: Measure warm and cold latency**

Record at least 20 warm samples and 5 cold samples.
Report p50 and p95 transcription, endpoint wait, first visible token, and total latency with hardware, providers, and model.

- [ ] **Step 7: Build and test the Windows package**

Run: `npm.cmd run build:win`

Verify the audio worklet, prompts, loopback capture, selected provider, and visible-answer filter from a clean profile.

- [ ] **Step 8: Update handover records and commit evidence**

Record exact commands, pass counts, measured timing, external limitations, and unrun manual checks.

```bash
git add tests/fixtures/audio/README.md docs/testing/turn-detection-acceptance.md progress.md handover.md
git commit -m "docs: record turn detection acceptance"
```

---

## Follow-Up Improvement Backlog

These items start after Task 8 passes.
Each requires its own design because it changes an independent product surface.

| Priority | Improvement | Acceptance signal |
| --- | --- | --- |
| 1 | Transcript confidence and correction | Low-confidence phrases can be corrected before Answer now. |
| 2 | Audio setup diagnostics | Settings shows source, level, missing tracks, disconnects, and a transcript test. |
| 3 | Concise-first controls | Brief, Balanced, and Detailed alter depth without changing interview category. |
| 4 | Interview profile context | Role, seniority, company type, and candidate facts remain explicit and local. |
| 5 | Optional provider fallback | Fallback is opt-in, tested, and never sends data to an unselected provider. |
| 6 | Packaged end-to-end automation | A clean Windows package repeatedly passes audio, queue, cancellation, and rendering cases. |

## Final Self-Review Checklist

- [ ] A two-second acoustic pause has deterministic and live system-audio coverage.
- [ ] The transcription drain barrier gates automatic submission.
- [ ] Automatic mode defaults on only when no explicit preference exists.
- [ ] Manual and microphone behavior remains intact.
- [ ] Leading reasoning tags are filtered across arbitrary chunks.
- [ ] Structured provider reasoning never enters visible deltas.
- [ ] Hidden reasoning never enters session history or logs.
- [ ] Literal tags in visible prose and code remain visible.
- [ ] Legacy coalescing is removed after callers are eliminated.
- [ ] Latency claims use recorded stage measurements.
- [ ] Deterministic tests, live audio, and packaged Windows checks are reported separately.
