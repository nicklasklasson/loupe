'use strict';

const {
  app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen, Tray, Menu,
  nativeImage, clipboard, dialog, shell, systemPreferences, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { Updater } = require('./src/updater');

// Where releases live, for Check for Updates. Taken from package.json so a fork updates from itself.
const UPDATE_REPO = (() => {
  const url = (require('./package.json').repository || {}).url || '';
  return (/github\.com[/:]([^/]+\/[^/.]+)/.exec(url) || [])[1] || 'nicklasklasson/loupe';
})();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const HOTKEYS = {
  region: 'Alt+Shift+1',
  window: 'Alt+Shift+2',
  fullscreen: 'Alt+Shift+3',
  record: 'Alt+Shift+R',
  text: 'Alt+Shift+T',
  steps: 'Alt+Shift+S',
};
// PrintScreen is also bound to region capture on Windows/Linux when the OS lets us have it.
const EXTRA_REGION_KEY = process.platform === 'darwin' ? null : 'PrintScreen';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);
const VIDEO_EXT = new Set(['.webm', '.mp4']);

const isMac = process.platform === 'darwin';

let homeWin = null;
let overlayWin = null;
let pickerWin = null;
let recorderWin = null;
let frameWin = null;
let tray = null;
let updateWin = null;
let updater = null;
let quitting = false;
let busy = false;

let pendingRegion = null;   // state shared with the region overlay
let pickerConfig = null;    // state shared with the source picker
let recorderConfig = null;  // state shared with the recorder bar
const editors = new Map();  // webContents.id -> { file, dirty, copied, owned, idleTimer, dialogOpen }
const registeredKeys = {};

const webPreferences = (extra = {}) => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  ...extra,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows that must float over full-screen apps (the capture overlay, the countdown, pinned
// captures, the camera bubble). On macOS, Electron makes that work by turning Loupe into a
// "UI element" process, which is also what hiding the Dock icon does, and it never turns it back
// when the window closes. The visible symptom was the running dot under the Dock icon vanishing
// after every capture. So count these windows and restore the Dock when the last one closes.
let floatingOverFullscreen = 0;
function floatOverFullscreen(win) {
  if (!isMac) return;
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  floatingOverFullscreen++;
  win.once('closed', () => {
    floatingOverFullscreen = Math.max(0, floatingOverFullscreen - 1);
    if (floatingOverFullscreen === 0 && !quitting) applyDock();
  });
}

// Settings live in a small JSON file in the app's user-data folder.
function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

function defaultLibraryDir() { return path.join(app.getPath('pictures'), 'Loupe'); }

// How capture windows close by themselves, so a day of captures doesn't end with a screen full
// of them. Copy closes the window (the image is on the clipboard; that's what you wanted it
// for), and a window nobody has touched closes after sitting unfocused for a while. A window
// with unsaved changes is never closed by the timer, only asked about when you close it.
const AUTO_CLOSE_CHOICES = [0, 30, 120, 600]; // seconds; 0 = off
const CLOSING_DEFAULTS = { closeAfterCopy: true, autoCloseSeconds: 120 };

function closingSettings() {
  const s = readSettings();
  return {
    closeAfterCopy: typeof s.closeAfterCopy === 'boolean' ? s.closeAfterCopy : CLOSING_DEFAULTS.closeAfterCopy,
    autoCloseSeconds: AUTO_CLOSE_CHOICES.includes(s.autoCloseSeconds) ? s.autoCloseSeconds : CLOSING_DEFAULTS.autoCloseSeconds,
  };
}

function setClosing(patch) {
  const next = {};
  if (typeof patch.closeAfterCopy === 'boolean') next.closeAfterCopy = patch.closeAfterCopy;
  if (AUTO_CLOSE_CHOICES.includes(Number(patch.autoCloseSeconds))) next.autoCloseSeconds = Number(patch.autoCloseSeconds);
  writeSettings(next);
  const settings = closingSettings();
  if (homeWin && !homeWin.isDestroyed()) homeWin.webContents.send('closing:changed', settings);
  // A shorter timer applies to windows already waiting; a longer one or Off lets them wait again.
  for (const state of editors.values()) {
    const win = BrowserWindow.fromId(state.winId);
    if (!win || win.isDestroyed()) continue;
    stopIdleTimer(state);
    if (!win.isFocused()) startIdleTimer(win, state);
  }
  return settings;
}

// Whether Loupe shows in the Dock (macOS). Off means it lives in the menu bar only, like a
// utility; the magnifying glass menu still has everything. Personal choice, on by default.
function showInDock() {
  const s = readSettings();
  return typeof s.showInDock === 'boolean' ? s.showInDock : true;
}

function applyDock() {
  if (!isMac || !app.dock) return;
  if (showInDock()) Promise.resolve(app.dock.show()).catch(() => {});
  else app.dock.hide();
}

function stopIdleTimer(state) {
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
}

// Starts the countdown for an untouched capture window that just lost focus.
function startIdleTimer(win, state) {
  stopIdleTimer(state);
  const seconds = closingSettings().autoCloseSeconds;
  if (!seconds || state.dirty) return;
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    if (win.isDestroyed() || win.isFocused() || state.dirty || state.dialogOpen) return;
    if (closingSettings().autoCloseSeconds !== seconds) return; // the setting changed meanwhile
    win.close();
  }, seconds * 1000);
}

// A chosen folder must already exist and be writable. Loupe never creates it, so a folder on an
// unplugged drive or disconnected share is reported as unreachable instead of being silently
// recreated somewhere else.
function isWritableDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

let libraryFallback = null; // set when the chosen folder can't be reached

