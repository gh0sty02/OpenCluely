# Implementation progress

Plan: [Reliable interview assistant](docs/superpowers/plans/2026-09-08-interview-assistant.md).
Design: [Interview assistant design](docs/superpowers/specs/2026-09-08-interview-assistant-design.md).
Next plan: [Turn detection and visible answers](docs/superpowers/plans/2026-09-09-turn-detection-and-visible-answers.md).

## Current objective

Implement the approved plan in the existing working tree, preserving the user's custom-provider work.
System audio is the confirmed default, with microphone optional.
Windows is the initial validation target.

The next milestone is planned but not implemented.
It will make automatic answering the missing-value default, join natural two-second pauses through an acoustic turn detector and transcription drain barrier, filter hidden reasoning before storage or rendering, and measure latency by stage.

## Decisions

- Work in place on `feat/openrouter-provider` because the baseline includes substantial uncommitted provider and speech changes.
- Retain Electron and plain JavaScript.
- Use the installed Node test runner, without adding a test framework.
- Use `npm.cmd` on Windows because PowerShell blocks the local `npm.ps1` shim.
- Keep listening and answer-generation state independent.
- Queue only finalized questions; answer completion must never flush a pending draft.
- Reject connection-setting changes during an active session to avoid switching providers halfway through an answer (not yet implemented — see gaps below).
- Only the main overlay window (`index.html`, `body.interview-shell`) owns the real `AudioCapture` instance; other windows (chat) dispatch the same `interviewAction` IPC but do not themselves capture audio, since only one renderer should hold `getDisplayMedia`/`getUserMedia`. The main window is always running, so this works from any window in practice.
- `generateAnswer({messages, signal, onDelta})` was added to both `llm.service.js` and `openrouter.service.js` as new, additive methods that route through `sse-parser.js`'s `streamCompletion` (deadlines/retry/cancellation). The pre-existing `process*Stream` methods used by the legacy chat/screenshot flows were left untouched to avoid regressing working code under time pressure.

## Task status

| Task | Status | Evidence |
| --- | --- | --- |
| 1. Regression baseline and portable commands | Done | `scripts/start-electron.js`, `scripts/clean.js`, `scripts/check.js`; `npm test` runs 37 tests. |
| 2. System audio capture | Done, verified live | `src/audio/capture.js` + `pcm-worklet.js` wired into `index.html`/`chat.html`; `session.setDisplayMediaRequestHandler` added in `main.js` (loopback audio) — this was previously **missing entirely**, so `getDisplayMedia` would have rejected immediately. Verified via CDP: clicking Start listening reached `captureStatus: "Listening to system audio"` with a real Mistral transcription attempt in the log (hit a provider capacity error, not a bug). |
| 3. Question/session lifecycle | Done | `src/interview/session-controller.js` (9 tests) now wired into `main.js`: `interview-action`/`get-interview-state` IPC, `interview-state` broadcast, transcript routing via `acceptTranscript`. Previously the controller existed but had **zero callers** in `main.js`. |
| 4. Provider streaming reliability | Done for the interview path | `sse-parser.js` (12 tests) is now called by both providers' new `generateAnswer()`. The legacy `process*Stream` methods (used by chat/screenshot) still use their original ad-hoc streaming — not migrated, out of scope for this pass. |
| 5. Interview prompts | Done | `prompt-loader.js composeMessages()` (5 tests) wired into `generateInterviewAnswer()` in `main.js`, using the session controller's own completed-question history (not the legacy `sessionManager` event log, whose shape doesn't match). |
| 6. UI polish | Mostly done | Interview panel renders correctly in the main window (verified via screenshot). Fixed a real main-window layout bug (see below). `chat.html`/`llm-response.html` visual states not yet screenshot-verified. |
| 7. Settings and diagnostics | Partially done | `audioSource` is now actually read/persisted (`AUDIO_SOURCE` env var) — previously the settings UI collected it but `main.js` silently dropped it. Interview mode syncs from the existing `activeSkill` setting. Broader settings-screen audit (task 7's diagnostics/recovery-action items) not done. |
| 8. End-to-end and packaging | Not done | No packaged build tested; no 30-question corpus run; no perf measurement. |

## Bugs found and fixed this session

1. **`src/services/speech.service.js`**: the whisper/mistral pause+restart path merged concurrently-queued utterances into one buffer (losing distinct transcripts) and could let a stale transcription from before a cancel/restart leak into the new session. Reworked `_flushWhisperSegment`/added `_runWhisperTranscription`+`_drainPendingSegments` to queue segments individually with per-item promises, and added `captureId`-based staleness checks. `stopRecording()` now accepts `{cancel}` and returns a promise. All 9 previously-passing + 2 newly-passing tests in `tests/audio-speech.test.js` are green (was 7/9).
2. **Missing `session.setDisplayMediaRequestHandler`**: without it, `getDisplayMedia` (the default "system audio" capture path) rejects immediately with `NotSupportedError` on Electron 27+. Added in `main.js` using `desktopCapturer` + Windows WASAPI loopback (`audio: 'loopback'`).
3. **Main window layout collapse** (found live, user-reported "any extra text is cut off"): three compounding bugs in `index.html`/`common.css`:
   - `resizeWindowToContent()` in `main-window.js` only measured `.command-tab`'s rect, ignoring `#interviewWorkspace`/`#interviewCompose` entirely — the window never grew past ~35px tall.
   - `.interview-workspace { flex: 1 }` (in `common.css`, correct for `chat.html`'s fixed-height window) collapses to 0px height inside `index.html`'s auto-sizing `fit-content` body, because `flex:1` sets `flex-basis:0%` with no free space to grow into.
   - `index.html` linked `common.css` **twice** — once in `<head>`, once again after the interview panel markup — so any in-page override of `common.css` rules was silently clobbered by the second, later-cascading copy. This was the actual root cause of the previous two fixes appearing to do nothing until this duplicate was removed.
   Fixed all three; verified via CDP that the panel now renders fully (Start listening, source select, status, mode, question/answer, history, compose form all visible) at the correct 520px width.

## Known gaps / not yet done

- `chat.html`, `llm-response.html`, `settings.html` UI not screenshot-verified (only `index.html`/main window was, since that's where the reported bug was).
- No guard against changing `audioSource`/provider mid-session (plan's "reject connection-setting changes during an active session").
- Gemini provider's `generateAnswer()` path is implemented and unit-testable via `sse-parser` mocks but not exercised live (OpenRouter is the configured provider in this dev environment).
- Legacy `handleTranscriptionFragment`/`dispatchCoalescedUtterance`/`processTranscriptionWithLLM` in `main.js` are now dead code (superseded by the interview controller) but were left in place rather than deleted, to limit blast radius this session.
- No packaged Windows build tested; no perf/corpus acceptance run (plan task 8).

## Verification log

- `node --test tests/*.test.js`: 37 passed, 0 failed (was 35/37 at session start).
- `node scripts/check.js`: 43 files, 0 syntax failures.
- Live app run (`npm start -- --remote-debugging-port=9222`), inspected via Chrome DevTools Protocol (no Playwright available locally): clean startup (no exceptions/errors in `~/.OpenCluely/logs`), all 4 windows load their expected URLs, `window.electronAPI.interviewAction`/`getInterviewState` present, interview panel renders with correct content and dimensions after the layout fix, Start listening → real system-audio capture → `captureStatus: "Listening to system audio"` → real Mistral transcription attempt in the log, Pause → `captureStatus: "Capture paused"` cleanly.
- Not verified: microphone source, retry/stop-answer buttons, multi-question queueing live, long-session history scrolling, packaged build.
