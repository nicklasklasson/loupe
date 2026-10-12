'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:info', 'app:permissionHelp',
  'capture:region', 'capture:window', 'capture:fullscreen', 'capture:clipboard', 'capture:openFile',
  'record:start', 'capture:text', 'steps:start', 'timer:get', 'timer:set', 'timer:seconds',
  'closing:get', 'closing:set',
  'update:state', 'update:check', 'update:install', 'update:cancel', 'update:release-page', 'update:auto',
  'text:config', 'text:copy', 'editor:ocr', 'editor:pin',
  'pin:config', 'pin:move', 'pin:zoom', 'pin:menu', 'pin:close',
  'camera:move', 'camera:size', 'camera:close',
  'steps:config', 'steps:frame', 'steps:pause', 'steps:done', 'steps:cancel',
  'guide:config', 'guide:image', 'guide:update', 'guide:mark', 'guide:edit', 'guide:remove', 'guide:reveal', 'guide:export',
  'video:config', 'video:save', 'video:reveal', 'video:play',
  'library:play', 'library:pin',
  'library:list', 'library:open', 'library:reveal', 'library:folder', 'library:trash', 'library:choose', 'library:resetFolder',
  'overlay:config', 'overlay:done',
  'picker:config', 'picker:choose', 'picker:region', 'picker:cancel', 'sources:list',
  'recorder:config', 'recorder:save', 'recorder:close', 'recorder:error',
  'editor:config', 'editor:dirty', 'editor:save', 'editor:saveAs', 'editor:copy', 'editor:copied', 'editor:close',
]);

const EVENTS = new Set(['library:changed', 'steps:grab', 'steps:count', 'timer:changed', 'closing:changed', 'update:state', 'editor:save-and-close']);

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
