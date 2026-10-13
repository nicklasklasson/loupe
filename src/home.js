'use strict';

const $ = (s) => document.querySelector(s);
const api = window.loupe;

$('#region').addEventListener('click', () => api.invoke('capture:region'));
$('#window').addEventListener('click', () => api.invoke('capture:window'));
$('#fullscreen').addEventListener('click', () => api.invoke('capture:fullscreen'));
$('#record').addEventListener('click', () => api.invoke('record:start'));
$('#text').addEventListener('click', () => api.invoke('capture:text'));
$('#steps').addEventListener('click', () => api.invoke('steps:start'));
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

// Timer switches -------------------------------------------------------------

async function renderTimers() {
  const t = await api.invoke('timer:get');
  document.querySelectorAll('.timer').forEach((row) => {
    const action = row.dataset.action;
    const box = row.querySelector('input');
    box.checked = !!t.timer[action];
    const label = row.querySelector('.tlabel');
    label.textContent = action === 'record'
      ? (box.checked ? `${t.seconds} s countdown` : 'Countdown off')
      : (box.checked ? `${t.seconds} s timer` : 'Timer');
  });
  $('#timerSeconds').value = String(t.seconds);
}

document.querySelectorAll('.timer').forEach((row) => {
  row.querySelector('input').addEventListener('change', (e) => api.invoke('timer:set', row.dataset.action, e.target.checked));
});
$('#timerSeconds').addEventListener('change', (e) => api.invoke('timer:seconds', Number(e.target.value)));
api.on('timer:changed', renderTimers);

// Closing capture windows ----------------------------------------------------

function renderClosing(c) {
  $('#closeAfterCopy').checked = !!c.closeAfterCopy;
  $('#autoClose').value = String(c.autoCloseSeconds);
}
$('#closeAfterCopy').addEventListener('change', (e) => api.invoke('closing:set', { closeAfterCopy: e.target.checked }));
$('#autoClose').addEventListener('change', (e) => api.invoke('closing:set', { autoCloseSeconds: Number(e.target.value) }));
api.on('closing:changed', renderClosing);

$('#showInDock').addEventListener('change', (e) => api.invoke('dock:set', e.target.checked));

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
    } else if (item.kind === 'guide') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = item.url;
      img.alt = '';
      thumb.appendChild(img);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `Guide · ${item.steps} step${item.steps === 1 ? '' : 's'}`;
      tile.appendChild(badge);
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
    name.textContent = displayName(item.name).replace(/^(Capture|Recording|Guide) /, '') || item.name;
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
    if (item.kind === 'image') {
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.title = 'Copy the image to the clipboard';
      copy.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await api.invoke('library:copy', item.file);
        copy.textContent = ok ? 'Copied' : 'Failed';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
      tools.append(copy);
      const pin = document.createElement('button');
      pin.textContent = 'Pin';
      pin.title = 'Keep on top of other windows';
      pin.addEventListener('click', (e) => { e.stopPropagation(); api.invoke('library:pin', item.file); });
      tools.append(pin);
    }
    if (item.kind === 'video') {
      const play = document.createElement('button');
      play.textContent = 'Play';
      play.title = 'Open in your video player';
      play.addEventListener('click', (e) => { e.stopPropagation(); api.invoke('library:play', item.file); });
      tools.append(play);
    }
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
  renderTimers();
  renderClosing(await api.invoke('closing:get'));
  const dock = await api.invoke('dock:get');
  if (dock.supported) { $('#dockRow').hidden = false; $('#showInDock').checked = dock.showInDock; }
}

api.on('library:changed', renderLibrary);
window.addEventListener('focus', renderLibrary);
init();
