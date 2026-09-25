'use strict';

const $ = (s) => document.querySelector(s);
const api = window.loupe;

$('#region').addEventListener('click', () => api.invoke('capture:region'));
$('#window').addEventListener('click', () => api.invoke('capture:window'));
$('#fullscreen').addEventListener('click', () => api.invoke('capture:fullscreen'));
$('#record').addEventListener('click', () => api.invoke('record:start'));
$('#openFile').addEventListener('click', () => api.invoke('capture:openFile'));
$('#folder').addEventListener('click', () => api.invoke('library:folder'));
$('#chooseFolder').addEventListener('click', async () => {
  const res = await api.invoke('library:choose');
  if (!res.ok && res.reason) showNotice(res.reason);
  else if (res.ok) showNotice('');
});
$('#resetFolder').addEventListener('click', () => api.invoke('library:resetFolder'));

function showFolder(info) {
  $('#where').textContent = info.libraryLabel;
  $('#where').title = info.libraryDir;
  $('#resetFolder').hidden = info.libraryIsDefault;
  const fb = $('#fallback');
  fb.hidden = !info.libraryFallback;
  if (info.libraryFallback) {
    fb.textContent = `Loupe can't reach ${info.libraryFallback} right now, so new captures go to ${info.libraryLabel}. Reconnect the drive, or choose another folder.`;
  }
}
$('#paste').addEventListener('click', async () => {
  const res = await api.invoke('capture:clipboard');
  if (!res.ok) showNotice(res.reason);
});

function showNotice(text) {
  const el = $('#notice');
  el.innerHTML = '';
  if (!text) return;
  const p = document.createElement('p');
  p.className = 'notice';
  p.textContent = text;
  el.appendChild(p);
}

function formatDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function displayName(name) {
  return name.replace(/\.(png|jpe?g|webm|mp4)$/i, '');
}

let renderToken = 0;
async function renderLibrary() {
  const token = ++renderToken;
  const [items, info] = await Promise.all([api.invoke('library:list'), api.invoke('app:info')]);
  if (token !== renderToken) return; // a newer refresh is on its way
  showFolder(info);
  const grid = document.createDocumentFragment();
  $('#count').textContent = items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `<p>Your captures and recordings appear here.</p>`;
    const hint = document.createElement('span');
    hint.innerHTML = `Press <kbd></kbd> anywhere to capture a region.`;
    hint.querySelector('kbd').textContent = info.hotkeys.region.label;
    empty.appendChild(hint);
    grid.appendChild(empty);
    $('#grid').replaceChildren(grid);
    return;
  }

  for (const item of items) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.tabIndex = 0;
    tile.title = item.name;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = item.url;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      const v = document.createElement('video');
      v.src = item.url;
      v.muted = true;
      v.preload = 'metadata';
      thumb.appendChild(v);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Video';
      tile.appendChild(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = displayName(item.name).replace(/^(Capture|Recording) /, '') || item.name;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = formatDate(item.mtime);
    meta.append(name, kind);

    const tools = document.createElement('div');
    tools.className = 'tools';
    const reveal = document.createElement('button');
    reveal.textContent = 'Show';
    reveal.title = 'Show in folder';
    reveal.addEventListener('click', (e) => { e.stopPropagation(); api.invoke('library:reveal', item.file); });
    const trash = document.createElement('button');
    trash.textContent = 'Delete';
    trash.title = 'Move to trash';
    trash.addEventListener('click', (e) => { e.stopPropagation(); api.invoke('library:trash', item.file); });
    tools.append(reveal, trash);

    thumb.appendChild(tools);
    tile.append(thumb, meta);
    const open = () => api.invoke('library:open', item.file);
    tile.addEventListener('click', open);
    tile.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    grid.appendChild(tile);
  }
  $('#grid').replaceChildren(grid);
}

async function init() {
  const info = await api.invoke('app:info');
  document.querySelectorAll('kbd[data-key]').forEach((k) => {
    const hk = info.hotkeys[k.dataset.key];
    k.textContent = hk ? hk.label : '';
    if (hk && !hk.ok) { k.title = 'Another app is using this shortcut'; k.style.textDecoration = 'line-through'; }
  });
  renderLibrary();
}

api.on('library:changed', renderLibrary);
window.addEventListener('focus', renderLibrary);
init();
