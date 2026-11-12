'use strict';
// Builds build/template.yaml from template.yaml: every line `<indent>//@inline <file>`
// (inside a `ZipFile: |` block) is replaced by that file, each line indented to
// match. Paths are relative to the template. A local `require('./x.js')` in an
// inlined file is replaced by x.js itself, wrapped as a module, so one Lambda
// can share another file (the launcher bundles cloud-config.js). Fails if the result is not under
// LIMIT bytes, the largest template `aws cloudformation deploy` sends inline.
const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 51200;
const MARKER = /^( *)\/\/@inline (\S+)\s*$/;
const LOCAL_REQUIRE = /require\('\.\/([\w.-]+\.js)'\)/;

function bundle(file) {
  return fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').map((line) => {
    const m = LOCAL_REQUIRE.exec(line);
    if (!m) return line;
    const dep = bundle(path.join(path.dirname(file), m[1]));
    return line.slice(0, m.index)
      + `((module) => ((exports) => {\n${dep}\nreturn module.exports;\n})(module.exports))({ exports: {} })`
      + line.slice(m.index + m[0].length);
  }).join('\n');
}

function build(templatePath) {
  const dir = path.dirname(templatePath);
  return fs.readFileSync(templatePath, 'utf8').split('\n').map((line) => {
    const m = MARKER.exec(line);
    if (!m) return line;
    const code = bundle(path.join(dir, m[2]));
    return code.split('\n').map((l) => (l ? m[1] + l : l)).join('\n');
  }).join('\n');
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const out = build(path.join(root, 'template.yaml'));
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'template.yaml'), out);
  const size = Buffer.byteLength(out);
  console.log(`build/template.yaml: ${size} of ${LIMIT} bytes (${Math.round((100 * size) / LIMIT)}%)`);
  if (size >= LIMIT) { console.error('template is over the limit'); process.exit(1); }
}

module.exports = { build, LIMIT };
