'use strict';

const {
  app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen, Tray, Menu,
  nativeImage, clipboard, dialog, shell, systemPreferences, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const HOTKEYS = {
  region: 'Alt+Shift+1',
  window: 'Alt+Shift+2',
  fullscreen: 'Alt+Shift+3',
  record: 'Alt+Shift+R',
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
let quitting = false;
let busy = false;

let pendingRegion = null;   // state shared with the region overlay
let pickerConfig = null;    // state shared with the source picker
let recorderConfig = null;  // state shared with the recorder bar
const editors = new Map();  // webContents.id -> { file, dirty }
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

function libraryDir() {
  const dir = path.join(app.getPath('pictures'), 'Loupe');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
      + `Details: permission status "${status}"${rawError ? `, error "${rawError}"` : ''}.`,
  });
  if (choice === 0) shell.openExternal(PRIVACY_URL);
  if (choice === 1) { quitting = true; app.quit(); }
}

// Returns false (and explains why) when macOS has definitely refused screen access.
function ensureScreenAccess() {
  const status = screenPermission();
  if (status === 'denied' || status === 'restricted') { showPermissionHelp(); return false; }
  return true; // 'granted', or 'not-determined' which lets macOS show its own prompt
}

// desktopCapturer.getSources, with the macOS permission failure turned into a clear message.
async function getSources(options) {
  try {
    return await desktopCapturer.getSources(options);
  } catch (err) {
    // Only blame the permission when macOS actually reports it as missing; otherwise show the real error.
    if (isMac && screenPermission() !== 'granted') {
      const e = new Error(err.message);
      e.permission = true;
      throw e;
    }
    throw new Error(`Screen capture failed: ${err.message}`);
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
    if (isMac && screenPermission() !== 'granted') {
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

function finishCapture(image) {
  const file = uniquePath(libraryDir(), `Capture ${stamp()}`, '.png');
  fs.writeFileSync(file, image.toPNG());
  clipboard.writeImage(image);
  notifyLibrary();
  openEditor(file);
}

async function captureRegion(mode = 'capture', recordOptions = {}) {
  if (busy || !ensureScreenAccess()) return;
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
  if (busy || !ensureScreenAccess()) return;
  busy = true;
  let restore = () => {};
  try {
    const display = cursorDisplay();
    restore = await hideOwnWindows();
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
}

function createHome() {
  homeWin = new BrowserWindow({
    width: 1040, height: 680, minWidth: 760, minHeight: 500,
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
  if (isMac) overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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

function openEditor(file) {
  const win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 820, minHeight: 540,
    title: `${path.basename(file)} — Loupe`, backgroundColor: '#29323E', show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: webPreferences(),
  });
  const id = win.webContents.id;
  editors.set(id, { file, dirty: false });
  win.setMenuBarVisibility(false);
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'src', 'editor.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  win.on('close', (e) => {
    const state = editors.get(id);
    if (quitting || !state || !state.dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Keep editing', 'Close without saving'], defaultId: 0, cancelId: 0,
      message: 'This capture has changes you haven\'t saved.',
      detail: 'Closing now discards the changes. The original capture stays in your library.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => editors.delete(id));
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
    if (recorderConfig && recorderConfig.restore) recorderConfig.restore();
    recorderConfig = null;
  });

  if (config.rect) openFrame(display, config.rect);
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
// Tray, menu and shortcuts
// ---------------------------------------------------------------------------

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Loupe');
  const menu = Menu.buildFromTemplate([
    { label: 'Capture region', accelerator: HOTKEYS.region, click: () => captureRegion() },
    { label: 'Capture window', accelerator: HOTKEYS.window, click: captureWindow },
    { label: 'Capture full screen', accelerator: HOTKEYS.fullscreen, click: captureFullscreen },
    { label: 'Record screen', accelerator: HOTKEYS.record, click: startRecording },
    { type: 'separator' },
    { label: 'Open Loupe', click: showHome },
    { label: 'Open captures folder', click: () => shell.openPath(libraryDir()) },
    { type: 'separator' },
    { label: 'Quit Loupe', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { if (!isMac) showHome(); });
}

function buildAppMenu() {
  if (!isMac) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Capture',
      submenu: [
        { label: 'Region', accelerator: HOTKEYS.region, click: () => captureRegion() },
        { label: 'Window', accelerator: HOTKEYS.window, click: captureWindow },
        { label: 'Full screen', accelerator: HOTKEYS.fullscreen, click: captureFullscreen },
        { label: 'Record screen', accelerator: HOTKEYS.record, click: startRecording },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

function registerShortcuts() {
  const bind = (name, accel, fn) => {
    try { registeredKeys[name] = globalShortcut.register(accel, fn); } catch { registeredKeys[name] = false; }
  };
  bind('region', HOTKEYS.region, () => captureRegion());
  bind('window', HOTKEYS.window, captureWindow);
  bind('fullscreen', HOTKEYS.fullscreen, captureFullscreen);
  bind('record', HOTKEYS.record, startRecording);
  if (EXTRA_REGION_KEY) bind('printscreen', EXTRA_REGION_KEY, () => captureRegion());
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function senderWindow(event) { return BrowserWindow.fromWebContents(event.sender); }

ipcMain.handle('app:info', () => ({
  platform: process.platform,
  permission: screenPermission(),
  hotkeys: Object.fromEntries(Object.entries(HOTKEYS).map(([k, v]) => [k, { label: hotkeyLabel(v), ok: registeredKeys[k] !== false }])),
  printScreen: !!registeredKeys.printscreen,
  libraryDir: libraryDir(),
}));

ipcMain.handle('capture:region', () => captureRegion());
ipcMain.handle('capture:window', () => captureWindow());
ipcMain.handle('capture:fullscreen', () => captureFullscreen());
ipcMain.handle('record:start', () => startRecording());

ipcMain.handle('capture:clipboard', () => {
  const image = clipboard.readImage();
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
      const ext = path.extname(name).toLowerCase();
      const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
      if (!kind) return null;
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return { file, name, kind, url: pathToFileURL(file).href + '?v=' + stat.mtimeMs, mtime: stat.mtimeMs, size: stat.size };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 300);
});

ipcMain.handle('library:open', (e, file) => {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) openEditor(file);
  else shell.openPath(file);
});
ipcMain.handle('library:reveal', (e, file) => shell.showItemInFolder(file));
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

  if (p.mode === 'capture') {
    const size = p.image.getSize();
    const ratio = size.width / p.display.bounds.width;
    const x = Math.max(0, Math.round(rect.x * ratio));
    const y = Math.max(0, Math.round(rect.y * ratio));
    const crop = {
      x, y,
      width: Math.max(1, Math.min(size.width - x, Math.round(rect.width * ratio))),
      height: Math.max(1, Math.min(size.height - y, Math.round(rect.height * ratio))),
    };
    p.restore();
    finishCapture(p.image.crop(crop));
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

ipcMain.handle('picker:config', () => ({ ...pickerConfig, platform: process.platform }));

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
    mic: !!choice.mic, systemAudio: !!choice.systemAudio,
  });
});

ipcMain.handle('picker:region', (e, options) => {
  closePicker();
  setTimeout(() => captureRegion('record', { mic: !!options.mic, systemAudio: !!options.systemAudio }), 150);
});

ipcMain.handle('picker:cancel', () => closePicker());

// Recorder -----------------------------------------------------------------

ipcMain.handle('recorder:config', () => {
  if (!recorderConfig) return null;
  const { sourceId, kind, rect, mic, systemAudio, display } = recorderConfig;
  return {
    sourceId, kind, rect, mic, systemAudio,
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
  showHome();
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
    inLibrary: isInLibrary(state.file),
    bytes: fs.readFileSync(state.file),
  };
});

ipcMain.handle('editor:dirty', (e, dirty) => {
  const state = editors.get(e.sender.id);
  if (state) state.dirty = !!dirty;
  const win = senderWindow(e);
  if (win && state) win.setTitle(`${dirty ? '• ' : ''}${path.basename(state.file)} — Loupe`);
});

function writeImage(file, buffer) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    fs.writeFileSync(file, nativeImage.createFromBuffer(Buffer.from(buffer)).toJPEG(90));
  } else {
    fs.writeFileSync(file, Buffer.from(buffer));
  }
}

async function saveAs(event, buffer) {
  const state = editors.get(event.sender.id);
  const win = senderWindow(event);
  const defaultPath = state ? state.file.replace(/\.(png|jpe?g)$/i, '') + ' (edited).png' : 'Capture.png';
  const res = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: 'PNG image', extensions: ['png'] }, { name: 'JPEG image', extensions: ['jpg'] }],
  });
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
  if (!state || !isInLibrary(state.file)) return saveAs(e, buffer);
  writeImage(state.file, buffer);
  state.dirty = false;
  const win = senderWindow(e);
  if (win) win.setTitle(`${path.basename(state.file)} — Loupe`);
  notifyLibrary();
  return { ok: true, file: state.file, name: path.basename(state.file) };
});

ipcMain.handle('editor:saveAs', (e, buffer) => saveAs(e, buffer));

ipcMain.handle('editor:copy', (e, buffer) => {
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(buffer)));
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showHome);

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('app.loupe.capture');
    buildAppMenu();
    buildTray();
    registerShortcuts();
    createHome();
    libraryDir();
    // Open an image passed on the command line, e.g. `npm start -- path/to/image.png`
    const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /\.(png|jpe?g)$/i.test(a));
    if (arg && fs.existsSync(arg)) openEditor(path.resolve(arg));
  });

  app.on('activate', showHome);
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Keep running in the tray when every window is closed, so the shortcuts keep working.
  app.on('window-all-closed', () => {});
}
