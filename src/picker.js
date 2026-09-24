'use strict';

const api = window.loupe;
const $ = (s) => document.querySelector(s);
let config = { mode: 'capture' };
let type = 'window';
let loading = false;
let permissionShown = false;

function audioOptions() {
  return { mic: $('#mic').checked, systemAudio: !$('#sysWrap').hidden && $('#sys').checked };
}

function regionTile() {
  const b = document.createElement('button');
  b.className = 'source region';
  b.innerHTML = `
    <div class="frame"><svg viewBox="0 0 46 46"><path d="M5 14V7a2 2 0 0 1 2-2h7M32 5h7a2 2 0 0 1 2 2v7M41 32v7a2 2 0 0 1-2 2h-7M14 41H7a2 2 0 0 1-2-2v-7" /><path d="M23 17v12M17 23h12"/></svg></div>
    <div class="name"><span>Select an area…</span></div>`;
  b.addEventListener('click', () => api.invoke('picker:region', audioOptions()));
  return b;
}

async function load() {
  if (loading) return;
  loading = true;
  $('#status').textContent = 'Loading…';
  const grid = $('#grid');
  try {
    const res = await api.invoke('sources:list', [type]);
    grid.innerHTML = '';
    if (!res.ok) {
      $('#status').textContent = res.permission
        ? 'macOS is blocking screen access. Allow it in Screen Recording settings, then restart Loupe.'
        : `Couldn't list sources: ${res.message}`;
      if (res.permission && !permissionShown) { permissionShown = true; api.invoke('app:permissionHelp', res.message); }
      return;
    }
    const sources = res.sources;
    if (config.mode === 'record' && type === 'screen') grid.appendChild(regionTile());
    for (const s of sources) {
      const b = document.createElement('button');
      b.className = 'source';
      const frame = document.createElement('div');
      frame.className = 'frame';
      frame.style.backgroundImage = `url("${s.thumb}")`;
      const name = document.createElement('div');
      name.className = 'name';
      if (s.icon) { const i = document.createElement('img'); i.src = s.icon; i.alt = ''; name.appendChild(i); }
      const label = document.createElement('span');
      label.textContent = s.name || (s.kind === 'screen' ? 'Screen' : 'Untitled window');
      name.appendChild(label);
      b.append(frame, name);
      b.title = s.name;
      b.addEventListener('click', () => api.invoke('picker:choose', { id: s.id, kind: s.kind, displayId: s.displayId, ...audioOptions() }));
      grid.appendChild(b);
    }
    const noun = type === 'window' ? 'window' : 'screen';
    $('#status').textContent = sources.length
      ? `${sources.length} ${noun}${sources.length === 1 ? '' : 's'}. Click one to ${config.mode === 'record' ? 'start recording' : 'capture it'}.`
      : `No ${noun}s found. Minimized windows can't be captured; restore the window and refresh.`;
  } catch (err) {
    $('#status').textContent = 'Couldn\'t list sources: ' + err.message;
  } finally {
    loading = false;
  }
}

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    type = btn.dataset.type;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    load();
  });
});

$('#cancel').addEventListener('click', () => api.invoke('picker:cancel'));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.invoke('picker:cancel');
  if (e.key === 'F5') load();
});
window.addEventListener('focus', load);

async function init() {
  config = await api.invoke('picker:config');
  if (config.mode === 'record') {
    $('#title').textContent = 'What do you want to record?';
    document.title = 'Record';
    $('#audio').hidden = false;
    // Capturing computer sound is only supported by Chromium on Windows.
    $('#sysWrap').hidden = config.platform !== 'win32';
    type = 'screen';
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.type === 'screen')));
  }
  load();
}

init();
