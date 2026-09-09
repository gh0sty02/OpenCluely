'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { promptLoader } = require('../prompt-loader');

test('default interview policy covers question structures and does not invent a biography', () => {
  const messages = promptLoader.composeMessages({ text: 'How does an LLM work?', programmingLanguage: 'cpp' });
  const prompt = messages[0].content;
  assert.match(prompt, /conceptual/i);
  assert.match(prompt, /system design/i);
  assert.match(prompt, /behavioral/i);
  assert.match(prompt, /never invent/i);
  assert.match(prompt, /only.*code/i);
  assert.doesNotMatch(prompt, /Respond ONLY in C\+\+/);
  assert.equal(messages.at(-1).content, 'How does an LLM work?');
});

test('preserves follow-up context and excludes only the current pending duplicate', () => {
  const history = [{ role: 'user', content: 'How does an LLM work?' }, { role: 'model', content: 'It predicts tokens using attention.' }, { role: 'user', content: 'How is it trained?' }];
  const messages = promptLoader.composeMessages({ text: 'How is it trained?', history });
  assert.equal(messages.filter(m => m.content === 'How is it trained?').length, 1);
  assert.equal(messages[2].role, 'assistant');
  assert.equal(history.length, 3);
});

test('deliberately repeated questions remain in previous completed turns', () => {
  const history = [{ role: 'user', content: 'Why?' }, { role: 'assistant', content: 'Earlier answer.' }];
  const messages = promptLoader.composeMessages({ text: 'Why?', history });
  assert.equal(messages.filter(m => m.content === 'Why?').length, 2);
});

test('history stays within input budget and oversized current questions fail visibly', () => {
  const history = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: ` + 'context '.repeat(100) }));
  const messages = promptLoader.composeMessages({ text: 'What tradeoffs?', history, inputBudgetTokens: 4096 });
  assert.ok(messages.length < history.length);
  assert.ok(promptLoader.estimateMessagesTokens(messages) <= Math.floor(4096 * 0.8));
  assert.equal(messages.at(-1).content, 'What tradeoffs?');
  assert.throws(() => promptLoader.composeMessages({ text: 'x'.repeat(10000), inputBudgetTokens: 4096 }), { code: 'CONTEXT_TOO_LONG' });
});

test('new and existing modes remain available', () => {
  const skills = promptLoader.getAvailableSkills();
  for (const skill of ['interview', 'general', 'behavioral', 'dsa', 'programming', 'system-design', 'code-explanation', 'aptitude']) assert.ok(skills.includes(skill));
});