// Where captures and recordings are saved: the folder the person chose, or Pictures/Loupe.
function libraryDir() {
  const chosen = readSettings().libraryDir;
  libraryFallback = null;
  if (chosen) {
    if (isWritableDir(chosen)) { libraryFallback = null; return chosen; }
    libraryFallback = chosen; // e.g. an unplugged drive or a disconnected network share
  }
  const dir = defaultLibraryDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function prettyPath(dir) {
  const home = app.getPath('home');
  return dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function uniquePath(dir, base, ext) {
  let file = path.join(dir, base + ext);
  let i = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${base} (${i++})${ext}`);
  return file;
}

function isInLibrary(file) {
  const rel = path.relative(libraryDir(), file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function hotkeyLabel(accel) {
  if (!accel) return '';
  if (!isMac) return accel.replace('CommandOrControl', 'Ctrl');
  return accel
    .replace('CommandOrControl', '⌘').replace('Alt', '⌥').replace('Shift', '⇧')
    .replace(/\+/g, '');
}

function notifyLibrary() {
  if (homeWin && !homeWin.isDestroyed()) homeWin.webContents.send('library:changed');
}

function toast(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

function showError(err) {
  const message = err && err.message ? err.message : String(err);
  console.error(err);
  dialog.showErrorBox('Loupe', message);
}

function screenPermission() {
  if (!isMac) return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
}

const PRIVACY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

function showPermissionHelp(rawError) {
  const status = screenPermission();
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Open System Settings', 'Quit Loupe', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'Loupe needs Screen Recording permission',
    detail: 'Turn on Loupe in System Settings > Privacy & Security > Screen Recording (called "Screen & System Audio Recording" on newer macOS).\n\n'
      + 'Then quit Loupe completely (the Quit button here, or Quit Loupe in the menu bar icon) and open it again. '
      + 'Closing the window is not enough, and macOS only applies the change after a restart.\n\n'
      + 'If Loupe is already switched on, the setting may belong to an older build: remove Loupe from the list with the minus button, quit, open Loupe and allow it again.\n\n'
      + `Details: Loupe ${app.getVersion()}, permission status "${status}", error "${rawError || 'none'}".`,
  });
  if (choice === 0) shell.openExternal(PRIVACY_URL);
  if (choice === 1) { quitting = true; app.quit(); }
}

// macOS's permission status is unreliable (it reports "denied" before the first request and
// sometimes after access was granted), so never block on it. Always attempt the capture:
// that lets macOS show its own prompt, and failures are handled where they happen.
function ensureScreenAccess() {
  return true;
}

// desktopCapturer.getSources, with the macOS permission failure turned into a clear message.
async function getSources(options) {
  try {
    return await desktopCapturer.getSources(options);
  } catch (err) {
    // Only blame the permission when macOS actually reports it as missing; otherwise show the real error.
    if (isMac) {
      const e = new Error(String((err && err.message) || err || 'unknown error'));
      e.permission = true;
      throw e;
    }
    throw new Error(`Screen capture failed: ${(err && err.message) || err}`);
  }
}

function handleCaptureError(err) {
  if (err && err.permission) showPermissionHelp(err.message);
  else showError(err);
}

// Hide our own windows so they don't end up in the capture. Returns a function that restores them.
async function hideOwnWindows() {
  const hidden = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && w.isVisible() && w !== recorderWin && w !== frameWin,
  );
  hidden.forEach((w) => w.hide());
  if (hidden.length) await delay(isMac ? 380 : 240);
  return () => hidden.forEach((w) => { if (!w.isDestroyed()) w.showInactive(); });
}

function displayPixelSize(display) {
  return {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
}

function largestDisplaySize() {
  return screen.getAllDisplays().reduce((acc, d) => {
    const s = displayPixelSize(d);
    return { width: Math.max(acc.width, s.width), height: Math.max(acc.height, s.height) };
  }, { width: 1920, height: 1080 });
}

async function grabDisplay(display) {
  const sources = await getSources({
    types: ['screen'],
    thumbnailSize: displayPixelSize(display),
  });
  let source = sources.find((s) => s.display_id && s.display_id === String(display.id));
  if (!source) {
    const index = screen.getAllDisplays().findIndex((d) => d.id === display.id);
    source = sources[index] || sources[0];
  }
  if (!source || source.thumbnail.isEmpty()) {
    if (isMac) {
      const e = new Error('the screen image came back empty');
      e.permission = true;
      throw e;
    }
    throw new Error(isMac
      ? 'macOS reports that Loupe has Screen Recording permission, but the screen image came back empty. Quit Loupe from the menu bar icon and open it again. If that doesn\'t help, remove Loupe from the Screen Recording list, then allow it again.'
      : 'Loupe couldn\'t read the screen. Try again, or restart Loupe.');
  }
  return { image: source.thumbnail, sourceId: source.id };
}

function cursorDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// ---------------------------------------------------------------------------
// Capture flows
// ---------------------------------------------------------------------------

// Copying to the clipboard is a convenience, so it must never stop a capture from opening.
// Each method is checked by reading the clipboard back, so "copied" is only reported when an
// image is really there.
function clipboardHasImage() {
  try {
    if (typeof clipboard.readImage === 'function' && !clipboard.readImage().isEmpty()) return true;
    if (typeof clipboard.availableFormats === 'function') {
      return clipboard.availableFormats().some((f) => /image|png|tiff/i.test(f));
    }
  } catch { /* fall through */ }
  return false;
}

function copyImageToClipboard(image) {
  const attempts = [
    ['writeImage', () => clipboard.writeImage(image)],
    ['write', () => clipboard.write({ image })],
    ['writeBuffer', () => {
      // Raw PNG under the platform's own type name: public.png on macOS, PNG on Windows.
      const type = isMac ? 'public.png' : process.platform === 'win32' ? 'PNG' : 'image/png';
      clipboard.clear();
      clipboard.writeBuffer(type, image.toPNG());
    }],
  ];
  for (const [name, fn] of attempts) {
    if (typeof clipboard[name] !== 'function') continue;
    try {
      fn();
      if (clipboardHasImage()) return true;
      console.warn(`clipboard.${name} ran but no image is on the clipboard`);
    } catch (err) {
      console.warn(`clipboard.${name} failed:`, err);
    }
  }
  console.warn('Could not put the image on the clipboard. Available:', Object.keys(clipboard || {}).join(', '));
  return false;
}

function finishCapture(image) {
  const file = uniquePath(libraryDir(), `Capture ${stamp()}`, '.png');
  fs.writeFileSync(file, image.toPNG());
  notifyLibrary();
  openEditor(file, { copied: copyImageToClipboard(image) });
}

// ---------------------------------------------------------------------------
// Self-timer: an optional countdown before a capture, per action
// ---------------------------------------------------------------------------

const TIMER_DEFAULTS = { region: false, window: false, fullscreen: false, text: false, record: true };
const TIMER_LENGTHS = [3, 5, 10];

function timerSettings() {
  const s = readSettings();
  return {
    timer: { ...TIMER_DEFAULTS, ...(s.timer || {}) },
    seconds: TIMER_LENGTHS.includes(s.timerSeconds) ? s.timerSeconds : 3,
  };
}

// Seconds to wait before the given action captures, or 0 for no timer.
function timerDelay(action) {
  const t = timerSettings();
  return t.timer[action] ? t.seconds : 0;
}

function timerChanged() {
  buildTrayMenu();
  buildAppMenu();
  if (homeWin && !homeWin.isDestroyed()) homeWin.webContents.send('timer:changed');
}

function setTimer(action, on) {
  if (!(action in TIMER_DEFAULTS)) return;
  const t = timerSettings();
  t.timer[action] = !!on;
  writeSettings({ timer: t.timer });
  timerChanged();
}

function setTimerSeconds(seconds) {
  if (!TIMER_LENGTHS.includes(seconds)) return;
  writeSettings({ timerSeconds: seconds });
  timerChanged();
}

function timerSubmenu() {
  const t = timerSettings();
  const item = (action, label) => ({
    label, type: 'checkbox', checked: t.timer[action], click: (mi) => setTimer(action, mi.checked),
  });
  return [
    item('region', 'Region'),
    item('window', 'Window'),
    item('fullscreen', 'Full screen'),
    item('text', 'Copy text'),
    item('record', 'Recording countdown'),
    { type: 'separator' },
    ...TIMER_LENGTHS.map((n) => ({ label: `${n} seconds`, type: 'radio', checked: t.seconds === n, click: () => setTimerSeconds(n) })),
  ];
}

// A dashed outline marking an area of the screen. Click-through, and kept out of captures.
function makeOutline(display, rect) {
  const pad = 4;
  const win = new BrowserWindow({
    x: Math.round(display.bounds.x + rect.x - pad),
    y: Math.round(display.bounds.y + rect.y - pad),
    width: Math.round(rect.width + pad * 2),
    height: Math.round(rect.height + pad * 2),
    frame: false, transparent: true, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, enableLargerThanScreen: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"></head>'
    + '<body style="margin:0;height:100vh;box-sizing:border-box;border:2px dashed #C99230;border-radius:3px;background:transparent"></body></html>';
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
  return win;
}

let countdownActive = false;

/**
 * Show a countdown, then resolve true; or false if Esc was pressed. While it runs you can use the
 * computer normally (open a menu, hover over something). The countdown and the area outline are
 * removed just before resolving, so they never end up in the capture.
 */
function runCountdown(seconds, display, rect) {
  return new Promise((resolve) => {
    countdownActive = true;
    const S = 132;
    const wa = display.workArea;
    // Keep the countdown out of the way of the area being captured: top centre of the screen,
    // or bottom centre if the area covers the top.
    let x = Math.round(wa.x + (wa.width - S) / 2);
    let y = Math.round(wa.y + 16);
    if (rect) {
      const top = display.bounds.y + rect.y;
      const left = display.bounds.x + rect.x;
      const overlapsTop = top < y + S + 8 && left < x + S && left + rect.width > x;
      if (overlapsTop) y = Math.round(wa.y + wa.height - S - 16);
    }
    const win = new BrowserWindow({
      x, y, width: S, height: S,
      frame: false, transparent: true, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(true);
    floatOverFullscreen(win);
    const outline = rect ? makeOutline(display, rect) : null;

    let left = seconds;
    let done = false;
    let escBound = false;
    const show = () => {
      if (!win.isDestroyed()) win.webContents.executeJavaScript(`document.getElementById('n').textContent = ${left}`).catch(() => {});
    };
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      if (escBound) globalShortcut.unregister('Escape');
      if (!win.isDestroyed()) win.destroy();
      if (outline && !outline.isDestroyed()) outline.destroy();
      countdownActive = false;
      // Give the window server a moment to remove them before the screenshot is taken.
      setTimeout(() => resolve(ok), isMac ? 160 : 100);
    };
    try { escBound = globalShortcut.register('Escape', () => finish(false)); } catch { escBound = false; }

    win.loadFile(path.join(__dirname, 'src', 'countdown.html')).then(() => {
      show();
      if (!win.isDestroyed()) win.showInactive();
    }).catch(() => {});
    const tick = setInterval(() => {
      left -= 1;
      if (left <= 0) finish(true);
      else show();
    }, 1000);
  });
}

// Crop a full-screen capture to an area given in screen points.
function cropToRect(image, display, rect) {
  const size = image.getSize();
  const ratio = size.width / display.bounds.width;
  const x = Math.max(0, Math.round(rect.x * ratio));
  const y = Math.max(0, Math.round(rect.y * ratio));
  return image.crop({
    x, y,
    width: Math.max(1, Math.min(size.width - x, Math.round(rect.width * ratio))),
    height: Math.max(1, Math.min(size.height - y, Math.round(rect.height * ratio))),
  });
}

async function captureRegion(mode = 'capture', recordOptions = {}) {
  if (busy || countdownActive || !ensureScreenAccess()) return;
  busy = true;
  let restore = () => {};
  try {
    const display = cursorDisplay();
    restore = await hideOwnWindows();
    const { image, sourceId } = await grabDisplay(display);
    pendingRegion = { mode, image, display, sourceId, recordOptions, restore };
    openOverlay(display);
  } catch (err) {
    busy = false;
    pendingRegion = null;
    restore();
    handleCaptureError(err);
  }
}

async function captureFullscreen() {
  if (busy || countdownActive || !ensureScreenAccess()) return;
  busy = true;
  let restore = () => {};
  try {
    const display = cursorDisplay();
    restore = await hideOwnWindows();
    const seconds = timerDelay('fullscreen');
    if (seconds && !(await runCountdown(seconds, display, null))) { restore(); return; }
    const { image } = await grabDisplay(display);
    restore();
    finishCapture(image);
  } catch (err) {
    restore();
    handleCaptureError(err);
  } finally {
    busy = false;
  }
}

function captureWindow() {
  openPicker({ mode: 'capture' });
}

function startRecording() {
  if (recorderWin) { recorderWin.focus(); return; }
  openPicker({ mode: 'record' });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function showHome() {
  if (!homeWin || homeWin.isDestroyed()) createHome();
  homeWin.show();
  homeWin.focus();
  if (isMac) app.focus({ steal: true }); // needed when Loupe is hidden from the Dock
}

function createHome() {
  homeWin = new BrowserWindow({
    width: 1040, height: 780, minWidth: 760, minHeight: 520,
    title: 'Loupe', backgroundColor: '#EEF1F4', show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: webPreferences(),
  });
  homeWin.setMenuBarVisibility(false);
  homeWin.loadFile(path.join(__dirname, 'src', 'home.html'));
  const win = homeWin;
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  homeWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); homeWin.hide(); }
  });
}

function openOverlay(display) {
  const { x, y, width, height } = display.bounds;
  overlayWin = new BrowserWindow({
    x, y, width, height,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true,
    alwaysOnTop: true, show: false, backgroundColor: '#000000',
    webPreferences: webPreferences(),
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  floatOverFullscreen(overlayWin);
  overlayWin.setBounds({ x, y, width, height });
  overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  const win = overlayWin;
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  win.on('closed', () => { if (overlayWin === win) overlayWin = null; });
}

function closeOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  overlayWin = null;
}

function openPicker(config) {
  if (!ensureScreenAccess()) return;
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  pickerConfig = config;
  pickerWin = new BrowserWindow({
    width: 940, height: 640, minWidth: 640, minHeight: 440,
    title: config.mode === 'record' ? 'Record — Loupe' : 'Capture a window — Loupe',
    backgroundColor: '#EEF1F4', show: false,
    webPreferences: webPreferences(),
  });
  pickerWin.setMenuBarVisibility(false);
  pickerWin.on('page-title-updated', (e) => e.preventDefault());
  pickerWin.loadFile(path.join(__dirname, 'src', 'picker.html'));
  const win = pickerWin;
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  win.on('closed', () => { if (pickerWin === win) pickerWin = null; });
}

function closePicker() {
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  pickerWin = null;
}

function openEditor(file, { copied = false } = {}) {
  const win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 820, minHeight: 540,
    title: `${path.basename(file)} — Loupe`, backgroundColor: '#29323E', show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: webPreferences(),
  });
  const id = win.webContents.id;
  const state = { file, dirty: false, copied, owned: isInLibrary(file), winId: win.id, idleTimer: null, dialogOpen: false };
  editors.set(id, state);
  win.setMenuBarVisibility(false);
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'src', 'editor.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); if (isMac) app.focus({ steal: true }); } });
  // Untouched windows close on their own after a while in the background; see closingSettings.
  win.on('blur', () => startIdleTimer(win, state));
  win.on('focus', () => stopIdleTimer(state));
  win.on('close', (e) => {
    if (quitting || !state.dirty) return;
    if (state.dialogOpen) { e.preventDefault(); return; } // a Save As sheet is up: finish that first
    state.dialogOpen = true;
    let choice;
    try {
      choice = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['Save', 'Don\'t Save', 'Keep Editing'], defaultId: 0, cancelId: 2,
        message: 'Do you want to save the changes to this capture?',
        detail: state.owned
          ? 'Save writes the annotated capture to your library. Don\'t Save keeps the original as it was.'
          : 'Save creates a copy; the original image stays untouched.',
      });
    } finally {
      state.dialogOpen = false;
    }
    if (choice === 1) { state.dirty = false; return; } // close goes ahead
    e.preventDefault();
    // Save and close: the editor saves (Save As when the file isn't Loupe's own), then asks to
    // close again, which no longer prompts because the window is clean.
    if (choice === 0) win.webContents.send('editor:save-and-close');
  });
  win.on('closed', () => { stopIdleTimer(state); editors.delete(id); });
}

function closeAllEditors() {
  for (const state of editors.values()) {
    const win = BrowserWindow.fromId(state.winId);
    if (win && !win.isDestroyed()) win.close();
  }
}

function openRecorder(config) {
  const display = config.display || screen.getPrimaryDisplay();
  recorderConfig = { ...config, display };
  const W = 360;
  const H = 60;
  const wa = display.workArea;
  let x = Math.round(wa.x + (wa.width - W) / 2);
  let y = Math.round(wa.y + wa.height - H - 28);
  if (config.rect) {
    const below = display.bounds.y + config.rect.y + config.rect.height + 14;
    if (below + H < wa.y + wa.height) {
      y = Math.round(below);
      x = Math.round(Math.min(Math.max(display.bounds.x + config.rect.x + config.rect.width / 2 - W / 2, wa.x + 8), wa.x + wa.width - W - 8));
    }
  }
  recorderWin = new BrowserWindow({
    x, y, width: W, height: H,
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, show: false, backgroundColor: '#1C2430', hasShadow: true,
    title: 'Recording — Loupe',
    webPreferences: webPreferences({ backgroundThrottling: false }),
  });
  recorderWin.setAlwaysOnTop(true, 'screen-saver');
  recorderWin.setContentProtection(true); // keep the control bar out of the video where the OS supports it
  recorderWin.loadFile(path.join(__dirname, 'src', 'recorder.html'));
  const rwin = recorderWin;
  rwin.once('ready-to-show', () => { if (!rwin.isDestroyed()) rwin.showInactive(); });
  rwin.on('closed', () => {
    if (recorderWin === rwin) recorderWin = null;
    closeFrame();
    closeCamera();
    if (recorderConfig && recorderConfig.restore) recorderConfig.restore();
    recorderConfig = null;
  });

  if (config.rect) openFrame(display, config.rect);
  if (config.camera) openCamera(display, config.rect);
}

// A click-through outline that marks the area being recorded.
function openFrame(display, rect) {
  const pad = 4;
  frameWin = new BrowserWindow({
    x: Math.round(display.bounds.x + rect.x - pad),
    y: Math.round(display.bounds.y + rect.y - pad),
    width: Math.round(rect.width + pad * 2),
    height: Math.round(rect.height + pad * 2),
    frame: false, transparent: true, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, enableLargerThanScreen: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  frameWin.setIgnoreMouseEvents(true);
  frameWin.setAlwaysOnTop(true, 'screen-saver');
  frameWin.setContentProtection(true);
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body style="margin:0;height:100vh;box-sizing:border-box;border:2px dashed #C99230;border-radius:3px;background:transparent"></body></html>`;
  frameWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const fwin = frameWin;
  fwin.once('ready-to-show', () => { if (!fwin.isDestroyed()) fwin.showInactive(); });
  fwin.on('closed', () => { if (frameWin === fwin) frameWin = null; });
}

function closeFrame() {
  if (frameWin && !frameWin.isDestroyed()) frameWin.close();
  frameWin = null;
}

// ---------------------------------------------------------------------------
// Copy text from the screen (OCR)
// ---------------------------------------------------------------------------

const ocr = require('./ocr');
const textJobs = new Map(); // webContents.id -> Promise<{ text }>

function ocrCacheDir() { return path.join(app.getPath('userData'), 'ocr-cache'); }

// Small UI text is read more reliably when it is enlarged first.
function prepareForOcr(image) {
  const { width, height } = image.getSize();
  if (width * height > 12e6) return image.toPNG();
  const scale = width < 1600 ? 2 : 1;
  return (scale > 1 ? image.resize({ width: width * scale, height: height * scale, quality: 'best' }) : image).toPNG();
}

function openTextWindow(job) {
  const cursor = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cursor).workArea;
  const W = 520;
  const H = 360;
  const win = new BrowserWindow({
    width: W, height: H, minWidth: 360, minHeight: 220,
    x: Math.round(Math.min(Math.max(cursor.x - W / 2, wa.x + 8), wa.x + wa.width - W - 8)),
    y: Math.round(Math.min(Math.max(cursor.y - H / 2, wa.y + 8), wa.y + wa.height - H - 8)),
    title: 'Text — Loupe', backgroundColor: '#EEF1F4', show: false, alwaysOnTop: true,
    webPreferences: webPreferences(),
  });
  win.setMenuBarVisibility(false);
  win.on('page-title-updated', (e) => e.preventDefault());
  textJobs.set(win.webContents.id, job);
  win.loadFile(path.join(__dirname, 'src', 'text.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  const id = win.webContents.id;
  win.on('closed', () => textJobs.delete(id));
}

function readText(image) {
  const job = ocr.recognize(prepareForOcr(image), ocrCacheDir())
    .then((text) => {
      if (text) clipboard.writeText(text);
      return { text, copied: !!text };
    })
    .catch((err) => ({ text: '', error: err.message || String(err) }));
  openTextWindow(job);
}

function captureText() { captureRegion('ocr'); }

// ---------------------------------------------------------------------------
// Pinned captures: always-on-top image windows
// ---------------------------------------------------------------------------

const pins = new Map(); // webContents.id -> { bytes, width, height, win }

function openPin(image) {
  const png = image.toPNG();
  const { width, height } = image.getSize();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;
  // Captures are in physical pixels; show them at their real on-screen size, capped to the screen.
  let w = width / display.scaleFactor;
  let h = height / display.scaleFactor;
  const cap = Math.min((wa.width * 0.7) / w, (wa.height * 0.7) / h, 1);
  w = Math.max(80, Math.round(w * cap));
  h = Math.max(60, Math.round(h * cap));
  const win = new BrowserWindow({
    width: w, height: h,
    x: Math.round(Math.min(Math.max(cursor.x - w / 2, wa.x), wa.x + wa.width - w)),
    y: Math.round(Math.min(Math.max(cursor.y - h / 2, wa.y), wa.y + wa.height - h)),
    frame: false, resizable: true, minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: true, show: false, backgroundColor: '#29323E',
    title: 'Pinned capture — Loupe',
    webPreferences: webPreferences(),
  });
  win.setAlwaysOnTop(true, 'floating');
  floatOverFullscreen(win);
  win.setAspectRatio(w / h);
  const id = win.webContents.id;
  pins.set(id, { bytes: png, width, height, win, aspect: w / h });
  win.loadFile(path.join(__dirname, 'src', 'pin.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('closed', () => pins.delete(id));
}

function closeAllPins() {
  for (const { win } of pins.values()) if (!win.isDestroyed()) win.close();
}

// ---------------------------------------------------------------------------
// Camera bubble shown on screen while recording
// ---------------------------------------------------------------------------

let cameraWin = null;
const CAMERA_SIZES = [160, 220, 300];

async function openCamera(display, rect) {
  if (cameraWin && !cameraWin.isDestroyed()) return;
  if (isMac) {
    try {
      const ok = await systemPreferences.askForMediaAccess('camera');
      if (!ok) {
        dialog.showMessageBox({
          type: 'info', message: 'Loupe can\'t use the camera',
          detail: 'Allow Loupe in System Settings > Privacy & Security > Camera, then start the recording again. The recording continues without the camera.',
        });
        return;
      }
    } catch { /* older macOS: fall through and let the page ask */ }
  }
  const size = CAMERA_SIZES[1];
  const area = rect
    ? { x: display.bounds.x + rect.x, y: display.bounds.y + rect.y, width: rect.width, height: rect.height }
    : display.workArea;
  const margin = 24;
  cameraWin = new BrowserWindow({
    x: Math.round(area.x + margin),
    y: Math.round(area.y + area.height - size - margin),
    width: size, height: size,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    hasShadow: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    title: 'Camera — Loupe',
    webPreferences: webPreferences({ backgroundThrottling: false }),
  });
  cameraWin.setAlwaysOnTop(true, 'screen-saver');
  floatOverFullscreen(cameraWin);
  cameraWin.loadFile(path.join(__dirname, 'src', 'camera.html'));
  const cwin = cameraWin;
  cwin.once('ready-to-show', () => { if (!cwin.isDestroyed()) cwin.showInactive(); });
  cwin.on('closed', () => { if (cameraWin === cwin) cameraWin = null; });
}

function closeCamera() {
  if (cameraWin && !cameraWin.isDestroyed()) cameraWin.close();
  cameraWin = null;
}

// ---------------------------------------------------------------------------
// Step capture: every click becomes a numbered screenshot in a guide
// ---------------------------------------------------------------------------

let stepSession = null;
let stepBar = null;
const guides = new Map(); // webContents.id -> dir

const ACCESSIBILITY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

function guideFile(dir) { return path.join(dir, 'guide.json'); }

function readGuide(dir) {
  try { return JSON.parse(fs.readFileSync(guideFile(dir), 'utf8')); } catch { return null; }
}

function writeGuide(dir, guide) {
  fs.writeFileSync(guideFile(dir), JSON.stringify(guide, null, 2));
}

function isGuideDir(dir) {
  return fs.existsSync(guideFile(dir));
}

// macOS only lets an app see clicks in other apps once it has Accessibility permission.
function ensureClickAccess() {
  if (!isMac) return true;
  if (systemPreferences.isTrustedAccessibilityClient(false)) return true;
  systemPreferences.isTrustedAccessibilityClient(true); // shows the system prompt
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0, cancelId: 1,
    message: 'Step capture needs Accessibility permission',
    detail: 'Loupe needs to notice your clicks in other apps to take a screenshot at each step. It only listens while a step capture is running, and never records what you type.\n\n'
      + 'Turn on Loupe in System Settings > Privacy & Security > Accessibility, then quit Loupe from the menu bar and open it again.',
  });
  if (choice === 0) shell.openExternal(ACCESSIBILITY_URL);
  return false;
}

// The click hook reports where the click happened. Electron's own cursor position can lag behind
// fast clicks, so use the hook's coordinates: points on macOS (the same as Electron's), physical
// pixels on Windows (converted here).
function hookPointToDip(e) {
  const p = { x: Math.round(e.x), y: Math.round(e.y) };
  if (process.platform === 'win32' && typeof screen.screenToDipPoint === 'function') return screen.screenToDipPoint(p);
  return p;
}

function loadClickHook() {
  try {
    return require('uiohook-napi').uIOhook;
  } catch (err) {
    showError(new Error(`Step capture isn't available on this computer: ${err.message}`));
    return null;
  }
}

async function startStepCapture() {
  if (stepSession) { if (stepBar && !stepBar.isDestroyed()) stepBar.showInactive(); return; }
  if (recorderWin) { showError(new Error('Finish the screen recording before starting a step capture.')); return; }
  if (!ensureClickAccess()) return;
  const hook = loadClickHook();
  if (!hook) return;

  const dir = uniquePath(libraryDir(), `Guide ${stamp()}`, '');
  fs.mkdirSync(dir, { recursive: true });
  const guide = { title: 'New guide', created: Date.now(), steps: [] };
  writeGuide(dir, guide);

  const restore = await hideOwnWindows();
  stepSession = { dir, guide, hook, restore, lastClick: 0, paused: false, pending: new Map(), seq: 0 };

  const onDown = (e) => {
    const s = stepSession;
    if (!s || s.paused) return;
    if (e.button !== 1) return; // left clicks only
    const now = Date.now();
    if (now - s.lastClick < 350) return; // ignore the second half of a double-click
    s.lastClick = now;
    const pt = hookPointToDip(e);
    if (stepBar && !stepBar.isDestroyed()) {
      const b = stepBar.getBounds();
      if (pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height) return;
    }
    const display = screen.getDisplayNearestPoint(pt);
    const id = ++s.seq;
    s.pending.set(id, { pt, display });
    if (stepBar && !stepBar.isDestroyed()) stepBar.webContents.send('steps:grab', { id, displayId: String(display.id), at: now });
    // If the live view can't answer quickly, fall back to a regular screenshot.
    setTimeout(() => { if (s.pending.has(id)) fallbackStep(id); }, 700);
  };
  stepSession.onDown = onDown;
  hook.on('mousedown', onDown);
  try {
    hook.start();
  } catch (err) {
    hook.removeListener('mousedown', onDown);
    stepSession = null;
    restore();
    showError(new Error(`Loupe couldn't watch for clicks: ${err.message}`));
    return;
  }
  openStepBar();
}

async function fallbackStep(id) {
  const s = stepSession;
  if (!s || !s.pending.has(id)) return;
  const { pt, display } = s.pending.get(id);
  s.pending.delete(id);
  try {
    const { image } = await grabDisplay(display);
    addStep(image.toPNG(), image.getSize().width / display.bounds.width, pt, display);
  } catch (err) { console.warn('Step capture fallback failed', err); }
}

function addStep(png, ratio, pt, display) {
  const s = stepSession;
  if (!s) return;
  const n = s.guide.steps.length + 1;
  const name = `Step ${String(n).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(s.dir, name), png);
  s.guide.steps.push({
    file: name,
    text: '',
    click: { x: Math.round((pt.x - display.bounds.x) * ratio), y: Math.round((pt.y - display.bounds.y) * ratio) },
    scale: ratio,
    marked: false,
  });
  writeGuide(s.dir, s.guide);
  if (stepBar && !stepBar.isDestroyed()) stepBar.webContents.send('steps:count', n);
}

function openStepBar() {
  const display = cursorDisplay();
  const wa = display.workArea;
  const W = 400;
  const H = 60;
  stepBar = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + wa.height - H - 28),
    width: W, height: H,
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, show: false, backgroundColor: '#1C2430', hasShadow: true,
    title: 'Step capture — Loupe',
    webPreferences: webPreferences({ backgroundThrottling: false }),
  });
  stepBar.setAlwaysOnTop(true, 'screen-saver');
  stepBar.setContentProtection(true); // keep the bar out of the screenshots
  stepBar.loadFile(path.join(__dirname, 'src', 'steps.html'));
  const bar = stepBar;
  bar.once('ready-to-show', () => { if (!bar.isDestroyed()) bar.showInactive(); });
  bar.on('closed', () => { if (stepBar === bar) stepBar = null; if (stepSession) finishStepCapture(false); });
}

function finishStepCapture(keep) {
  const s = stepSession;
  if (!s) return;
  stepSession = null;
  try { s.hook.removeListener('mousedown', s.onDown); s.hook.stop(); } catch { /* already stopped */ }
  if (stepBar && !stepBar.isDestroyed()) stepBar.close();
  s.restore();
  if (keep && s.guide.steps.length) {
    notifyLibrary();
    openGuide(s.dir);
  } else {
    shell.trashItem(s.dir).catch(() => {});
  }
}

function openGuide(dir) {
  for (const [id, d] of guides) {
    if (d === dir) {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.id === id);
      if (w) { w.show(); w.focus(); return; }
    }
  }
  const win = new BrowserWindow({
    width: 1000, height: 860, minWidth: 720, minHeight: 500,
    title: `${path.basename(dir)} — Loupe`, backgroundColor: '#EEF1F4', show: false,
    webPreferences: webPreferences(),
  });
  win.setMenuBarVisibility(false);
  win.on('page-title-updated', (e) => e.preventDefault());
  guides.set(win.webContents.id, dir);
  const id = win.webContents.id;
  win.loadFile(path.join(__dirname, 'src', 'guide.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  win.on('closed', () => guides.delete(id));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function guideHtml(dir, guide) {
  const steps = guide.steps.map((step, i) => {
    const data = fs.readFileSync(path.join(dir, step.file)).toString('base64');
    const text = step.text ? `<p>${escapeHtml(step.text).replace(/\n/g, '<br>')}</p>` : '';
    return `<section class="step"><h2><span>${i + 1}</span>${escapeHtml(step.title || `Step ${i + 1}`)}</h2>${text}<img src="data:image/png;base64,${data}" alt="Step ${i + 1}"></section>`;
  }).join('\n');
  const date = new Date(guide.created || Date.now()).toLocaleDateString();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(guide.title || 'Guide')}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #1C2430; max-width: 900px; margin: 0 auto; padding: 32px 24px 48px; line-height: 1.5; }
  header { border-bottom: 3px solid #C99230; padding-bottom: 14px; margin-bottom: 28px; }
  h1 { margin: 0 0 4px; font-size: 28px; }
  .meta { color: #5B6778; font-size: 14px; }
  .step { margin: 0 0 36px; page-break-inside: avoid; break-inside: avoid; }
  h2 { display: flex; align-items: center; gap: 10px; font-size: 18px; margin: 0 0 8px; }
  h2 span { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: #E5484D; color: #fff; font-size: 15px; flex: none; }
  p { margin: 0 0 10px; }
  img { max-width: 100%; border: 1px solid #D5DBE2; border-radius: 6px; display: block; }
  @media print { body { padding: 0; } }
</style></head><body>
<header><h1>${escapeHtml(guide.title || 'Guide')}</h1><div class="meta">${guide.steps.length} steps · ${escapeHtml(date)}</div></header>
${steps}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Video editor
// ---------------------------------------------------------------------------

const videoEditors = new Map(); // webContents.id -> file

function openVideoEditor(file) {
  const win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 780, minHeight: 540,
    title: `${path.basename(file)} — Loupe`, backgroundColor: '#29323E', show: false,
    webPreferences: webPreferences({ backgroundThrottling: false }),
  });
  win.setMenuBarVisibility(false);
  win.on('page-title-updated', (e) => e.preventDefault());
  videoEditors.set(win.webContents.id, file);
  const id = win.webContents.id;
  win.loadFile(path.join(__dirname, 'src', 'video.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  win.on('closed', () => videoEditors.delete(id));
}

// ---------------------------------------------------------------------------
// Tray, menu and shortcuts
// ---------------------------------------------------------------------------

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Loupe');
  buildTrayMenu();
  tray.on('click', () => { if (!isMac) showHome(); });
}

function buildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Capture region', accelerator: HOTKEYS.region, click: () => captureRegion() },
    { label: 'Capture window', accelerator: HOTKEYS.window, click: captureWindow },
    { label: 'Capture full screen', accelerator: HOTKEYS.fullscreen, click: captureFullscreen },
    { label: 'Record screen', accelerator: HOTKEYS.record, click: startRecording },
    { label: 'Copy text from screen', accelerator: HOTKEYS.text, click: captureText },
    { label: 'Step capture', accelerator: HOTKEYS.steps, click: startStepCapture },
    { label: 'Timer', submenu: timerSubmenu() },
    { type: 'separator' },
    { label: 'Close all capture windows', click: closeAllEditors },
    { label: 'Close all pinned captures', click: closeAllPins },
    { type: 'separator' },
    { label: 'Open Loupe', click: showHome },
    { label: 'Open captures folder', click: () => shell.openPath(libraryDir()) },
    { type: 'separator' },
    ...updateMenuItems(),
    { label: 'Quit Loupe', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// "Update to Loupe x.y.z…" once a newer version is known, and Check for Updates… always.
function updateMenuItems() {
  if (!isMac) return []; // self-update is Mac-only for now (dmg from GitHub)
  const u = updater ? updater.state : null;
  return [
    ...(u && u.available ? [{ label: `Update to Loupe ${u.latest}…`, click: () => openUpdate() }] : []),
    { label: 'Check for Updates…', click: () => openUpdate(true) },
    { type: 'separator' },
  ];
}

function rebuildMenus() { buildAppMenu(); buildTrayMenu(); }

function buildAppMenu() {
  if (!isMac) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Loupe',
      submenu: [
        { role: 'about', label: 'About Loupe' },
        ...updateMenuItems(),
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Loupe' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Loupe' },
      ],
    },
    {
      label: 'Capture',
      submenu: [
        { label: 'Region', accelerator: HOTKEYS.region, click: () => captureRegion() },
        { label: 'Window', accelerator: HOTKEYS.window, click: captureWindow },
        { label: 'Full screen', accelerator: HOTKEYS.fullscreen, click: captureFullscreen },
        { label: 'Record screen', accelerator: HOTKEYS.record, click: startRecording },
        { label: 'Copy text from screen', accelerator: HOTKEYS.text, click: captureText },
        { label: 'Step capture', accelerator: HOTKEYS.steps, click: startStepCapture },
        { label: 'Timer', submenu: timerSubmenu() },
        { type: 'separator' },
        { label: 'Close all capture windows', click: closeAllEditors },
        { label: 'Close all pinned captures', click: closeAllPins },
      ],
    },
    // File holds Close so ⌘W closes the front window (captures, pins, guides). Nothing else lives here.
    { label: 'File', submenu: [{ role: 'close' }] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

// ---------------------------------------------------------------------------
// Updates (Mac): a daily look at GitHub, a notification once per new version, and a small
// window to download and install it. See src/updater.js.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

function createUpdater() {
  updater = new Updater({
    app,
    fetchImpl: (url, opts) => require('electron').net.fetch(url, opts),
    repo: UPDATE_REPO,
    cacheDir: path.join(app.getPath('userData'), 'updates'),
  });
  let lastKnown = null;
  updater.on('state', (state) => {
    if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update:state', state);
    if (state.phase === 'idle' && state.latest !== lastKnown) { lastKnown = state.latest; rebuildMenus(); }
  });
}

function scheduleUpdateChecks() {
  const maybeCheck = async () => {
    const s = readSettings();
    if (s.autoUpdateCheck === false || !app.isPackaged) return;
    if (Date.now() - (s.lastUpdateCheck || 0) < DAY) return;
    const state = await updater.check();
    writeSettings({ lastUpdateCheck: Date.now() });
    // Tell the user once per new version; after that it waits in the menu.
    if (state.available && readSettings().notifiedVersion !== state.latest) {
      writeSettings({ notifiedVersion: state.latest });
      if (Notification.isSupported()) {
        const n = new Notification({ title: `Loupe ${state.latest} is available`, body: 'Click to see what\'s new and install it.', silent: true });
        n.on('click', () => openUpdate());
        n.show();
      }
    }
  };
  setTimeout(maybeCheck, 30 * 1000);
  setInterval(maybeCheck, 60 * 60 * 1000);
}

/** After an update, say so once: the visible proof that installing worked. */
function announceUpdate() {
  const previous = readSettings().lastRunVersion;
  const current = app.getVersion();
  if (previous === current) return;
  writeSettings({ lastRunVersion: current });
  if (!previous || !app.isPackaged || !Notification.isSupported()) return;
  const n = new Notification({ title: `Loupe updated to ${current}`, body: `You were on ${previous}. Click to see what's new.`, silent: true });
  n.on('click', () => shell.openExternal(`https://github.com/${UPDATE_REPO}/releases/tag/v${current}`));
  n.show();
}

function openUpdate(checkNow = false) {
  if (!updateWin || updateWin.isDestroyed()) {
    updateWin = new BrowserWindow({
      width: 440, height: 300, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      title: 'Loupe updates', backgroundColor: '#EEF1F4', show: false,
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: webPreferences(),
    });
    updateWin.setMenuBarVisibility(false);
    updateWin.loadFile(path.join(__dirname, 'src', 'update.html'));
    updateWin.once('ready-to-show', () => { if (!updateWin.isDestroyed()) updateWin.show(); });
    updateWin.on('closed', () => { updateWin = null; });
  } else {
    updateWin.show();
    updateWin.focus();
  }
  const after = () => { if (updater.state.available) updater.loadNotes(); };
  if (checkNow || !updater.state.checkedAt) updater.check().then(() => { writeSettings({ lastUpdateCheck: Date.now() }); after(); });
  else after();
}

function registerShortcuts() {
  const bind = (name, accel, fn) => {
    try { registeredKeys[name] = globalShortcut.register(accel, fn); } catch { registeredKeys[name] = false; }
  };
  bind('region', HOTKEYS.region, () => captureRegion());
  bind('window', HOTKEYS.window, captureWindow);
  bind('fullscreen', HOTKEYS.fullscreen, captureFullscreen);
  bind('record', HOTKEYS.record, startRecording);
  bind('text', HOTKEYS.text, captureText);
  bind('steps', HOTKEYS.steps, startStepCapture);
  if (EXTRA_REGION_KEY) bind('printscreen', EXTRA_REGION_KEY, () => captureRegion());
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function senderWindow(event) { return BrowserWindow.fromWebContents(event.sender); }

ipcMain.handle('app:info', () => ({
  platform: process.platform,
  version: app.getVersion(),
  permission: screenPermission(),
  hotkeys: Object.fromEntries(Object.entries(HOTKEYS).map(([k, v]) => [k, { label: hotkeyLabel(v), ok: registeredKeys[k] !== false }])),
  printScreen: !!registeredKeys.printscreen,
  libraryDir: libraryDir(),
  libraryLabel: prettyPath(libraryDir()),
  libraryIsDefault: !readSettings().libraryDir,
  libraryFallback: libraryFallback ? prettyPath(libraryFallback) : null,
}));

ipcMain.handle('library:choose', async (event) => {
  const res = await dialog.showOpenDialog(senderWindow(event), {
    title: 'Choose where Loupe saves captures',
    buttonLabel: 'Use this folder',
    defaultPath: libraryDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false };
  const dir = res.filePaths[0];
  if (!isWritableDir(dir)) {
    return { ok: false, reason: `Loupe can't save to ${prettyPath(dir)}. Pick a folder you can write to.` };
  }
  writeSettings({ libraryDir: dir });
  notifyLibrary();
  return { ok: true, dir, label: prettyPath(dir) };
});

ipcMain.handle('library:resetFolder', () => {
  writeSettings({ libraryDir: null });
  notifyLibrary();
  return { ok: true, label: prettyPath(libraryDir()) };
});

ipcMain.handle('capture:region', () => captureRegion());
ipcMain.handle('capture:window', () => captureWindow());
ipcMain.handle('capture:fullscreen', () => captureFullscreen());
ipcMain.handle('record:start', () => startRecording());
ipcMain.handle('capture:text', () => captureText());
ipcMain.handle('dock:get', () => ({ supported: isMac, showInDock: showInDock() }));
ipcMain.handle('dock:set', (e, on) => {
  if (typeof on === 'boolean') { writeSettings({ showInDock: on }); applyDock(); }
  return showInDock();
});
ipcMain.handle('closing:get', () => ({ ...closingSettings(), choices: AUTO_CLOSE_CHOICES }));
ipcMain.handle('closing:set', (e, patch) => setClosing(patch || {}));
ipcMain.handle('timer:get', () => timerSettings());
ipcMain.handle('timer:set', (e, action, on) => setTimer(action, on));
ipcMain.handle('timer:seconds', (e, seconds) => setTimerSeconds(Number(seconds)));
ipcMain.handle('steps:start', () => startStepCapture());

ipcMain.handle('capture:clipboard', () => {
  const image = typeof clipboard.readImage === 'function' ? clipboard.readImage() : nativeImage.createEmpty();
  if (image.isEmpty()) return { ok: false, reason: 'There\'s no image on the clipboard. Copy an image first.' };
  finishCapture(image);
  return { ok: true };
});

ipcMain.handle('capture:openFile', async (event) => {
  const res = await dialog.showOpenDialog(senderWindow(event), {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (!res.canceled && res.filePaths[0]) openEditor(res.filePaths[0]);
});

// Library ------------------------------------------------------------------

ipcMain.handle('library:list', () => {
  const dir = libraryDir();
  return fs.readdirSync(dir)
    .map((name) => {
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(file); } catch { return null; }
      if (stat.isDirectory()) {
        const guide = isGuideDir(file) ? readGuide(file) : null;
        if (!guide || !guide.steps || !guide.steps.length) return null;
        const first = path.join(file, guide.steps[0].file);
        let firstMtime = stat.mtimeMs;
        try { firstMtime = fs.statSync(first).mtimeMs; } catch { /* keep folder time */ }
        return {
          file, name: guide.title && guide.title !== 'New guide' ? guide.title : name, kind: 'guide',
          steps: guide.steps.length,
          url: pathToFileURL(first).href + '?v=' + firstMtime,
          mtime: Math.max(stat.mtimeMs, firstMtime), size: 0,
        };
      }
      const ext = path.extname(name).toLowerCase();
      const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
      if (!kind) return null;
      return { file, name, kind, url: pathToFileURL(file).href + '?v=' + stat.mtimeMs, mtime: stat.mtimeMs, size: stat.size };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 300);
});

ipcMain.handle('library:open', (e, file) => {
  if (!isInLibrary(file)) return;
  const ext = path.extname(file).toLowerCase();
  if (isGuideDir(file)) openGuide(file);
  else if (IMAGE_EXT.has(ext)) openEditor(file);
  else if (VIDEO_EXT.has(ext)) openVideoEditor(file);
});
ipcMain.handle('library:play', (e, file) => { if (isInLibrary(file)) shell.openPath(file); });
// Copy from a library tile: the image goes on the clipboard without opening it.
ipcMain.handle('library:copy', (e, file) => {
  if (!isInLibrary(file)) return false;
  const image = nativeImage.createFromPath(file);
  return !image.isEmpty() && copyImageToClipboard(image);
});
// Close the window a page runs in, going through the normal close handling (unsaved changes etc.).
ipcMain.handle('window:close', (e) => { const win = senderWindow(e); if (win && !win.isDestroyed()) win.close(); return true; });
ipcMain.handle('library:pin', (e, file) => {
  if (!isInLibrary(file)) return;
  const image = nativeImage.createFromPath(file);
  if (!image.isEmpty()) openPin(image);
});
ipcMain.handle('library:reveal', (e, file) => { if (isInLibrary(file)) shell.showItemInFolder(file); });
ipcMain.handle('library:folder', () => shell.openPath(libraryDir()));
ipcMain.handle('library:trash', async (e, file) => {
  if (!isInLibrary(file)) return false;
  await shell.trashItem(file);
  notifyLibrary();
  return true;
});

// Region overlay -----------------------------------------------------------

ipcMain.handle('overlay:config', () => {
  if (!pendingRegion) return null;
  const { image, display, mode } = pendingRegion;
  return {
    mode,
    timer: mode === 'capture' ? timerDelay('region') : mode === 'ocr' ? timerDelay('text') : 0,
    jpeg: image.toJPEG(92),
    width: display.bounds.width,
    height: display.bounds.height,
  };
});

ipcMain.handle('overlay:done', (e, rect) => {
  const p = pendingRegion;
  pendingRegion = null;
  busy = false;
  closeOverlay();
  if (!p) return;
  if (!rect) { p.restore(); return; }

  if (p.mode === 'capture' || p.mode === 'ocr') {
    const deliver = (image) => {
      p.restore();
      if (p.mode === 'ocr') readText(cropToRect(image, p.display, rect));
      else finishCapture(cropToRect(image, p.display, rect));
    };
    const seconds = timerDelay(p.mode === 'ocr' ? 'text' : 'region');
    if (!seconds) { deliver(p.image); return; }
    // With the timer on, the screen stays usable during the countdown, then the area is captured
    // as it looks at that moment (an open menu, a hover state…).
    busy = true;
    (async () => {
      try {
        if (!(await runCountdown(seconds, p.display, rect))) { p.restore(); return; }
        const { image } = await grabDisplay(p.display);
        deliver(image);
      } catch (err) {
        p.restore();
        handleCaptureError(err);
      } finally {
        busy = false;
      }
    })();
  } else {
    openRecorder({
      sourceId: p.sourceId,
      kind: 'screen',
      display: p.display,
      rect,
      restore: p.restore,
      ...p.recordOptions,
    });
  }
});

// Source picker ------------------------------------------------------------

ipcMain.handle('picker:config', () => ({
  ...pickerConfig,
  platform: process.platform,
  timer: pickerConfig && pickerConfig.mode === 'capture' ? timerDelay('window') : 0,
}));

ipcMain.handle('sources:list', async (e, types) => {
  const ours = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  let sources;
  try {
    sources = await getSources({ types, thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: true });
  } catch (err) {
    return { ok: false, permission: !!err.permission, message: err.message };
  }
  return {
    ok: true,
    sources: sources
      .filter((s) => !ours.has(s.id) && !s.thumbnail.isEmpty())
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen') ? 'screen' : 'window',
        displayId: s.display_id,
        thumb: s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      })),
  };
});

ipcMain.handle('app:permissionHelp', (e, raw) => showPermissionHelp(raw));

ipcMain.handle('picker:choose', async (e, choice) => {
  const config = pickerConfig;
  closePicker();
  if (!config) return;
  await delay(isMac ? 300 : 180);

  if (config.mode === 'capture') {
    try {
      const seconds = timerDelay('window');
      if (seconds) {
        busy = true;
        const ok = await runCountdown(seconds, cursorDisplay(), null);
        busy = false;
        if (!ok) return;
      }
      const sources = await getSources({
        types: [choice.kind], thumbnailSize: largestDisplaySize(),
      });
      const source = sources.find((s) => s.id === choice.id);
      if (!source || source.thumbnail.isEmpty()) throw new Error('That window is no longer available. It may have closed or been minimized.');
      finishCapture(source.thumbnail);
    } catch (err) { handleCaptureError(err); }
    return;
  }

  // Recording
  let display = cursorDisplay();
  if (choice.kind === 'screen') {
    const match = screen.getAllDisplays().find((d) => String(d.id) === String(choice.displayId));
    if (match) display = match;
  }
  const restore = await hideOwnWindows();
  openRecorder({
    sourceId: choice.id, kind: choice.kind, display, rect: null, restore,
    mic: !!choice.mic, systemAudio: !!choice.systemAudio, camera: !!choice.camera,
  });
});

ipcMain.handle('picker:region', (e, options) => {
  closePicker();
  setTimeout(() => captureRegion('record', { mic: !!options.mic, systemAudio: !!options.systemAudio, camera: !!options.camera }), 150);
});

ipcMain.handle('picker:cancel', () => closePicker());

// Recorder -----------------------------------------------------------------

ipcMain.handle('recorder:config', () => {
  if (!recorderConfig) return null;
  const { sourceId, kind, rect, mic, systemAudio, display } = recorderConfig;
  return {
    sourceId, kind, rect, mic, systemAudio,
    countdown: timerDelay('record'),
    platform: process.platform,
    displaySize: { width: display.bounds.width, height: display.bounds.height },
    pixelSize: kind === 'screen' ? displayPixelSize(display) : largestDisplaySize(),
  };
});

ipcMain.handle('recorder:save', async (e, buffer, mime) => {
  const ext = mime && mime.includes('mp4') ? '.mp4' : '.webm';
  const file = uniquePath(libraryDir(), `Recording ${stamp()}`, ext);
  fs.writeFileSync(file, Buffer.from(buffer));
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.close();
  notifyLibrary();
  toast('Recording saved', path.basename(file), () => shell.showItemInFolder(file));
  openVideoEditor(file);
  return file;
});

ipcMain.handle('recorder:close', () => {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.close();
});

ipcMain.handle('recorder:error', (e, message) => {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.close();
  showError(new Error(message));
});

// Editor -------------------------------------------------------------------

ipcMain.handle('editor:config', (e) => {
  const state = editors.get(e.sender.id);
  if (!state) return null;
  return {
    file: state.file,
    name: path.basename(state.file),
    inLibrary: state.owned,
    copied: !!state.copied,
    bytes: fs.readFileSync(state.file),
  };
});

ipcMain.handle('editor:dirty', (e, dirty) => {
  const state = editors.get(e.sender.id);
  if (state) { state.dirty = !!dirty; if (state.dirty) stopIdleTimer(state); }
  const win = senderWindow(e);
  if (win && state) win.setTitle(`${dirty ? '• ' : ''}${path.basename(state.file)} — Loupe`);
});

// JPEG has no transparency, so put the transparent area around an extended capture on white.
function flattenOnWhite(image) {
  const { width, height } = image.getSize();
  const px = Buffer.from(image.toBitmap()); // BGRA or RGBA; either way alpha is the 4th byte
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    if (a === 1) continue;
    px[i] = Math.round(px[i] * a + 255 * (1 - a));
    px[i + 1] = Math.round(px[i + 1] * a + 255 * (1 - a));
    px[i + 2] = Math.round(px[i + 2] * a + 255 * (1 - a));
    px[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(px, { width, height });
}

function writeImage(file, buffer) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    fs.writeFileSync(file, flattenOnWhite(nativeImage.createFromBuffer(Buffer.from(buffer))).toJPEG(90));
  } else {
    fs.writeFileSync(file, Buffer.from(buffer));
  }
}

async function saveAs(event, buffer) {
  const state = editors.get(event.sender.id);
  const win = senderWindow(event);
  const defaultPath = state ? state.file.replace(/\.(png|jpe?g)$/i, '') + ' (edited).png' : 'Capture.png';
  if (state) state.dialogOpen = true;
  let res;
  try {
    res = await dialog.showSaveDialog(win, {
      defaultPath,
      filters: [{ name: 'PNG image', extensions: ['png'] }, { name: 'JPEG image', extensions: ['jpg'] }],
    });
  } finally {
    if (state) state.dialogOpen = false;
  }
  if (res.canceled || !res.filePath) return { ok: false };
  writeImage(res.filePath, buffer);
  if (state) {
    state.file = res.filePath;
    state.dirty = false;
    if (win) win.setTitle(`${path.basename(res.filePath)} — Loupe`);
  }
  notifyLibrary();
  return { ok: true, file: res.filePath, name: path.basename(res.filePath) };
}

ipcMain.handle('editor:save', async (e, buffer) => {
  const state = editors.get(e.sender.id);
  if (!state || !state.owned) return saveAs(e, buffer);
  writeImage(state.file, buffer);
  state.dirty = false;
  const win = senderWindow(e);
  if (win) win.setTitle(`${path.basename(state.file)} — Loupe`);
  notifyLibrary();
  return { ok: true, file: state.file, name: path.basename(state.file) };
});

ipcMain.handle('editor:saveAs', (e, buffer) => saveAs(e, buffer));

ipcMain.handle('editor:copy', (e, buffer) => copyImageToClipboard(nativeImage.createFromBuffer(Buffer.from(buffer))));

// The editor says the image is on the clipboard: close the window, unless that's switched off.
// Unsaved changes still get the Save / Don't Save / Keep Editing question from the close handler.
ipcMain.handle('editor:copied', (e) => {
  if (!closingSettings().closeAfterCopy) return false;
  const win = senderWindow(e);
  if (win && !win.isDestroyed()) setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 120);
  return true;
});

// Discard: the capture goes to the Bin (when it's Loupe's own file) and the window closes
// without the Save question. An image opened from elsewhere is left alone; only the window goes.
ipcMain.handle('editor:discard', async (e) => {
  const state = editors.get(e.sender.id);
  const win = senderWindow(e);
  if (!state) return false;
  state.dirty = false;
  stopIdleTimer(state);
  if (state.owned && isInLibrary(state.file)) {
    try { await shell.trashItem(state.file); notifyLibrary(); } catch (err) { console.warn('Discard failed', err); }
  }
  if (win && !win.isDestroyed()) win.close();
  return true;
});

// The editor finished "Save and close".
ipcMain.handle('editor:close', (e) => {
  const state = editors.get(e.sender.id);
  const win = senderWindow(e);
  if (state) state.dirty = false;
  if (win && !win.isDestroyed()) win.close();
  return true;
});

ipcMain.handle('update:state', () => updater.state);
ipcMain.handle('update:check', async () => { const st = await updater.check(); writeSettings({ lastUpdateCheck: Date.now() }); if (st.available) updater.loadNotes(); return updater.state; });
ipcMain.handle('update:install', () => updater.install(() => { quitting = true; app.quit(); }));
ipcMain.handle('update:cancel', () => { updater.cancel(); return true; });
ipcMain.handle('update:release-page', () => shell.openExternal(updater.releaseUrl()));
ipcMain.handle('update:auto', (e, on) => {
  if (typeof on === 'boolean') writeSettings({ autoUpdateCheck: on });
  return readSettings().autoUpdateCheck !== false;
});

// Text (OCR) ----------------------------------------------------------------

ipcMain.handle('text:config', async (e) => {
  const job = textJobs.get(e.sender.id);
  return job ? job : { text: '', error: 'Nothing to read.' };
});
ipcMain.handle('text:copy', (e, text) => { clipboard.writeText(String(text || '')); return true; });
ipcMain.handle('editor:ocr', (e, buffer) => readText(nativeImage.createFromBuffer(Buffer.from(buffer))));
ipcMain.handle('editor:pin', (e, buffer) => openPin(nativeImage.createFromBuffer(Buffer.from(buffer))));

// Pinned captures -----------------------------------------------------------

ipcMain.handle('pin:config', (e) => {
  const pin = pins.get(e.sender.id);
  return pin ? { bytes: pin.bytes, width: pin.width, height: pin.height } : null;
});

ipcMain.handle('pin:move', (e, dx, dy) => {
  const win = senderWindow(e);
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.handle('pin:zoom', (e, factor) => {
  const win = senderWindow(e);
  const pin = pins.get(e.sender.id);
  if (!win || !pin) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  let w = Math.round(b.width * factor);
  w = Math.max(80, Math.min(w, Math.round(wa.width * 1.5)));
  const h = Math.round(w / pin.aspect);
  win.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: Math.round(b.y + (b.height - h) / 2), width: w, height: h });
});

ipcMain.handle('pin:menu', (e) => {
  const win = senderWindow(e);
  const pin = pins.get(e.sender.id);
  if (!win || !pin) return;
  const image = nativeImage.createFromBuffer(pin.bytes);
  const setOpacity = (v) => win.setOpacity(v);
  Menu.buildFromTemplate([
    { label: 'Copy image', click: () => copyImageToClipboard(image) },
    { label: 'Copy text in image', click: () => readText(image) },
    { label: 'Open in editor', click: () => finishCapture(image) },
    { type: 'separator' },
    {
      label: 'Opacity',
      submenu: [1, 0.8, 0.6, 0.4].map((v) => ({ label: `${Math.round(v * 100)}%`, type: 'radio', checked: Math.abs(win.getOpacity() - v) < 0.01, click: () => setOpacity(v) })),
    },
    {
      label: 'Actual size',
      click: () => {
        const d = screen.getDisplayMatching(win.getBounds());
        const b = win.getBounds();
        win.setBounds({ x: b.x, y: b.y, width: Math.round(pin.width / d.scaleFactor), height: Math.round(pin.height / d.scaleFactor) });
      },
    },
    { type: 'separator' },
    { label: 'Close', click: () => win.close() },
    { label: 'Close all pinned captures', click: closeAllPins },
  ]).popup({ window: win });
});

ipcMain.handle('pin:close', (e) => { const w = senderWindow(e); if (w) w.close(); });

// Camera bubble -------------------------------------------------------------

ipcMain.handle('camera:move', (e, dx, dy) => {
  const win = senderWindow(e);
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.handle('camera:size', (e, index) => {
  const win = senderWindow(e);
  if (!win) return CAMERA_SIZES[1];
  const size = CAMERA_SIZES[((index % CAMERA_SIZES.length) + CAMERA_SIZES.length) % CAMERA_SIZES.length];
  const b = win.getBounds();
  // Grow and shrink around the bottom-left corner, where the bubble usually sits.
  win.setBounds({ x: b.x, y: b.y + b.height - size, width: size, height: size });
  return size;
});

ipcMain.handle('camera:close', () => closeCamera());

// Step capture --------------------------------------------------------------

ipcMain.handle('steps:config', async () => {
  let sources = [];
  try { sources = await getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }); } catch { /* fall back to screenshots */ }
  const displays = screen.getAllDisplays();
  return displays.map((d, i) => {
    const src = sources.find((s) => s.display_id && s.display_id === String(d.id)) || sources[i];
    return { displayId: String(d.id), sourceId: src ? src.id : null, pixelSize: displayPixelSize(d) };
  });
});

ipcMain.handle('steps:frame', (e, { id, png, width }) => {
  const s = stepSession;
  if (!s || !s.pending.has(id)) return;
  const { pt, display } = s.pending.get(id);
  s.pending.delete(id);
  addStep(Buffer.from(png), width / display.bounds.width, pt, display);
});

ipcMain.handle('steps:pause', (e, paused) => { if (stepSession) stepSession.paused = !!paused; });
ipcMain.handle('steps:done', () => finishStepCapture(true));
ipcMain.handle('steps:cancel', () => finishStepCapture(false));

// Guides --------------------------------------------------------------------

function guideDirFor(e) { return guides.get(e.sender.id); }

function guideStepPath(dir, file) {
  const full = path.join(dir, path.basename(String(file)));
  return fs.existsSync(full) ? full : null;
}

ipcMain.handle('guide:config', (e) => {
  const dir = guideDirFor(e);
  const guide = dir && readGuide(dir);
  if (!guide) return null;
  return {
    dir,
    folder: path.basename(dir),
    title: guide.title,
    created: guide.created,
    steps: guide.steps.map((step) => {
      const full = path.join(dir, step.file);
      let v = 0;
      try { v = fs.statSync(full).mtimeMs; } catch { /* missing */ }
      return { ...step, url: pathToFileURL(full).href + '?v=' + v };
    }),
  };
});

ipcMain.handle('guide:update', (e, update) => {
  const dir = guideDirFor(e);
  const guide = dir && readGuide(dir);
  if (!guide) return false;
  if (typeof update.title === 'string') guide.title = update.title.slice(0, 200);
  if (Array.isArray(update.steps)) {
    const known = new Map(guide.steps.map((s) => [s.file, s]));
    guide.steps = update.steps
      .filter((s) => known.has(s.file))
      .map((s) => ({ ...known.get(s.file), title: String(s.title || '').slice(0, 300), text: String(s.text || '').slice(0, 4000) }));
  }
  writeGuide(dir, guide);
  notifyLibrary();
  return true;
});

ipcMain.handle('guide:mark', (e, { file, png }) => {
  const dir = guideDirFor(e);
  const guide = dir && readGuide(dir);
  const full = dir && guideStepPath(dir, file);
  if (!guide || !full) return false;
  fs.writeFileSync(full, Buffer.from(png));
  const step = guide.steps.find((s) => s.file === path.basename(full));
  if (step) step.marked = true;
  writeGuide(dir, guide);
  return true;
});

ipcMain.handle('guide:image', (e, file) => {
  const dir = guideDirFor(e);
  const full = dir && guideStepPath(dir, file);
  return full ? fs.readFileSync(full) : null;
});

ipcMain.handle('guide:edit', (e, file) => {
  const dir = guideDirFor(e);
  const full = dir && guideStepPath(dir, file);
  if (full) openEditor(full);
});

ipcMain.handle('guide:remove', async (e, file) => {
  const dir = guideDirFor(e);
  const guide = dir && readGuide(dir);
  const full = dir && guideStepPath(dir, file);
  if (!guide || !full) return false;
  guide.steps = guide.steps.filter((s) => s.file !== path.basename(full));
  writeGuide(dir, guide);
  await shell.trashItem(full).catch(() => {});
  notifyLibrary();
  return true;
});

ipcMain.handle('guide:reveal', (e) => { const dir = guideDirFor(e); if (dir) shell.openPath(dir); });

ipcMain.handle('guide:export', async (e, format) => {
  const dir = guideDirFor(e);
  const guide = dir && readGuide(dir);
  if (!guide) return { ok: false };
  const win = senderWindow(e);
  const safeTitle = (guide.title || 'Guide').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Guide';
  const ext = format === 'pdf' ? 'pdf' : 'html';
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `${safeTitle}.${ext}`),
    filters: [{ name: ext === 'pdf' ? 'PDF document' : 'Web page', extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  const html = guideHtml(dir, guide);
  if (ext === 'html') {
    fs.writeFileSync(res.filePath, html);
  } else {
    const tmp = path.join(app.getPath('temp'), `loupe-guide-${Date.now()}.html`);
    fs.writeFileSync(tmp, html);
    const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    try {
      await printer.loadFile(tmp);
      const pdf = await printer.webContents.printToPDF({
        pageSize: 'A4', printBackground: true,
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      });
      fs.writeFileSync(res.filePath, pdf);
    } finally {
      printer.destroy();
      fs.rm(tmp, { force: true }, () => {});
    }
  }
  shell.showItemInFolder(res.filePath);
  return { ok: true, name: path.basename(res.filePath) };
});

// Video editor --------------------------------------------------------------

ipcMain.handle('video:config', (e) => {
  const file = videoEditors.get(e.sender.id);
  if (!file) return null;
  return { file, name: path.basename(file), bytes: fs.readFileSync(file) };
});

ipcMain.handle('video:save', (e, { buffer, ext }) => {
  const file = videoEditors.get(e.sender.id);
  if (!file) return { ok: false };
  const dir = isInLibrary(file) ? path.dirname(file) : libraryDir();
  const base = path.basename(file, path.extname(file)).replace(/ \(edited( \d+)?\)$/, '');
  const out = uniquePath(dir, `${base} (edited)`, ext === '.webm' ? '.webm' : '.mp4');
  fs.writeFileSync(out, Buffer.from(buffer));
  notifyLibrary();
  return { ok: true, file: out, name: path.basename(out) };
});

ipcMain.handle('video:reveal', (e, file) => { if (isInLibrary(file)) shell.showItemInFolder(file); });
ipcMain.handle('video:play', (e, file) => { if (isInLibrary(file)) shell.openPath(file); });

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showHome);

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('app.loupe.capture');
    // About Loupe shows the Electron version too, which helps when tracking down problems.
    app.setAboutPanelOptions({
      applicationName: 'Loupe',
      applicationVersion: app.getVersion(),
      version: `Electron ${process.versions.electron}`,
    });
    createUpdater();
    applyDock();
    buildAppMenu();
    buildTray();
    registerShortcuts();
    createHome();
    libraryDir();
    if (isMac) { scheduleUpdateChecks(); announceUpdate(); }
    // Open an image passed on the command line, e.g. `npm start -- path/to/image.png`
    const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /\.(png|jpe?g)$/i.test(a));
    if (arg && fs.existsSync(arg)) openEditor(path.resolve(arg));
  });

  app.on('activate', showHome);
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (stepSession) { try { stepSession.hook.stop(); } catch { /* ignore */ } }
    ocr.shutdown();
  });
  // Keep running in the tray when every window is closed, so the shortcuts keep working.
  app.on('window-all-closed', () => {});
}
