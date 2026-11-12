'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, LIMIT } = require('../scripts/build-template.js');

const root = path.join(__dirname, '..');

test('an inline marker is replaced by the file, indented to the marker', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tpl-'));
  fs.writeFileSync(path.join(dir, 'f.js'), "'use strict';\n\nexports.handler = 1;\n");
  fs.writeFileSync(path.join(dir, 't.yaml'), 'A:\n  ZipFile: |\n    //@inline f.js\nB: 2\n');
  assert.equal(build(path.join(dir, 't.yaml')),
    "A:\n  ZipFile: |\n    'use strict';\n\n    exports.handler = 1;\nB: 2\n");
});

test('an inlined file\'s local require() is bundled in, so the result runs on its own', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tpl-'));
  fs.writeFileSync(path.join(dir, 'lib.js'), "'use strict';\nconst secret = 41;\nmodule.exports = { answer: () => secret + 1 };\n");
  fs.writeFileSync(path.join(dir, 'f.js'), "'use strict';\nconst { answer } = require('./lib.js');\nconst secret = 'x';\nexports.value = answer() + secret;\n");
  fs.writeFileSync(path.join(dir, 't.yaml'), 'A:\n  ZipFile: |\n    //@inline f.js\n');
  const code = build(path.join(dir, 't.yaml')).split('\n').slice(2).map((l) => l.replace(/^ {4}/, '')).join('\n');
  assert.doesNotMatch(code, /require\('\.\/lib\.js'\)/);
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, () => { throw new Error('no require'); });
  assert.equal(mod.exports.value, '42x');
});

test('the real template embeds every function and is under the inline size limit', () => {
  const out = build(path.join(root, 'template.yaml'));
  assert.doesNotMatch(out, /^ *\/\/@inline /m);
  for (const fn of ['setup', 'webhook', 'launcher', 'sweeper']) {
    const firstCodeLine = fs.readFileSync(path.join(root, 'functions', `${fn}.js`), 'utf8').split('\n')[2];
    assert.ok(out.includes(firstCodeLine.trim()), `${fn} not inlined`);
  }
  assert.equal(LIMIT, 51200);
  assert.ok(Buffer.byteLength(out) < LIMIT);
});
