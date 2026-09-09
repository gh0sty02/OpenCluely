'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const VisibleAnswerFilter = require('../src/services/visible-answer-filter');

test('removes a think block when both tags are split across chunks', () => {
  const filter = new VisibleAnswerFilter();
  assert.equal(filter.push('<thi'), '');
  assert.equal(filter.push('nk>private chain</thi'), '');
  assert.equal(filter.push('nk>\n\nPublic answer'), 'Public answer');
  assert.equal(filter.finish(), '');
});

test('recognizes every supported tag across every opening and closing split', () => {
  for (const tag of ['think', 'thinking', 'analysis', 'reasoning']) {
    const opening = `<${tag}>`;
    const closing = `</${tag}>`;
    for (let openingSplit = 1; openingSplit < opening.length; openingSplit++) {
      for (let closingSplit = 1; closingSplit < closing.length; closingSplit++) {
        const filter = new VisibleAnswerFilter();
        assert.equal(filter.push(opening.slice(0, openingSplit)), '');
        assert.equal(filter.push(opening.slice(openingSplit) + 'private' + closing.slice(0, closingSplit)), '');
        assert.equal(filter.push(closing.slice(closingSplit) + 'Answer'), 'Answer');
        assert.equal(filter.finish(), '');
      }
    }
  }
});

test('preserves tags after visible prose or a visible code fence', () => {
  const prose = new VisibleAnswerFilter();
  assert.equal(prose.push('Use `<think>` as text.'), 'Use `<think>` as text.');
  assert.equal(prose.finish(), '');

  const codeText = '```xml\n<think>example</think>\n```';
  const code = new VisibleAnswerFilter();
  assert.equal(code.push(codeText), codeText);
  assert.equal(code.finish(), '');
});

test('removes every supported leading reasoning tag case-insensitively', () => {
  for (const tag of ['think', 'thinking', 'analysis', 'reasoning']) {
    const filter = new VisibleAnswerFilter();
    const upper = tag.toUpperCase();
    assert.equal(filter.push(`  <${upper}>hidden</${upper}>\nAnswer`), 'Answer');
    assert.equal(filter.finish(), '');
  }
});

test('removes multiple leading blocks and preserves later literal tags', () => {
  const filter = new VisibleAnswerFilter();
  assert.equal(filter.push('\n<think>one</think>\n<analysis>two</analysis>\nResult with <think>literal</think>'),
    'Result with <think>literal</think>');
  assert.equal(filter.finish(), '');
});

test('discards unclosed and reasoning-only hidden content at EOF', () => {
  const unclosed = new VisibleAnswerFilter();
  assert.equal(unclosed.push('<reasoning>private forever'), '');
  assert.equal(unclosed.finish(), '');

  const closed = new VisibleAnswerFilter();
  assert.equal(closed.push('<thinking>private</thinking>'), '');
  assert.equal(closed.finish(), '');
});

test('discards hidden blocks larger than 64 KiB without releasing private text', () => {
  const filter = new VisibleAnswerFilter();
  assert.equal(filter.push('<analysis>'), '');
  for (let index = 0; index < 80; index++) assert.equal(filter.push('private'.repeat(1024)), '');
  assert.equal(filter.push('</analysis>Visible'), 'Visible');
  assert.equal(filter.finish(), '');
});

test('releases an incomplete opening-tag prefix as visible text at EOF', () => {
  const filter = new VisibleAnswerFilter();
  assert.equal(filter.push('<thi'), '');
  assert.equal(filter.finish(), '<thi');
});
