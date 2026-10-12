// Checks that a built Loupe.app contains every file the app loads, so a file left out of
// "files" in package.json fails the build instead of quietly breaking the installed app.
//
//   node build/check-packaged.js dist/mac-universal/Loupe.app

const fs = require('fs');
const path = require('path');

const appBundle = process.argv[2];
if (!appBundle) { console.error('Usage: node build/check-packaged.js <path to Loupe.app>'); process.exit(2); }
const appDir = path.join(appBundle, 'Contents', 'Resources', 'app');
const root = path.join(__dirname, '..');

const needed = new Set(['package.json', 'main.js']);
const visit = (rel) => {
  const file = path.join(root, rel);
  if (!fs.existsSync(file) || !/\.(js|html)$/.test(rel)) return;
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(rel);
  // path.join(__dirname, 'a', 'b') in JS files
  for (const m of src.matchAll(/path\.join\(__dirname,\s*((?:'[^']+'\s*,?\s*)+)\)/g)) {
    const parts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const target = path.normalize(path.join(dir, ...parts));
    if (!target.startsWith('..')) add(target);
  }
  // require('./x') and require('../x')
  for (const m of src.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
    let target = path.normalize(path.join(dir, m[1]));
    if (!path.extname(target)) target += '.js'; // require('./x') means x.js; require('./x.json') is as written
    add(target);
  }
  // <script src="x">, <link href="x"> and <img src="x"> in HTML
  for (const m of src.matchAll(/(?:src|href)="([^":]+\.(?:js|css|png|svg))"/g)) add(path.normalize(path.join(dir, m[1])));
};
const add = (rel) => { if (!needed.has(rel)) { needed.add(rel); visit(rel); } };
visit('main.js');

// Modules from node_modules that the app requires at run time (asar is off, so they're plain files).
const modules = ['uiohook-napi', 'tesseract.js', 'mediabunny'];

let missing = 0;
for (const rel of [...needed].sort()) {
  const ok = fs.existsSync(path.join(appDir, rel));
  if (!ok) missing++;
  console.log(`${ok ? '  ok      ' : '  MISSING '} ${rel}`);
}
for (const name of modules) {
  const ok = fs.existsSync(path.join(appDir, 'node_modules', name, 'package.json'));
  if (!ok) missing++;
  console.log(`${ok ? '  ok      ' : '  MISSING '} node_modules/${name}`);
}
// The global-hotkey helper for step capture needs its Mac prebuild (there's one per architecture
// or one universal file, depending on the uiohook-napi version).
const prebuilds = path.join(appDir, 'node_modules', 'uiohook-napi', 'prebuilds');
const macPrebuild = fs.existsSync(prebuilds) && fs.readdirSync(prebuilds).some((d) => /^darwin/.test(d));
if (!macPrebuild) missing++;
console.log(`${macPrebuild ? '  ok      ' : '  MISSING '} node_modules/uiohook-napi/prebuilds/darwin-*`);

if (missing) {
  console.error(`\n✗ ${missing} file(s) missing from the app. Add them to "files" in package.json.`);
  process.exit(1);
}
console.log(`\n✓ The app contains all ${needed.size + modules.length + 1} files it needs`);
