'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const target = path.resolve(root, 'dist');
if (path.dirname(target) !== root) throw new Error('Refusing to clean outside the repository.');
fs.rmSync(target, { recursive: true, force: true });
