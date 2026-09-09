# Turn Detection and Visible Answers: Acceptance Record

This records what was actually run for Task 8 of
[`docs/superpowers/plans/2026-09-09-turn-detection-and-visible-answers.md`](../superpowers/plans/2026-09-09-turn-detection-and-visible-answers.md)
in the environment this task was executed in, and what remains unverified.

Every claim below is either:

- **Verified deterministically**: an automated test with a simulated clock and
  synthetic input actually ran and passed in this session.
- **Verified live**: the running Electron app was actually driven (via Chrome
  DevTools Protocol, since Playwright is not installed) and observed.
- **Not verified, requires X**: not run in this environment, with the reason.

Deterministic coverage exercises the acoustic timing and reasoning-filter
*logic* with a fake clock and synthetic transcripts/stream chunks. It does not
exercise real microphone/loopback capture, a real speech provider's timing
jitter, or real model output. Where the plan's Task 8 asks for that (Steps 2
and 3 as literally written, plus Steps 5 and 6), this document says so
explicitly rather than treating deterministic coverage as a substitute.

## Step 1: Audio fixture provenance

Documented in [`tests/fixtures/audio/README.md`](../../tests/fixtures/audio/README.md).
**No audio files are checked in.** This environment has no microphone,
speaker loopback, or text-to-speech engine, so no real or synthetic speech
audio could be produced here. The README records the required format
(16 kHz mono PCM16 WAV, matching `src/audio/pcm-worklet.js`), the five
required fixtures with their expected transcripts and pause lengths, and the
non-personal/synthetic provenance requirement for whoever records or
synthesizes them.

## Step 2: Pause scenarios

| Case | Pause | Expected questions | Status |
| --- | ---: | ---: | --- |
| Continuous question | 0.5 s | 1 | Not exercised by an automated test at exactly 0.5 s. Structurally, a 0.5 s gap is below `speech.service.js`'s default 700 ms VAD silence hangover (`WHISPER_SILENCE_HANGOVER_MS`, `src/services/speech.service.js:1499`), so it would not even produce two separate transcription segments at the VAD layer, let alone two questions. The general "one settled transcript yields one submitted question" behavior is covered by `tests/interview-session.test.js:151` ("Answer now submits immediately while the acoustic deadline is pending"). **Verified deterministically only in the general case, not at the specific 0.5 s boundary. Requires live audio for the literal case.** |
| Natural planning pause | 2.0 s | 1 | **Verified deterministically.** `tests/interview-session.test.js:100` ("a two-second planning pause remains one automatically submitted question") drives exactly this: two speech segments separated by a 2000 ms gap, settling into one combined draft, with one `generationCalls` entry only once the full 3000 ms silence deadline elapses. Also covered at the detector level by `tests/turn-detector.test.js:71` ("the newest acoustic boundary owns the deadline after a natural pause"). |
| Boundary margin | 2.8 s | 1 | **Verified deterministically, as a superset.** Neither test uses exactly 2.8 s; both `tests/turn-detector.test.js:71` and `tests/interview-session.test.js:100` advance the clock to `silenceMs - 1` (2999 ms) and assert zero generation/ready events, then advance the final 1 ms and assert exactly one. This proves the boundary holds for every pause up to and including 2.8 s (a subset of what is tested), not only for 2.8 s specifically. |
| Separate question | 4.0 s | 2 | **Not directly verified.** No test in `tests/turn-detector.test.js` or `tests/interview-session.test.js` drives a full turn-lifecycle silence deadline (a pause past the 3000 ms window with no further speech) followed by a second independent turn and asserts two separate auto-submitted questions. The closest indirect coverage: `tests/turn-detector.test.js:61` ("a silence deadline waits for the final pending transcription") proves a `ready` event fires once a turn's silence window elapses, and `tests/interview-session.test.js:182` ("duplicate final identities are ignored but repeated questions are allowed") proves two sequential submitted questions remain distinct in session state, but that test drives submission manually (`answerNow()`/`flush()`), not via the real 4 s turn-detector timing. **This row requires either a new deterministic test or the live audio fixture to be fully covered.** |
| Slow second transcription | 2.0 s | 1 | **Verified deterministically.** `tests/turn-detector.test.js:61` ("a silence deadline waits for the final pending transcription") and `tests/interview-session.test.js:61` ("a silence deadline waits for the final pending transcription", `noteTranscriptionStarted`/`noteTranscriptionSettled` sequencing) prove the ready/generation event is withheld until a pending transcription settles, even after the silence deadline's nominal time has passed. |

