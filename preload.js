'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:info', 'app:permissionHelp',
  'capture:region', 'capture:window', 'capture:fullscreen', 'capture:clipboard', 'capture:openFile',
  'record:start',
  'library:list', 'library:open', 'library:reveal', 'library:folder', 'library:trash',
  'overlay:config', 'overlay:done',
  'picker:config', 'picker:choose', 'picker:region', 'picker:cancel', 'sources:list',
  'recorder:config', 'recorder:save', 'recorder:close', 'recorder:error',
  'editor:config', 'editor:dirty', 'editor:save', 'editor:saveAs', 'editor:copy',
]);

const EVENTS = new Set(['library:changed']);

contextBridge.exposeInMainWorld('loupe', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked channel: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
