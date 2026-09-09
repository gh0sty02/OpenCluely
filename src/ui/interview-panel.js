(function () {
    'use strict';
    const api = window.electronAPI;
    const ui = window.InterviewUI;
    const defaultSilenceMs = 3000;
    const silencePresets = new Set([2500, 3000, 4500]);
    // Matches main process's getAutoAnswerSilenceMs() clamp range: any
    // explicit positive value is honored, not just the dropdown's three
    // named presets. Used when sending a value the main process already
    // holds (e.g. an env-configured custom silence window) so an unrelated
    // toggle (the auto-answer checkbox) can't silently collapse it to the
    // nearest preset.
    const clampSilenceMs = value => {
        const milliseconds = Number(value);
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) return defaultSilenceMs;
        return Math.min(10000, Math.max(1000, milliseconds));
    };
    if (!api?.getInterviewState || !ui) return;

    const panel = document.getElementById('interviewPanel');
    const strip = document.getElementById('interviewStrip');
    const host = panel || strip;
    if (!host) return;
    let snapshot = {};
    let editing = false;
    let renderedAnswer = '';
    let renderedQuestion = null;
    let historyKey = '';
    // Per-viewer UI preference, not app state: kept in localStorage rather
    // than the shared session snapshot so it doesn't reset when the window
    // reloads and doesn't need to round-trip through the main process.
    let historyHidden = false;
    try { historyHidden = localStorage.getItem('interviewHistoryHidden') === 'true'; } catch (_) { /* private/blocked storage */ }
    // Teleprompter-style auto-scroll: once the answer has been quiet (no new
    // streamed text) for a few seconds and the reader hasn't touched the
    // wheel recently, gently scroll toward the bottom so a long answer can
    // be read aloud hands-free. Any wheel input pauses it for the same idle
    // window before it resumes.
    let lastAnswerChangeAt = 0;
    let lastUserScrollAt = 0;

    // Only one renderer window may own the real audio capture (getDisplayMedia/
    // getUserMedia): the main overlay (body.interview-shell). Other windows
    // (chat.html, body.interview-chat) still dispatch start/pause/resume
    // through interviewAction — the coordinator's capture state just won't
    // reach 'listening' there because no capture is actually running.
    const ownsCapture = document.body.classList.contains('interview-shell') && typeof window.AudioCapture === 'function';
    const capture = ownsCapture ? new window.AudioCapture({
        onFrame: frame => api.sendAudioChunk?.(frame.pcm),
        onLevel: level => api.reportInterviewCaptureLevel?.(level),
        onState: state => api.reportInterviewCaptureState?.(state)
    }) : null;
    let capturedSessionId = null;
    function syncCapture(next) {
        if (!capture) return;
        const wantsCapture = ['starting', 'listening', 'recovering'].includes(next.captureState);
        if (wantsCapture && capturedSessionId !== next.sessionId) {
            capturedSessionId = next.sessionId;
            capture.start({ sessionId: next.sessionId, source: next.source }).catch(error => {
                api.reportInterviewCaptureState?.({ state: 'error', sessionId: next.sessionId, source: next.source, error: error.message });
            });
        } else if (!wantsCapture && capturedSessionId) {
            capturedSessionId = null;
            capture.stop();
        }
    }

    host.innerHTML = `
        <div class="interview-controls">
            <button class="interview-button primary" data-action="capture">Start listening</button>
            <label class="interview-source"><span class="sr-only">Audio source</span><select id="interviewSource"><option value="system">System audio</option><option value="microphone">Microphone</option></select></label>
            <label class="interview-source"><span class="sr-only">Listening mode</span><select id="interviewAutoAnswer"><option value="manual">Manual</option><option value="auto">Automatic</option></select></label>
            <label class="interview-source" id="interviewSilenceGapWrap"><span class="sr-only">Pause before answering</span><select id="interviewSilenceGap"><option value="2500">Responsive (2.5s)</option><option value="3000">Balanced (3s)</option><option value="4500">Patient (4.5s)</option></select></label>
            <meter id="interviewLevel" min="0" max="1" value="0" aria-label="Audio input level"></meter>
            ${panel ? '<button class="interview-button" data-action="end">End session</button><button class="interview-button" data-action="toggle-history">Hide history</button><button class="interview-button" data-action="settings">Settings</button>' : ''}
        </div>
        <div class="interview-status" role="status"><span id="captureStatus">Audio off</span><span id="turnStatus" hidden></span><span id="answerStatus">Ready for a question</span></div>
        ${panel ? `<div class="interview-mode-row"><label for="interviewMode">Answer style</label><select id="interviewMode"><option value="interview">Auto interview</option><option value="general">General</option><option value="system-design">System design</option><option value="dsa">Coding</option><option value="behavioral">Behavioral</option><option value="code-explanation">Code explanation</option><option value="aptitude">Aptitude</option></select></div>
        <p class="interview-notice" id="interviewNotice" role="alert" hidden></p>
        <section class="interview-question"><h2>Your question</h2><p id="interviewQuestion">Start listening to capture a question, or type one below.</p><textarea id="interviewEdit" aria-label="Edit question" rows="3" hidden></textarea><div class="interview-actions"><button class="interview-button" data-action="answer-now" disabled>Answer now</button><button class="interview-button" data-action="edit" disabled>Edit question</button><button class="interview-button" data-action="retry" disabled>Retry answer</button><button class="interview-button" data-action="stop-answer" disabled>Stop answer</button></div></section>
        <article class="interview-answer" id="interviewAnswer" aria-label="Interview answer"><p class="interview-empty">A clear opening, then the details you need.</p></article>
        <details class="interview-history" id="interviewHistoryBlock"><summary id="historySummary">Earlier questions (0)</summary><div id="interviewHistory"></div></details>` : ''}`;

    const find = id => document.getElementById(id);
    async function action(name, payload = {}) {
        try {
            const result = await api.interviewAction(name, payload);
            if (result?.error) throw new Error(result.error);
            if (result?.captureState) render(result);
        } catch (error) {
            const notice = find('interviewNotice');
            if (notice) { notice.hidden = false; notice.textContent = error.message || 'Action failed. Try again.'; }
        }
    }

    host.addEventListener('click', async event => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const current = ui.viewState(snapshot).current;
        const name = button.dataset.action;
        if (name === 'settings') { api.showSettings?.(); return; }
        if (name === 'toggle-history') {
            historyHidden = !historyHidden;
            try { localStorage.setItem('interviewHistoryHidden', String(historyHidden)); } catch (_) { /* private/blocked storage */ }
            render(snapshot);
            return;
        }
        if (name === 'capture') {
            await action(ui.viewState(snapshot).captureActive ? 'pause' : snapshot.captureState === 'paused' ? 'resume' : 'start');
        } else if (name === 'edit') {
            editing = !editing;
            find('interviewEdit').hidden = !editing;
            find('interviewQuestion').hidden = editing;
            button.textContent = editing ? 'Cancel edit' : 'Edit question';
            if (editing) { find('interviewEdit').value = snapshot.draft || current?.text || ''; find('interviewEdit').focus(); }
            render(snapshot);
        } else if (name === 'answer-now' && editing) {
            const text = find('interviewEdit').value.trim();
            if (!text) return;
            await action('submit', { text });
            editing = false;
            find('interviewEdit').hidden = true;
            find('interviewQuestion').hidden = false;
            host.querySelector('[data-action="edit"]').textContent = 'Edit question';
            render(snapshot);
        } else {
            await action(name, current ? { questionId: current.id } : {});
        }
    });

    find('interviewSource').addEventListener('change', async event => {
        const source = event.target.value;
        if (api.saveSettings) await api.saveSettings({ audioSource: source });
        else window.api?.send('save-settings', { audioSource: source });
    });
    find('interviewAutoAnswer').addEventListener('change', async event => {
        const enabled = event.target.value === 'auto';
        // Read the real current value from the snapshot, not the dropdown:
        // the dropdown may only be displaying a synthesized "Custom" option
        // for a non-preset value already in effect (e.g. from .env), and
        // this toggle must not clobber that value with a coerced preset.
        const silenceMs = clampSilenceMs(snapshot.autoAnswerSilenceMs);
        await action('set-auto-answer', { enabled, silenceMs });
    });
    find('interviewSilenceGap').addEventListener('change', async event => {
        const silenceMs = clampSilenceMs(event.target.value);
        await action('set-auto-answer', { enabled: true, silenceMs });
    });
    find('interviewMode')?.addEventListener('change', async event => {
        if (api.saveSettings) await api.saveSettings({ activeSkill: event.target.value });
        else window.api?.send('save-settings', { activeSkill: event.target.value });
    });

    function render(next) {
        snapshot = next || {};
        syncCapture(snapshot);
        const state = ui.viewState(snapshot);
        find('captureStatus').textContent = state.captureLabel;
        find('captureStatus').dataset.state = snapshot.captureState || 'idle';
        // The turn indicator only means something while capture is actually
        // running; hide it the rest of the time instead of echoing "Ready for
        // a question" next to an already-explicit "Audio off" capture label.
        const turnStatus = find('turnStatus');
        turnStatus.textContent = state.turnLabel;
        turnStatus.dataset.state = snapshot.turnState || 'idle';
        turnStatus.hidden = !state.captureActive;
        find('answerStatus').textContent = state.answerLabel + (snapshot.queueLength ? ` (${snapshot.queueLength} waiting)` : '');
        find('interviewLevel').value = state.level;
        find('interviewSource').value = snapshot.source || 'system';
        find('interviewSource').disabled = state.captureActive;
        find('interviewAutoAnswer').value = snapshot.autoAnswer ? 'auto' : 'manual';
        const silenceSelect = find('interviewSilenceGap');
        const currentSilenceMs = clampSilenceMs(snapshot.autoAnswerSilenceMs);
        let customOption = silenceSelect.querySelector('option[data-custom]');
        if (silencePresets.has(currentSilenceMs)) {
            customOption?.remove();
        } else {
            // A non-preset value is in effect (e.g. a custom AUTO_ANSWER_SILENCE_MS
            // from .env): represent it truthfully instead of silently displaying
            // the nearest preset, which would make the next unrelated toggle look
            // like it's clobbering a value the user never touched.
            if (!customOption) {
                customOption = document.createElement('option');
                customOption.dataset.custom = 'true';
                silenceSelect.appendChild(customOption);
            }
            customOption.value = String(currentSilenceMs);
            customOption.textContent = `Custom (${(currentSilenceMs / 1000).toFixed(1)}s)`;
        }
        silenceSelect.value = String(currentSilenceMs);
        find('interviewSilenceGapWrap').hidden = !snapshot.autoAnswer;
        host.querySelector('[data-action="capture"]').textContent = state.captureActive ? 'Pause listening' : snapshot.captureState === 'paused' ? 'Resume listening' : 'Start listening';
        if (!panel) return;
        find('interviewMode').value = snapshot.mode || 'interview';
        const current = state.current;
        const scrollArea = document.getElementById('interviewWorkspace') || panel;
        const follow = ui.shouldFollow(scrollArea);
        const answer = find('interviewAnswer');
        const selection = window.getSelection();
        const readingSelection = selection && !selection.isCollapsed && answer.contains(selection.anchorNode);
        find('interviewQuestion').textContent = snapshot.draft || current?.text || 'Start listening to capture a question, or type one below.';
        const notice = current?.error || snapshot.statusMessage || '';
        find('interviewNotice').textContent = notice;
        find('interviewNotice').hidden = !notice;
        host.querySelector('[data-action="answer-now"]').disabled = !editing && !state.canAnswer;
        host.querySelector('[data-action="edit"]').disabled = !current && !snapshot.draft;
        host.querySelector('[data-action="retry"]').disabled = !state.canRetry;
        host.querySelector('[data-action="stop-answer"]').disabled = !state.canStop;
        if (!readingSelection && (renderedAnswer !== (current?.answer || '') || renderedQuestion !== (current?.id || null))) {
            renderedAnswer = current?.answer || '';
            renderedQuestion = current?.id || null;
            answer.innerHTML = renderedAnswer ? ui.renderMarkdown(renderedAnswer) : '<p class="interview-empty">Your answer will appear here.</p>';
            lastAnswerChangeAt = Date.now();
        }
        const historyToggle = host.querySelector('[data-action="toggle-history"]');
        if (historyToggle) historyToggle.textContent = historyHidden ? 'Show history' : 'Hide history';
        find('interviewHistoryBlock').hidden = historyHidden;
        const nextHistoryKey = JSON.stringify(state.history.map(question => [question.id, question.state, question.answer]));
        if (historyKey !== nextHistoryKey) {
            historyKey = nextHistoryKey;
            find('historySummary').textContent = `Earlier questions (${state.history.length})`;
            find('interviewHistory').replaceChildren(...state.history.map(question => {
                const item = document.createElement('details');
                const title = document.createElement('summary');
                title.textContent = question.text;
                const body = document.createElement('div');
                body.className = 'interview-answer';
                body.innerHTML = ui.renderMarkdown(question.answer || question.error || question.state);
                item.append(title, body);
                return item;
            }));
        }
        if (follow && !readingSelection) scrollArea.scrollTop = scrollArea.scrollHeight;
    }

    if (panel) {
        const AUTO_SCROLL_IDLE_MS = 3000;
        const AUTO_SCROLL_PX_PER_SEC = 40;
        const teleprompterArea = document.getElementById('interviewWorkspace') || panel;
        teleprompterArea.addEventListener('wheel', () => { lastUserScrollAt = Date.now(); }, { passive: true });
        let lastTick = null;
        // The DOM's own scrollTop is integer-rounded, and at 40px/s each
        // frame's share is well under 1px — accumulating directly against
        // scrollTop rounds every increment straight back down to itself and
        // never visibly moves. Track the fractional position separately and
        // only round when assigning it.
        let fractionalScrollTop = null;
        const tick = now => {
            if (lastTick == null) lastTick = now;
            const dt = now - lastTick;
            lastTick = now;
            const idleLongEnough = lastAnswerChangeAt && Date.now() - lastAnswerChangeAt >= AUTO_SCROLL_IDLE_MS
                && Date.now() - lastUserScrollAt >= AUTO_SCROLL_IDLE_MS;
            const atBottom = teleprompterArea.scrollHeight - teleprompterArea.scrollTop - teleprompterArea.clientHeight < 2;
            const selection = window.getSelection();
            const readingSelection = selection && !selection.isCollapsed && teleprompterArea.contains(selection.anchorNode);
            if (idleLongEnough && !atBottom && !readingSelection) {
                if (fractionalScrollTop == null) fractionalScrollTop = teleprompterArea.scrollTop;
                fractionalScrollTop += (AUTO_SCROLL_PX_PER_SEC * dt) / 1000;
                teleprompterArea.scrollTop = fractionalScrollTop;
            } else {
                // Resync next time it engages, in case the user (or the
                // stick-to-bottom follow logic in render()) moved it while
                // paused.
                fractionalScrollTop = null;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) render(snapshot); });
    const compose = document.getElementById('interviewCompose');
    compose?.addEventListener('submit', async event => {
        event.preventDefault();
        const input = find('interviewTyped');
        const text = input.value.trim();
        if (!text) return;
        await action('submit', { text });
        input.value = '';
    });
    find('interviewTyped')?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); compose.requestSubmit(); }
    });
    api.onInterviewState((event, data) => render(data || event));
    api.getInterviewState().then(render).catch(() => {});
})();
