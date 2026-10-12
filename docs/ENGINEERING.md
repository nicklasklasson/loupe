# Loupe: engineering notes

How Loupe is built, signed, released and updated. The setup is a port of Quill's, and Quill's notes
are the fuller reference for the pipeline, signing and updater, including the gotchas:
https://github.com/nicklasklasson/quill/blob/main/docs/ENGINEERING.md

Repository: https://github.com/nicklasklasson/loupe (public). Written so a future session can pick
this up cold.

## Architecture in one paragraph

Electron app, tray/menu bar + Dock, `asar: false`. `main.js` holds everything in the main process:
settings (a JSON file in userData), the capture pipeline, every window, saving and the library.
Pages in `src/` talk to it through the small allow-listed bridge in `preload.js`. Native code:
`uiohook-napi` (global click hook for step capture; prebuilt `.node` files) and `tesseract.js`
(OCR, in-process, English and Swedish data in `assets/ocr`). Every capture is written to the
library and put on the clipboard *before* the editor window opens, which is why capture windows can
be closed freely as long as they're unedited.

## Release pipeline (same as Quill)

- `./release.sh` commits, pushes, tags `v<version from package.json>`, waits for GitHub Actions,
  reports whether the build was signed with the Loupe certificate, downloads the dmg and opens it.
- `.github/workflows/release.yml` on `macos-latest`: Node 22, `npm install` (postinstall runs
  `build/ensure-electron.js`), load the certificate from secrets `LOUPE_SIGNING_P12` /
  `LOUPE_SIGNING_PASSWORD`, `npm run dist:mac -- --publish never`, `build/check-packaged.js`,
  publish with `RELEASE_NOTES.md` as notes. The dmg is `Loupe-<version>-universal.dmg`; the
  updater relies on that name.
- `build/adhoc-sign.js` (`afterPack`): signs every Mach-O under `Contents/Resources` first (the
  `uiohook-napi` prebuilds for darwin; the Windows/Linux ones aren't Mach-O and are skipped), then
  the app with `--deep`, and logs the designated requirement. Env `LOUPE_SIGN_IDENTITY` /
  `LOUPE_KEYCHAIN`; ad hoc without them.
- `build/check-packaged.js`: walks `main.js` for `path.join(__dirname, …)`, `require('./…')` and
  `src`/`href` in HTML, then checks the packaged app has each file plus `uiohook-napi`,
  `tesseract.js`, `mediabunny` and a `prebuilds/darwin-*` folder. `npm run check:packaged` runs
  it against `dist/mac-universal/Loupe.app`.
- `build/make-signing-cert.sh` (once): creates "Loupe Signing", uploads the secrets, keeps the
  backup in `~/Documents/Loupe signing certificate`. `--upload` re-uploads the backup.
- Universal build: `x64ArchFiles` is set for the `uiohook-napi` prebuilds, which are identical in
  both halves.

## Self-update

`src/updater.js` is Quill's, with the bundle names changed (`Loupe.app`, `.Loupe-update.app`,
`Loupe-<v>-universal.dmg`). `main.js` wires it: `createUpdater()` at startup, a daily check
(`autoUpdateCheck`, `lastUpdateCheck`, `notifiedVersion` in settings), `announceUpdate()`
(`lastRunVersion`), "Update to Loupe x.y.z…" / "Check for Updates…" in the Loupe menu and the
tray, `src/update.html` + `update.js` as the window, IPC `update:*`. Mac only: the menu items and
the daily check are skipped elsewhere. The first version with the updater (0.3.0) is installed by
hand; it can only update *from* a copy signed with the certificate, so the certificate must exist
before 0.3.0 is built.

## Closing capture windows (0.3.0)

Settings `closeAfterCopy` (default true) and `autoCloseSeconds` (0/30/120/600, default 120), see
`closingSettings()` in `main.js`.

- The editor's `copy()` calls `editor:copied` after a successful copy; main closes the window after
  120 ms unless the setting is off. Closing goes through the normal `close` handler, so unsaved
  changes are asked about.
- Idle timer: started on the window's `blur`, cleared on `focus`, never started (or cleared) once
  the window is dirty. When it fires it re-checks focus, dirty, `dialogOpen` and that the setting
  hasn't changed. `dialogOpen` is set around the Save As sheet and the close question so nothing
  closes under a sheet.
- The close question is Save / Don't Save / Keep Editing (default Save). Save sends
  `editor:save-and-close` to the page; the page runs its normal `save()` (Save As when the file isn't
  Loupe's own) and then calls `editor:close`, which closes without asking because the window is
  clean. Don't Save clears `dirty` and lets the close proceed. Quitting never asks (pre-existing).
- `closeAllEditors()` closes each editor window through the same handler.

## Permissions

Screen Recording (captures), Accessibility (step capture's click hook), Camera and Microphone
(recording). macOS remembers them by the designated requirement, hence the certificate. Running
from Terminal with `npm start` uses Terminal's permissions, and the Screen Recording entry is
called Electron.
