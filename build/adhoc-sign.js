// electron-builder "afterPack" hook for macOS: signs the app.
//
// With the Loupe signing certificate (GitHub sets LOUPE_SIGN_IDENTITY and LOUPE_KEYCHAIN when the
// repository has the certificate secrets), every version is signed by the same certificate, so
// macOS sees updates as the same app and keeps its Screen Recording and Accessibility permissions. Without it the app
// gets an ad-hoc ("local") signature, which differs per build: macOS then asks for the
// permission again after each update.
//
// It runs as afterPack rather than afterSign, because electron-builder skips afterSign when it
// has no Developer ID certificate to sign with.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return MACHO_MAGICS.has(buf.readUInt32BE(0));
  } catch (_) {
    return false;
  }
}

function findMachO(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) findMachO(full, found);
    else if (isMachO(full)) found.push(full);
  }
  return found;
}

const IDENTITY = process.env.LOUPE_SIGN_IDENTITY || '-';   // '-' means ad hoc
const KEYCHAIN = process.env.LOUPE_KEYCHAIN || '';

function signArgs(extra = []) {
  const args = ['--force', '--sign', IDENTITY, ...extra];
  if (IDENTITY !== '-' && KEYCHAIN) args.push('--keychain', KEYCHAIN);
  return args;
}

function sign(file) {
  execFileSync('codesign', [...signArgs(), file], { stdio: 'inherit' });
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A universal build packs an Intel and an Apple Silicon copy in "-temp" folders and then merges
  // them. Signing those halves would break the merge, so only sign the merged app.
  if (/-temp$/.test(context.appOutDir)) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • signing ${appPath} ${IDENTITY === '-' ? 'ad hoc (no Loupe signing certificate available)' : 'with the Loupe signing certificate'}`);

  // --deep doesn't reach native modules (.node files, like uiohook-napi) inside Resources/app.
  // Apple Silicon refuses to load unsigned native code, so sign those first. Prebuilds for
  // Windows and Linux are in the same folder but aren't Mach-O, so they're skipped.
  const resources = path.join(appPath, 'Contents', 'Resources');
  const machO = findMachO(resources);
  machO.sort((a, b) => Number(b.endsWith('.dylib') || b.endsWith('.node')) - Number(a.endsWith('.dylib') || a.endsWith('.node')));
  for (const file of machO) sign(file);

  execFileSync('codesign', [...signArgs(['--deep']), appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  // The "designated requirement" is what macOS remembers permissions by. With the certificate it
  // names the certificate, so it's identical for every version.
  const requirement = execFileSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`  • signature is valid (${machO.length} extra binaries signed)`);
  console.log(`  • ${requirement.trim().split('\n').pop()}`);
};