Live confirmation with real audio (Step 5 of the plan) was not performed; see
that section below.

## Step 3: Reasoning-output fixtures

| Case | Status |
| --- | --- |
| Leading tags split at every character boundary | **Verified deterministically.** `tests/visible-answer-filter.test.js:15` ("recognizes every supported tag across every opening and closing split") iterates every split position of both the opening and closing tag for all four supported tag names (`think`, `thinking`, `analysis`, `reasoning`). `tests/visible-answer-filter.test.js:7` covers a three-way split (`<thi` / `nk>private chain</thi` / `nk>...`) end to end. `tests/provider-streaming.test.js:58` exercises the same split-tag behavior through the real `streamCompletion()` SSE path, not just the filter in isolation. |
| Structured OpenAI reasoning (`delta.reasoning` / `reasoning_content`) | **Verified deterministically.** `tests/provider-streaming.test.js:183` ("provider event mappers ignore structured reasoning fields") asserts `reasoning`/`reasoning_content` fields never reach the visible delta. |
| Gemini thought parts (`{ thought: true, text }`) | **Verified deterministically.** `tests/provider-streaming.test.js:183` (streaming) and `tests/provider-streaming.test.js:286` ("Gemini non-streaming extraction excludes thought parts and response text shortcuts") both assert parts marked `thought: true` are excluded from visible text. |
| Unclosed reasoning blocks | **Verified deterministically.** `tests/visible-answer-filter.test.js:58` ("discards unclosed and reasoning-only hidden content at EOF") covers both an unclosed `<reasoning>` block and a fully closed reasoning-only block, asserting no hidden text is ever released. |
| Visible code containing `<think>` | **Verified deterministically.** `tests/visible-answer-filter.test.js:31` ("preserves tags after visible prose or a visible code fence") asserts a literal `<think>` inside prose and inside a fenced code block passes through unchanged once the filter has already committed to the visible state. |
| Reasoning-only output | **Verified deterministically.** `tests/visible-answer-filter.test.js:58` (filter level) and `tests/provider-streaming.test.js:70` ("stream completion rejects reasoning-only output as empty", asserting `error.code === 'EMPTY_RESPONSE'` and `error.partialText === ''`) both cover this at their respective layers. |

All of Step 3's fixtures are synthetic SSE chunks and in-memory strings
constructed directly in the test files; none of this required a real model
response, so "verified deterministically" here is a complete, not partial,
substitute for what Step 3 as written asks for.

## Step 4: Deterministic verification (actually run this session)

Commands run from the repository root on 2026-09-09, on this worktree at
commit `79a4f2d` (the tip of `feat/openrouter-provider` at the time of this
task):

```
$ npm.cmd test
```

Real tail of the output:

```
...
✔ releases an incomplete opening-tag prefix as visible text at EOF (0.1391ms)
ℹ tests 122
ℹ suites 0
ℹ pass 122
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2311.2824
```

122 passed, 0 failed.

```
$ npm.cmd run check
```

Output:

```
> opencluely@1.0.0 check
> node scripts/check.js

Syntax checked 51 JavaScript files; 0 failures.
```

51 files, 0 syntax failures. Both match the plan's Step 4 expectation of zero
failed tests and zero syntax failures.

## Live UI smoke check (attempted, succeeded)

The plan's Task 8 does not list a UI smoke check as its own step, but Task 7
(`feat(ui): clarify interview turn status`, commit `79a4f2d`) landed a new
`#turnStatus` indicator that had only been unit-tested via
`tests/ui-state.test.js`, never rendered in a running window. This was
attempted here since it was feasible within a short time budget.

Procedure: `taskkill //F //IM electron.exe //T` (no stale instance was
running), then `npm.cmd start -- --remote-debugging-port=9222` in the
background, then `curl http://localhost:9222/json` to find the main window's
`webSocketDebuggerUrl` (the `index.html` target), then a Node script using
the built-in `WebSocket` client to send `Runtime.evaluate` commands over CDP
(no Playwright installed locally).

No `.env` file exists in this worktree, so the app opened straight to
onboarding rather than a configured interview session; live provider/audio
behavior could not be exercised this way. The main window (`index.html`,
`body.interview-shell`) still loaded normally underneath, with `#turnStatus`
present in the DOM and `window.InterviewUI` loaded.

Actual result, confirming `#turnStatus` exists and renders each turn state
without throwing:

