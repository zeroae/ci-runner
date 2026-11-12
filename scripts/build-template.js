'use strict';
// Builds build/template.yaml from template.yaml. Each pair of lines
//   <indent>ZipFile: |
//   <indent+2>//@inline <file>
// becomes one line, `<indent>ZipFile: "<file as a JSON string>"`, which YAML
// reads as the same text: a double-quoted scalar is a superset of a JSON
// string. It saves the block's indentation on every line of code. Paths are
// relative to the template. A local `require('./x.js')` in an inlined file is
// replaced by x.js itself, wrapped as a module, so one Lambda can share
// another file (the launcher bundles cloud-config.js), and whole-line `//`
// comments are dropped. Fails if the result is
// not under LIMIT bytes, the largest template `aws cloudformation deploy`
// sends inline.
const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 51200;
const LOCAL_REQUIRE = /require\('\.\/([\w.-]+\.js)'\)/;

// Whole-line `//` comments go, except inside a template literal (tracked by
// counting backticks on the lines kept).
function dropComments(lines) {
  let inLiteral = false;
  return lines.filter((line) => {
    if (!inLiteral && /^\s*\/\//.test(line)) return false;
    if ((line.match(/`/g) || []).length % 2) inLiteral = !inLiteral;
    return true;
  });
}

function bundle(file) {
  return dropComments(fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')).map((line) => {
    const m = LOCAL_REQUIRE.exec(line);
    if (!m) return line;
    const dep = bundle(path.join(path.dirname(file), m[1]));
    return line.slice(0, m.index)
      + `((module) => ((exports) => {\n${dep}\nreturn module.exports;\n})(module.exports))({ exports: {} })`
      + line.slice(m.index + m[0].length);
  }).join('\n');
}

const ZIPFILE = /^( *)ZipFile: \|\n *\/\/@inline (\S+)[ \t]*$/gm;

function build(templatePath) {
  const dir = path.dirname(templatePath);
  return fs.readFileSync(templatePath, 'utf8')
    .replace(ZIPFILE, (_, indent, file) => `${indent}ZipFile: ${JSON.stringify(bundle(path.join(dir, file)))}`);
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
