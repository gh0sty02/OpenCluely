(function (root) {
    'use strict';

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    // Only emit markup we own. Model output never supplies tags, URLs or attributes.
    function renderMarkdown(value) {
        const blocks = [];
        const text = String(value ?? '').replace(/(```|~~~)([^\n]*)\n([\s\S]*?)(?:\1|$)/g, (_, fence, language, code) => {
            const index = blocks.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`) - 1;
            return `\n\n\u0000${index}\u0000\n\n`;
        });
        const inline = value => escapeHtml(value)
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
        return text.split(/\n\s*\n/).filter(block => block.trim()).map(block => {
            const code = block.trim().match(/^\u0000(\d+)\u0000$/);
            if (code) return blocks[Number(code[1])] || '';
            const lines = block.split('\n');
            if (lines.every(line => /^\s*[-*+]\s+/.test(line))) {
                return `<ul>${lines.map(line => `<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('')}</ul>`;
            }
            if (lines.every(line => /^\s*\d+[.)]\s+/.test(line))) {
                return `<ol>${lines.map(line => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
            }
            return lines.map(line => {
                const heading = line.match(/^(#{1,4})\s+(.+)$/);
                return heading ? `<h${Math.min(heading[1].length + 1, 4)}>${inline(heading[2])}</h${Math.min(heading[1].length + 1, 4)}>` : `<p>${inline(line)}</p>`;
            }).join('');
        }).join('');
    }

    function viewState(snapshot = {}) {
        const questions = Array.isArray(snapshot.questions) ? snapshot.questions : [];
        const active = questions.find(question => question.id === snapshot.activeQuestionId);
        const current = active || questions[questions.length - 1] || null;
        const source = snapshot.source === 'microphone' ? 'microphone' : 'system audio';
        const labels = { idle: 'Audio off', starting: 'Preparing audio', listening: `Listening to ${source}`, paused: 'Capture paused', recovering: 'Reconnecting audio', error: 'Audio needs attention' };
        const answerLabels = { queued: 'Question queued', generating: 'Writing answer', completed: 'Answer ready', cancelled: 'Answer stopped', error: 'Answer needs attention', overflow: 'Queue full - submit when ready' };
        return {
            current,
            captureLabel: labels[snapshot.captureState] || labels.idle,
            answerLabel: current ? answerLabels[current.state] || 'Ready for a question' : 'Ready for a question',
            captureActive: ['starting', 'listening', 'recovering'].includes(snapshot.captureState),
            canAnswer: Boolean(snapshot.draft?.trim()),
            canStop: current?.state === 'generating',
            canRetry: Boolean(current && ['error', 'cancelled', 'completed', 'overflow'].includes(current.state)),
            level: Math.max(0, Math.min(1, Number(snapshot.level) || 0)),
            history: questions.filter(question => question !== current)
        };
    }

    function shouldFollow(element) {
        return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    }

    const api = { escapeHtml, renderMarkdown, viewState, shouldFollow };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.InterviewUI = api;
})(typeof window !== 'undefined' ? window : null);