```
INITIAL {"hasTurnStatus":true,"hasInterviewUI":true,"bodyClass":"interview-shell","initialHidden":true}
speaking {"ok":true,"text":"Listening to the interviewer","hidden":false,"dataState":"speaking"}
transcribing {"ok":true,"text":"Transcribing question","hidden":false,"dataState":"transcribing"}
waiting {"ok":true,"text":"Waiting for the rest of the question","hidden":false,"dataState":"waiting"}
ready {"ok":true,"text":"Question captured","hidden":false,"dataState":"ready"}
idle {"ok":true,"text":"Ready for a question","hidden":false,"dataState":"idle"}
RUNTIME_ERRORS []
```

This drove `InterviewUI.viewState()` and the same DOM writes
`src/ui/interview-panel.js`'s `render()` makes to `#turnStatus`
(`textContent`, `dataset.state`, `hidden`) for each of the five turn states,
against a synthetic snapshot object (not real IPC broadcast data, since no
real interview session was running). `Runtime.exceptionThrown` was monitored
for the duration of the check and recorded nothing. This is real evidence
that `#turnStatus` renders without a JS error for every turn state; it is
**not** evidence that the real IPC broadcast path (`main.js` to
`interview-state` to this handler) delivers those states correctly during an
actual interview, since no real audio or provider was exercised. The
Electron process was terminated afterward (`taskkill //F //IM electron.exe //T`).

## Step 5: Live Windows system-audio interview

**Not verified, requires a human speaking into a real microphone or system
audio loopback source.** This is a sandboxed, headless agent environment with
no audio input or output device and no way to play or capture real speech.
The two-part-question-with-a-two-second-pause behavior this step asks for is
covered deterministically (see Step 2 above), and the `#turnStatus`
rendering half of "confirm the right thing appears in the UI" was smoke-
checked live (see above), but the acoustic capture, real transcription
timing, and end-to-end "one combined question, no premature answer, no
reasoning tag" claim as a single live observation was not made.

## Step 6: Warm and cold latency measurement

**Not verified, requires the live interview flow from Step 5 plus a real
configured LLM provider actually answering at least 25 times (20 warm, 5
cold).** No `.env` with a configured provider/API key exists in this
worktree, and there is no real audio input to drive real questions through
the pipeline. `src/interview/latency-metrics.js`'s stage timing and
`getSummary()` p50/p95 math are covered deterministically by
`tests/latency-metrics.test.js` and by the latency-specific tests in
`tests/interview-session.test.js` (for example, "latency metrics: a spoken
turn records transcription, endpoint wait, first-token, and total
durations"), which confirms the measurement mechanism is correct, but no
real hardware/network/provider latency numbers were collected because no
real question-answer cycle was run.

## Step 7: Build and test the Windows package

**Not run, by design.** Per the task's explicit instructions, `npm.cmd run
build:win` was not run. Building and then manually verifying a packaged
installer from a clean profile is a long-running, resource-heavy step that
also requires human judgment (installing a generated artifact, exercising it
outside the dev environment) inappropriate for an unattended agent to
perform in this session.

## Step 8: Summary

| Plan step | Status |
| --- | --- |
| 1. Audio fixture provenance documented | Done (`tests/fixtures/audio/README.md`); no actual audio files, by design (no recording/synthesis capability here). |
| 2. Pause scenarios | Deterministically verified for continuous (partially, general case only), natural pause, boundary margin (as a superset), and slow second transcription. The separate-question (4.0 s, 2 questions) row is not directly covered by an existing test. Live confirmation not run. |
| 3. Reasoning-output fixtures | Fully verified deterministically across all five required cases. |
| 4. Deterministic verification | Run for real this session: 122/122 tests passed, 51/51 files syntax-clean. |
| 5. Live system-audio interview | Not run: no audio hardware in this environment. |
| 6. Warm/cold latency measurement | Not run: requires Step 5 plus a configured, live-answering provider. |
| 7. Windows package build | Not run, by instruction: too long-running/resource-heavy and needs human verification. |
| 8. This document, `tests/fixtures/audio/README.md`, `progress.md`, `handover.md` | Done. |

Whoever continues this plan on real hardware should, in order: (1) record
the five audio fixtures per `tests/fixtures/audio/README.md`'s provenance
table, (2) add a deterministic turn-lifecycle test for the "separate
question" 4.0 s row so Step 2's table has full automated coverage, (3) run
Step 5 with real system audio and a configured provider, (4) collect the 25
latency samples for Step 6, and (5) only then attempt `npm.cmd run
build:win` and Step 7's clean-profile packaged verification.
