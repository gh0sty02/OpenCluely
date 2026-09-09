'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const files = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.venv-whisper', '.whisper-models', '.superpowers', 'bin'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.name.endsWith('.js')) files.push(file);
  }
}
collect(root);
let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr || result.error?.message); failures++; }
}
console.log(`Syntax checked ${files.length} JavaScript files; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
