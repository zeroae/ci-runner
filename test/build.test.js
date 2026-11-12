'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, LIMIT } = require('../scripts/build-template.js');

const root = path.join(__dirname, '..');

// Each ZipFile the build writes, decoded: [{ indent, code }].
const zipFiles = (out) => [...out.matchAll(/^( *)ZipFile: (".*")$/gm)].map((m) => ({ indent: m[1], code: JSON.parse(m[2]) }));

// Runs inlined code the way Lambda would: as index.js, with nothing beside it.
function load(code) {
  const mod = { exports: {} };
  const req = (id) => { if (id.startsWith('.')) throw new Error(`no ${id} beside index.js`); return require(id); };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return mod.exports;
}

test('an inline marker and its ZipFile line become one double-quoted ZipFile string', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tpl-'));
  const src = "'use strict';\n\nexports.handler = () => \"a\\\\b\";\n";
  fs.writeFileSync(path.join(dir, 'f.js'), src);
  fs.writeFileSync(path.join(dir, 't.yaml'), 'A:\n  Code:\n    ZipFile: |\n      //@inline f.js\nB: 2\n');
  const out = build(path.join(dir, 't.yaml'));
  assert.equal(out.split('\n').length, 5, 'one line for the code');
  assert.deepEqual(zipFiles(out), [{ indent: '    ', code: src.replace(/\n$/, '') }]);
  assert.match(out, /\nB: 2\n$/);
  assert.equal(load(zipFiles(out)[0].code).handler(), 'a\\b');
});

test('an inlined file\'s local require() is bundled in, so the result runs on its own', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tpl-'));
  fs.writeFileSync(path.join(dir, 'lib.js'), "'use strict';\nconst secret = 41;\nmodule.exports = { answer: () => secret + 1 };\n");
  fs.writeFileSync(path.join(dir, 'f.js'), "'use strict';\nconst { answer } = require('./lib.js');\nconst secret = 'x';\nexports.value = answer() + secret;\n");
  fs.writeFileSync(path.join(dir, 't.yaml'), 'A:\n  ZipFile: |\n    //@inline f.js\n');
  const [{ code }] = zipFiles(build(path.join(dir, 't.yaml')));
  assert.equal(load(code).value, '42x');
});

test('whole-line // comments are dropped, but not inside a template literal', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tpl-'));
  const src = "'use strict';\n// a comment, with a ` in it\n  // indented\nconst t = `a\n// kept: part of the string\nb`;\nexports.t = t; // trailing stays\n";
  fs.writeFileSync(path.join(dir, 'f.js'), src);
  fs.writeFileSync(path.join(dir, 't.yaml'), 'A:\n  ZipFile: |\n    //@inline f.js\n');
  const [{ code }] = zipFiles(build(path.join(dir, 't.yaml')));
  assert.equal(code, "'use strict';\nconst t = `a\n// kept: part of the string\nb`;\nexports.t = t; // trailing stays");
  assert.equal(load(code).t, 'a\n// kept: part of the string\nb');
});

test('the real template embeds every function, each runnable alone, under the inline size limit', () => {
  const out = build(path.join(root, 'template.yaml'));
  assert.doesNotMatch(out, /^ *\/\/@inline /m);
  const zips = zipFiles(out);
  assert.equal(zips.length, (fs.readFileSync(path.join(root, 'template.yaml'), 'utf8').match(/^ *\/\/@inline /gm) || []).length);
  for (const fn of ['setup', 'webhook', 'launcher', 'sweeper']) {
    // The function's own resource: from its FunctionName to the next resource.
    const own = out.split(`FunctionName: !Sub "\${AWS::StackName}-${fn}"`)[1].split(/\n  \w+:\n    Type: /)[0];
    const [zip] = zipFiles(own);
    assert.ok(zip, `${fn} not inlined`);
    assert.equal(typeof load(zip.code).handler, 'function', `${fn} has no handler when inlined`);
  }
  assert.equal(LIMIT, 51200);
  assert.ok(Buffer.byteLength(out) < LIMIT);
});
