# OpenCluely implementation handover

Read [progress.md](progress.md), the [plan](docs/superpowers/plans/2026-09-08-interview-assistant.md), and the [design](docs/superpowers/specs/2026-09-08-interview-assistant-design.md) first.
Then read the [turn detection and visible answers plan](docs/superpowers/plans/2026-09-09-turn-detection-and-visible-answers.md), whose Tasks 1 through 7 are implemented and committed, and whose Task 8 (this handover's subject) is deterministically verified and documented but not live-hardware-verified.

## User requirements

Polish the UI and make the audio-to-answer flow reliable for interviews beyond DSA, including system design and conceptual questions such as how an LLM works.
Use call/system audio by default and make microphone capture optional.
Preserve the existing custom endpoint, API key, and model.
Do not promise zero external-service failures; preserve questions and provide usable recovery.
Reliably combine speech separated by natural two-second pauses, automatically submit a complete question with controlled latency, and prevent model reasoning tags from appearing in answers or session history (the 2026-09-09 plan's goal, now implemented).

## Workspace

Repository: `C:/Users/prana/OneDrive/Desktop/repo/OpenCluely`.
Branch: `feat/openrouter-provider`, currently at commit `79a4f2d` ("feat(ui): clarify interview turn status").
Existing uncommitted work belongs to the user and must remain intact.
Node is installed; use `npm.cmd` rather than `npm` in PowerShell.
No pushes or releases have been made by this implementation.

If you are picking this up in a worktree, confirm your branch actually
contains `79a4f2d` (`git log --oneline -1`) before trusting any file in this
repository against what this handover describes. This session found its own
worktree branch had silently fallen 25 commits behind `feat/openrouter-provider`
(missing all of Tasks 1-7 of the 2026-09-09 plan) and had to fast-forward
(`git merge --ff-only feat/openrouter-provider`) before any of the source
files this document references actually existed on disk.

## Current architecture (as of this session, commit `79a4f2d`)

`src/interview/session-controller.js` owns finalized question queueing, deduplication, answer attempts, cancellation, and snapshots, and is wired into `main.js`:
- `ipcMain.handle('interview-action', ...)` / `ipcMain.handle('get-interview-state', ...)` in `main.js`.
- `interviewController.on('state', ...)` broadcasts `interview-state` to all windows.
- `speechService`'s four-event lifecycle (`speech-started`, `speech-ended`, `transcription-started`, `transcription-settled`) now routes into the controller's `noteSpeechStarted`/`noteSpeechEnded`/`noteTranscriptionStarted`/`noteTranscriptionSettled`, which forward to an internal `TurnDetector` (`src/interview/turn-detector.js`).
- `TurnDetector` owns acoustic activity, the latest speech boundary, and pending transcription identities, and emits `ready` exactly once per turn when speech is inactive, the silence window (default 3000 ms, `AUTO_ANSWER_SILENCE_MS`) has elapsed since the last speech end, and no transcription remains pending. `acceptTranscript()` no longer owns any timer; it only validates identity, filters noise, and appends text to the draft.
- `generateInterviewAnswer(question, {signal, onDelta})` in `main.js` composes the prompt via `promptLoader.composeMessages()` and calls `llmService.generateAnswer({messages, signal, onDelta})`, the one active streaming path now shared by interview, typed, speech, and screenshot generation (`src/services/llm.service.js`, `src/services/openrouter.service.js`, both routed through `sse-parser.js`'s `streamCompletion()`).
- Every `streamCompletion()` attempt applies a fresh `VisibleAnswerFilter` (`src/services/visible-answer-filter.js`) so hidden reasoning (`<think>`, `<thinking>`, `<analysis>`, `<reasoning>` tags, OpenAI-style `reasoning`/`reasoning_content` fields, Gemini `thought: true` parts) never reaches deltas, final text, session history, or `error.partialText`, even when a leading tag is split across arbitrary chunk boundaries.
- `src/interview/latency-metrics.js` (`LatencyMetrics`) records bounded, content-free stage timestamps (speech end, transcript ready, question committed, first visible token, completion) per question, with a 10-slot active ring and a 50-slot completed ring, exposing `getSummary()` p50/p95 per stage. Wired into `session-controller.js` and `main.js`; sanitized before any log line via `src/core/logger.js`.
- `src/ui/interview-state.js`'s `viewState()` derives independent `turnLabel` (from `turnState`: idle/speaking/transcribing/waiting/ready) and `answerLabel` (from question state, including a Preparing-vs-Writing distinction based on whether any visible text has arrived yet) from a snapshot. `src/ui/interview-panel.js` renders `turnLabel` into a `#turnStatus` element, hidden unless capture is active.

`preload.js` exposes `interviewAction`, `getInterviewState`, `onInterviewState`, `reportInterviewCaptureLevel`, `reportInterviewCaptureState`.

Audio: `src/audio/capture.js` (renderer, `AudioCapture` class) + `src/audio/pcm-worklet.js` (AudioWorklet, 16 kHz mono PCM16, 320-sample/20 ms frames) are loaded in `index.html`/`chat.html` and wired up inside `src/ui/interview-panel.js`. Only the main window (`body.interview-shell`) actually owns the `AudioCapture` instance. Frames go out via `sendAudioChunk`/`audio-chunk` IPC into `speechService.handleAudioChunkFromRenderer`. `session.setDisplayMediaRequestHandler` (added in `main.js`'s `setupPermissions()`) makes the default system-audio path work via `desktopCapturer` + Windows loopback (`audio: 'loopback'`).

The legacy `_utteranceBuffer`/`_utteranceTimer`/`handleTranscriptionFragment()`/`dispatchCoalescedUtterance()`/`processTranscriptionWithLLM()` coalescing in `main.js`, called out as dead code in the previous version of this document, has been removed (2026-09-09 plan Task 3, Step 8) now that the turn detector and session controller are the only path.

## What's verified vs. not

**Verified deterministically** (`npm.cmd test`, run this session: 122/122
tests passed; `npm.cmd run check`, run this session: 51 files, 0 syntax
failures): the acoustic pause-timing table (continuous, natural pause,
boundary margin, slow second transcription rows; the separate-question row
lacks direct coverage), every reasoning-fixture case in the plan's Task 8
Step 3 (split tags at every character boundary, structured OpenAI/Gemini
reasoning, unclosed blocks, visible code containing literal tags, reasoning-
only output), latency stage math, and UI label derivation. Full row-by-row
mapping from plan requirement to specific test is in
`docs/testing/turn-detection-acceptance.md`.

**Verified live** this session (via `npm.cmd start -- --remote-debugging-port=9222` + raw CDP WebSocket calls, no Playwright installed locally):
- The main window still starts cleanly and `#turnStatus` (new in Task 7) exists in the DOM, `window.InterviewUI` loads, and rendering all five turn states through it produces the correct text/hidden/dataset output with zero JS exceptions. This was the one specific item flagged as unverified from Task 7 in the previous handover.
- This exercised a synthetic snapshot, not the real `interview-state` IPC broadcast, because no `.env` is configured in this worktree (the app opens to onboarding).

**Verified live in the 2026-09-08 session** (carried forward, not re-run this session): clean app startup, all 4 windows load correctly, main window's interview panel renders fully and correctly sized, Start listening reaches real system-audio capture via `getDisplayMedia` + loopback with a real Mistral transcription attempt logged, Pause cleanly stops capture.

**Not verified**: a live system-audio interview exercising the real turn detector end to end (Task 8 Step 5), real warm/cold latency samples (Task 8 Step 6, needs Step 5 plus a configured, live-answering provider), a packaged Windows build (Task 8 Step 7, `npm.cmd run build:win` intentionally not run), microphone source path live, retry/stop-answer/multi-question queueing live, `chat.html`/`llm-response.html`/`settings.html` visual states, long-session history list scrolling/collapse, real audio fixture files (none exist yet; see `tests/fixtures/audio/README.md`).

If continuing in a fresh session: reuse the CDP approach if Playwright isn't installed. `npm.cmd start -- --remote-debugging-port=9222` in the background, `curl http://localhost:9222/json` to list window targets, then open a raw `WebSocket` (Node 22+ has it built in) to a target's `webSocketDebuggerUrl` and send `Runtime.evaluate`/`Page.captureScreenshot` CDP commands. **Always `taskkill //F //IM electron.exe //T` before relaunching**: this app has a single-instance lock, so a stale running instance will just focus itself and your new process will exit immediately without loading your code changes.

## Continuation

Tasks 1 through 7 of the turn detection and visible answers plan are
implemented, tested, and committed. Task 8's deterministic and documentation
work is done. The concrete remaining work, in priority order, is what Task 8
could not do in this environment:

1. Record the five audio fixtures listed in `tests/fixtures/audio/README.md` (16 kHz mono PCM16 WAV, non-personal/synthetic voice) so Step 2's pause-scenario table has real recorded coverage instead of only simulated-clock coverage.
2. Add a deterministic test for the "separate question" row (a full 4.0 s silence deadline firing with no further speech, followed by a second independent turn) so Task 8 Step 2's table is fully covered by automated tests; see `docs/testing/turn-detection-acceptance.md`'s Step 2 section for exactly what is and is not covered today.
3. Run Task 8 Step 5 on real Windows hardware with a configured `.env` (a provider, a speech adapter, and system audio available): play a two-part question with a two-second pause, confirm one combined question appears, confirm no answer starts before the second segment and no reasoning tag appears, and use Answer now once to verify the immediate bypass.
4. Collect Task 8 Step 6's 20+ warm and 5+ cold latency samples from that same live setup, using `LatencyMetrics.getSummary()` (already implemented and tested) to report p50/p95 transcription, endpoint wait, first visible token, and total latency, with the hardware, provider, and model recorded alongside.
5. Only after 1-4, run Task 8 Step 7: `npm.cmd run build:win`, then manually verify the audio worklet, prompts, loopback capture, selected provider, and visible-answer filter from a clean profile.
6. Once Task 8 fully passes, the plan's own follow-up backlog (transcript confidence/correction, audio setup diagnostics, concise-first controls, interview profile context, optional provider fallback, packaged end-to-end automation) becomes available; each needs its own design.

Record checks that require hardware, credentials, or a real interview session as unverified if the environment cannot perform them, the same way this handover and `docs/testing/turn-detection-acceptance.md` do.
Update this file and progress.md with actual commands, outcomes, limitations, and exact remaining work before handing off again.
