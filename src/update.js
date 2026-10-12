'use strict';

// The Check for Updates window: shows what src/updater.js is doing and drives it.

const $ = (s) => document.querySelector(s);
const api = window.loupe;

let state = null;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const button = (label, onClick, cls) => {
  const b = el('button', cls, label);
  b.addEventListener('click', onClick);
  return b;
};
const formatBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

function render() {
  const u = state;
  const nodes = [];
  $('#current').textContent = u ? `You have Loupe ${u.current}` : '';
  if (!u || u.phase === 'checking') {
    const busy = el('div', 'busy'); busy.append(el('span', 'spinner'), el('span', '', 'Checking GitHub for a newer version…'));
    nodes.push(busy);
  } else if (u.phase === 'downloading') {
    const pct = u.total ? Math.min(100, (u.received / u.total) * 100) : 0;
    nodes.push(el('div', 'line', `Downloading Loupe ${u.latest}…`));
    const bar = el('div', 'progress'); bar.append(el('div')); bar.firstChild.style.width = `${pct.toFixed(1)}%`;
    nodes.push(bar);
    const row = el('div', 'actions');
    row.append(el('span', 'muted', `${formatBytes(u.received)}${u.total ? ` of ${formatBytes(u.total)}` : ''}`), button('Cancel', () => api.invoke('update:cancel'), 'link'));
    nodes.push(row);
  } else if (u.phase === 'verifying') {
    const busy = el('div', 'busy'); busy.append(el('span', 'spinner'), el('span', '', 'Checking the download is signed with the Loupe certificate…'));
    nodes.push(busy);
  } else if (u.phase === 'installing' || u.phase === 'restarting') {
    const busy = el('div', 'busy'); busy.append(el('span', 'spinner'), el('span', '', `Installing Loupe ${u.latest}. Loupe restarts in a moment.`));
    nodes.push(busy);
  } else if (u.available) {
    const line = el('div', 'line'); line.append(el('strong', '', `Loupe ${u.latest} is available.`));
    nodes.push(line);
    if (u.notes) nodes.push(el('div', 'notes', u.notes));
    else if (u.notes === null) nodes.push(el('div', 'muted', 'Loading what’s new…'));
    if (u.error) nodes.push(el('div', u.errorReason === 'admin' ? 'notice' : 'error', u.error));
    const row = el('div', 'actions');
    row.append(
      button(u.errorReason === 'admin' ? 'Try again' : 'Install and restart', () => api.invoke('update:install'), 'primary'),
      button('What’s new on GitHub', () => api.invoke('update:release-page')),
      button('Later', () => window.close()),
    );
    nodes.push(row);
    nodes.push(el('div', 'muted', 'Installing needs Administrator Mode. Loupe checks the download is signed with the Loupe certificate before installing it.'));
  } else {
    if (u.error) nodes.push(el('div', 'error', u.error));
    else { const line = el('div', 'line'); line.append(el('strong', '', `Loupe ${u.current} is up to date.`)); nodes.push(line); }
    if (u.checkedAt) nodes.push(el('div', 'muted', `Checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`));
    const row = el('div', 'actions'); row.append(button('Check again', () => api.invoke('update:check')));
    nodes.push(row);
  }
  $('#body').replaceChildren(...nodes);
}

api.on('update:state', (u) => { state = u; render(); });
$('#auto').addEventListener('change', (e) => api.invoke('update:auto', e.target.checked));

(async () => {
  $('#auto').checked = await api.invoke('update:auto');
  state = await api.invoke('update:state');
  render();
})();
