// electron-builder "afterSign" hook.
//
// Without a Developer ID certificate, electron-builder skips signing on macOS. The app then keeps
// Electron's original signature, which is broken by renaming the app and editing Info.plist.
// macOS ties Screen Recording permission to the signature, so a broken one means the
// permission never sticks. This hook gives such builds a valid ad-hoc signature instead.
// Builds that were properly signed are left alone.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' });
    console.log('  • signature is valid, leaving it as is');
    return;
  } catch {
    // not signed, or the signature is broken: fall through and sign ad-hoc
  }

  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
