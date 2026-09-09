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
Branch: `feat/openrouter-provider`, currently at commit `4f51ee0` ("docs: fix
stale Task 3 citation, record separate-question coverage") — the tip
immediately after the final whole-branch review's fix pass (five findings;
see `2f63a3f..4f51ee0` and, for the full narrative, the (gitignored)
`.superpowers/sdd/final-review-fix-report.md`). This update to handover.md
is itself one more commit on top of `4f51ee0`; `git log --oneline -1` will
show that commit's own SHA, one ahead of what's named here.
Existing uncommitted work belongs to the user and must remain intact.
Node is installed; use `npm.cmd` rather than `npm` in PowerShell.
No pushes or releases have been made by this implementation.

If you are picking this up in a worktree, confirm your branch actually
contains `4f51ee0` (`git log --oneline -1`) before trusting any file in this
repository against what this handover describes. Prior to that, this session
found its own worktree branch had silently fallen 25 commits behind
`feat/openrouter-provider` (missing all of Tasks 1-7 of the 2026-09-09 plan)
and had to fast-forward (`git merge --ff-only feat/openrouter-provider`)
before any of the source files this document references actually existed on
disk.

## Current architecture (as of this session, commit `4f51ee0`)

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

## Final whole-branch review fix pass (commits `2f63a3f..4f51ee0`)

Five findings from the final review that gated finishing this branch were
fixed after Task 8 landed. Full detail (including git-history findings on
the pre-plan mic/shortcut calling convention) is in the gitignored
`.superpowers/sdd/final-review-fix-report.md`; summary:

1. **Critical**: the main overlay mic button, chat window mic control, and
   the Alt+Shift+R shortcut all captured speech outside the interview flow
   (no active `_interviewCaptureSessionId`), so `main.js`'s `transcription`
   handler silently dropped their transcripts instead of answering them.
   Added `ApplicationController.processVoiceTranscription()`, restoring the
   pre-interview-flow answer path (`llmService.processTranscriptionWithIntelligentResponseStream`
   -> `shouldShowVoiceOverlay()` / `sendTranscriptionLLMResponseToVoiceTargets()`).
2. `speech.service.js`'s `_endUtteranceFlush()` (and `_settleActiveSpeech`'s
   sibling NO_SPEECH branch) stamped `speechEndedAt` as `Date.now()` from
   inside a hangover-gated flush, making the real auto-answer silence
   window ~3700ms instead of the documented 3000ms. Both now back out
   `_getSilenceHangoverMs()` at their hangover-gated call sites only.
3. `session-controller.js`'s `noteTranscriptionSettled()` could lose
   `transcriptReadyAt` when a slow transcription's settle synchronously
   drove the turn detector straight through `ready` -> `submit()` before
   the mark was set. Moved the stamp to before delegating to the turn
   detector.
4. `progress.md`'s Task 3 row cited `src/ui/settings-window.js`, which was
   never touched by that task. Corrected.
5. `getAutoAnswerSilenceMs()` silently collapsed any explicit
   `AUTO_ANSWER_SILENCE_MS` outside the three UI presets to 3000. Extracted
   into `src/core/auto-answer-config.js`; now honors any explicit positive
   value (clamped 1000-10000ms), keeping the preset-only constraint scoped
   to the settings UI dropdown only.

Also added the previously-missing "separate question" acceptance test
(`tests/interview-session.test.js`) and closed that gap in
`docs/testing/turn-detection-acceptance.md`. `npm.cmd test` is now
131/131; `npm.cmd run check` is 53 files, 0 failures.

## What's verified vs. not

**Verified deterministically** (`npm.cmd test`, run this session: 131/131
tests passed; `npm.cmd run check`, run this session: 53 files, 0 syntax
failures): the acoustic pause-timing table (continuous, natural pause,
boundary margin, slow second transcription, and separate-question rows, all
five with direct coverage), every reasoning-fixture case in the plan's Task 8
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
2. Run Task 8 Step 5 on real Windows hardware with a configured `.env` (a provider, a speech adapter, and system audio available): play a two-part question with a two-second pause, confirm one combined question appears, confirm no answer starts before the second segment and no reasoning tag appears, and use Answer now once to verify the immediate bypass. This should also exercise the restored mic-button/shortcut standalone answer path (finding 1 above) live, since it was only unit-level verified.
3. Collect Task 8 Step 6's 20+ warm and 5+ cold latency samples from that same live setup, using `LatencyMetrics.getSummary()` (already implemented and tested) to report p50/p95 transcription, endpoint wait, first visible token, and total latency, with the hardware, provider, and model recorded alongside.
4. Only after 1-3, run Task 8 Step 7: `npm.cmd run build:win`, then manually verify the audio worklet, prompts, loopback capture, selected provider, and visible-answer filter from a clean profile.
5. Once Task 8 fully passes, the plan's own follow-up backlog (transcript confidence/correction, audio setup diagnostics, concise-first controls, interview profile context, optional provider fallback, packaged end-to-end automation) becomes available; each needs its own design.

Record checks that require hardware, credentials, or a real interview session as unverified if the environment cannot perform them, the same way this handover and `docs/testing/turn-detection-acceptance.md` do.
Update this file and progress.md with actual commands, outcomes, limitations, and exact remaining work before handing off again.
