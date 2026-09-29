// electron-builder "afterPack" hook for macOS.
//
// Without a Developer ID certificate, electron-builder doesn't sign the app at all. The app then
// keeps Electron's original signature, which is broken by renaming the app and editing its
// Info.plist, and macOS can't tie permissions such as Screen Recording to it. This hook gives the
// app a valid ad-hoc ("local") signature instead.
//
// It runs as afterPack rather than afterSign, because electron-builder skips afterSign when it
// had no certificate to sign with. If a certificate is available, electron-builder still signs
// the app properly afterwards, replacing this ad-hoc signature.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findNativeModules(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) findNativeModules(full, found);
    else if (entry.name.endsWith('.node')) found.push(full);
  }
  return found;
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A universal build packs an Intel and an Apple Silicon copy in "-temp" folders and then merges
  // them. Signing those halves would break the merge, so only sign the merged app.
  if (/-temp$/.test(context.appOutDir)) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${appPath}`);

  // Apple Silicon refuses to load native code that has no signature at all, and --deep doesn't
  // reach native modules inside the app's resources, so sign those first.
  const resources = path.join(appPath, 'Contents', 'Resources');
  for (const file of findNativeModules(resources)) {
    if (!/darwin/.test(file)) continue; // only macOS binaries; Windows/Linux ones are just data here
    execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'inherit' });
  }

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log('  • ad-hoc signature is valid');
};
