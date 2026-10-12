// Makes sure node_modules/electron contains the actual Electron app.
//
// Two things can leave it empty on a Mac with a recent Node.js:
//   1. Newer npm versions block package install scripts, so Electron's downloader never runs.
//   2. Electron's downloader unpacks with an old zip library that silently fails on Node 26,
//      leaving only a license file behind.
// This step runs the downloader if needed and then unpacks the downloaded zip with macOS's own
// `ditto`, which always works.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const PLATFORM_PATH = 'Electron.app/Contents/MacOS/Electron';

function installed() {
  return fs.existsSync(path.join(electronDir, 'dist', PLATFORM_PATH))
    && fs.existsSync(path.join(electronDir, 'path.txt'));
}

function findCachedZip(version, arch) {
  const name = `electron-v${version}-darwin-${arch}.zip`;
  const roots = [
    process.env.electron_config_cache,
    process.env.ELECTRON_CACHE,
    path.join(os.homedir(), 'Library', 'Caches', 'electron'),
  ].filter(Boolean);
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === name) return full;
      }
    }
  }
  return null;
}

async function run() {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(electronDir)) throw new Error('node_modules/electron is missing. Run `npm install` again.');
  if (installed()) {
    console.log('✓ Electron is installed');
    return;
  }

  const version = require(path.join(electronDir, 'package.json')).version;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  let zip = findCachedZip(version, arch);
  if (!zip) {
    console.log(`Downloading Electron ${version}…`);
    // Electron's own downloader puts the zip in the cache (and may fail to unpack it; that's fine).
    spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { cwd: electronDir, stdio: 'inherit', env: process.env });
    if (installed()) {
      console.log('✓ Electron is installed');
      return;
    }
    zip = findCachedZip(version, arch);
  }
  if (!zip) {
    throw new Error(`Couldn't download Electron ${version}. Check the internet connection and run \`npm run setup:electron\`.`);
  }

  const dist = path.join(electronDir, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const result = spawnSync('ditto', ['-x', '-k', zip, dist], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Couldn't unpack ${zip}.`);
  fs.writeFileSync(path.join(electronDir, 'path.txt'), PLATFORM_PATH);
  if (!installed()) throw new Error('Electron was unpacked but the app is still missing.');
  console.log('✓ Electron is installed');
}

module.exports = { run };
if (require.main === module) run().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
