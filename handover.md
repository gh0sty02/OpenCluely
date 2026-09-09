# OpenCluely implementation handover

Read [progress.md](progress.md), the [plan](docs/superpowers/plans/2026-09-08-interview-assistant.md), and the [design](docs/superpowers/specs/2026-09-08-interview-assistant-design.md) first.
Then read the [turn detection and visible answers plan](docs/superpowers/plans/2026-09-09-turn-detection-and-visible-answers.md) for the next implementation milestone.
The user authorized implementation and requested these handover documents for another agent to continue from the current point.

## User requirements

Polish the UI and make the audio-to-answer flow reliable for interviews beyond DSA, including system design and conceptual questions such as how an LLM works.
Use call/system audio by default and make microphone capture optional.
Preserve the existing custom endpoint, API key, and model.
Do not promise zero external-service failures; preserve questions and provide usable recovery.

## Workspace

Repository: `C:/Users/prana/OneDrive/Desktop/repo/OpenCluely`.
Branch: `feat/openrouter-provider`.
Existing uncommitted work belongs to the user and must remain intact.
Node is installed; use `npm.cmd` rather than `npm` in PowerShell.
No commits, pushes, or releases have been made by this implementation.

## Current architecture (as of this session)

`src/interview/session-controller.js` owns finalized question queueing, deduplication, answer attempts, cancellation, and snapshots — and is now **wired into `main.js`** (it was not, at the start of this session, despite earlier notes claiming "integration underway"):
- `ipcMain.handle('interview-action', ...)` / `ipcMain.handle('get-interview-state', ...)` in `main.js`.
- `interviewController.on('state', ...)` broadcasts `interview-state` to all windows.
- `speechService.on('transcription', ...)` now routes to `interviewController.acceptTranscript(...)` (replaces the old `handleTranscriptionFragment` dispatch for the interview flow — that method is still defined but no longer called).
- `generateInterviewAnswer(question, {signal, onDelta})` in `main.js` composes the prompt via `promptLoader.composeMessages()` and calls `llmService.generateAnswer({messages, signal, onDelta})` — a new method on both `llm.service.js` and `openrouter.service.js` that routes through `sse-parser.js`'s `streamCompletion` (retries/deadlines/cancellation, already unit-tested).

`preload.js` exposes `interviewAction`, `getInterviewState`, `onInterviewState`, `reportInterviewCaptureLevel`, `reportInterviewCaptureState` — none of this existed before this session.

Audio: `src/audio/capture.js` (renderer, `AudioCapture` class) + `src/audio/pcm-worklet.js` (AudioWorklet, 16kHz mono PCM16) are loaded in `index.html`/`chat.html` and wired up inside `src/ui/interview-panel.js`. Only the **main window** (`body.interview-shell`) actually owns the `AudioCapture` instance and calls `.start()`/`.stop()`, gated on `document.body.classList.contains('interview-shell')` — other windows dispatch the same `interviewAction` IPC but don't themselves capture. Frames go out via the pre-existing `sendAudioChunk`/`audio-chunk` IPC channel into `speechService.handleAudioChunkFromRenderer`.

**`session.setDisplayMediaRequestHandler` was missing** — without it `getDisplayMedia` (the default system-audio path) rejects immediately on Electron 27+. Added in `main.js`'s `setupPermissions()`, using `desktopCapturer.getSources()` + Windows loopback (`audio: 'loopback'`).

`src/services/speech.service.js`'s whisper/mistral segment-flush logic was reworked (see progress.md's "Bugs found and fixed" section) to queue concurrent utterances individually instead of merging them, and `stopRecording({cancel})` now returns a promise and discards in-flight work correctly on cancel/restart.

## What's verified vs. not

**Verified live** (via `npm start -- --remote-debugging-port=9222` + raw CDP WebSocket calls — no Playwright installed locally, so a small ad-hoc script was used instead of a proper driver):
- Clean app startup, no exceptions, all 4 windows load correctly.
- Main window's interview panel renders fully and correctly sized (520×~634px) after fixing a real layout bug (see progress.md — duplicate `common.css` `<link>` in `index.html` was clobbering an override; `.interview-workspace{flex:1}` collapses under `index.html`'s auto-sizing `fit-content` body; `resizeWindowToContent()` didn't account for the interview panel at all).
- Clicking Start listening → real system-audio capture via `getDisplayMedia`+loopback → `captureStatus: "Listening to system audio"` → a real Mistral transcription attempt appears in `~/.OpenCluely/logs/application-*.log` (it hit a provider capacity error — external, not a bug).
- Pause cleanly stops capture (`captureStatus: "Capture paused"`).

**Not verified**: microphone source path, retry/stop-answer/answer-now buttons, multi-question queueing live, chat.html/llm-response.html/settings.html visual states, long-session history list scrolling/collapse, a packaged Windows build, the 30-question corpus, performance numbers.

If continuing in a fresh session: reuse the CDP approach if Playwright isn't installed — `npm.cmd start -- --remote-debugging-port=9222` in the background, `curl http://localhost:9222/json` to list window targets, then open a raw `WebSocket` (Node 22+ has it built in) to a target's `webSocketDebuggerUrl` and send `Runtime.evaluate`/`Page.captureScreenshot` CDP commands. **Always `taskkill //F //IM electron.exe //T` before relaunching** — this app has a single-instance lock, so a stale running instance will just focus itself and your new process will exit immediately without loading your code changes (this cost real time in this session before being caught).

## Continuation

The detailed next plan is written but no implementation from it has started.
Execute it in order because speech lifecycle events and the turn detector are prerequisites for UI and acceptance work.
The unresolved timing race occurs when new speech begins before the previous segment finishes transcription, because cancelling a timer does not record activity when no timer exists yet.
The visible-answer path needs a stateful leading-reasoning filter because safe HTML escaping currently displays `<think>`-style tags as text.

Next, in priority order: (1) screenshot-verify chat.html and settings.html similarly, since chat.html's interview panel uses the same shared CSS/JS and could have its own undiscovered issues; (2) test the microphone source path; (3) exercise retry/stop-answer/multi-question queueing live; (4) add the "reject settings changes mid-session" guard from the plan; (5) decide whether to migrate the legacy `process*Stream` methods onto `sse-parser` too, or leave them (they still work, just don't get the deadline/retry hardening); (6) task 7's fuller settings/diagnostics audit; (7) task 8 (corpus, perf, packaging).

Record checks that require hardware, credentials, or a real interview session as unverified if the environment cannot perform them.
Update this file and progress.md with actual commands, outcomes, limitations, and exact remaining work before handing off.
