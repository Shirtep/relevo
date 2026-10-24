// Lists every string passed to t() (extension) and T() (webview), for checking translations.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [
  ...fs
    .readdirSync(path.join(root, 'src'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(root, 'src', f)),
  path.join(root, 'media', 'panel.js'),
];
// t('…'), t("…"), T('…'), T("…") with a literal first argument.
const re = /\b[tT]\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
const keys = new Set();
for (const file of files) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) {
    keys.add((m[1] ?? m[2]).replace(/\\(['"\\])/g, '$1'));
  }
}
// Effort names are looked up through a table in the webview.
for (const k of ['low', 'medium', 'high', 'extra high', 'max']) {
  keys.add(k);
}
module.exports = [...keys].sort();
if (require.main === module) {
  console.log(module.exports.join('\n'));
  console.log(`${module.exports.length} keys`);
}
