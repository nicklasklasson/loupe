import { probe, cutVideo, cutVideoRealtime, normaliseCuts, keptRanges } from './videocut.js';

const api = window.loupe;
const $ = (s) => document.querySelector(s);
const video = $('#video');
const track = $('#track');

let file = null;
let blob = null;
let duration = 0;
let cuts = [];          // removed ranges [[start, end], ...]
let sel = null;         // current selection { a, b }
let saving = false;
let skipTimer = 0;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function fmt(t, precise = true) {
  if (!Number.isFinite(t)) t = 0;
  const neg = t < 0;
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const sec = precise ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${neg ? '-' : ''}${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${sec}`;
}

// Accepts "83", "83.5", "1:23", "1:23.5" and "1:02:03".
function parse(str) {
  const clean = String(str).trim().replace(',', '.');
  if (!clean) return NaN;
  if (!/^[\d:.]+$/.test(clean)) return NaN;
  const parts = clean.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const clamp = (t) => Math.min(duration, Math.max(0, t));
const pct = (t) => `${(duration ? (t / duration) * 100 : 0).toFixed(4)}%`;

function setStatus(text) { $('#status').textContent = text; }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function keptDuration() {
  return keptRanges(cuts, duration).reduce((sum, [a, b]) => sum + (b - a), 0);
}

function renderTimeline() {
  track.querySelectorAll('.cut').forEach((el) => el.remove());
  for (const [a, b] of cuts) {
    const el = document.createElement('div');
    el.className = 'cut';
    el.style.left = pct(a);
    el.style.width = pct(b - a);
    track.insertBefore(el, track.firstChild);
  }
  const hasSel = !!sel && sel.b - sel.a > 0.01;
  $('#sel').hidden = !sel;
  $('#hIn').hidden = !sel;
  $('#hOut').hidden = !sel;
  if (sel) {
    $('#sel').style.left = pct(sel.a);
    $('#sel').style.width = pct(Math.max(0, sel.b - sel.a));
    $('#hIn').style.left = pct(sel.a);
    $('#hOut').style.left = pct(sel.b);
  }
  $('#remove').disabled = !hasSel || saving;
  $('#selLen').textContent = hasSel ? `${(sel.b - sel.a).toFixed(1)} s selected` : '';
  if (document.activeElement !== $('#from')) $('#from').value = sel ? fmt(sel.a) : '';
  if (document.activeElement !== $('#to')) $('#to').value = sel ? fmt(sel.b) : '';

  const chips = $('#cuts');
  chips.innerHTML = '';
  cuts.forEach(([a, b], i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `Removed ${fmt(a)}–${fmt(b)}`;
    const undo = document.createElement('button');
    undo.textContent = 'Restore';
    undo.addEventListener('click', () => { cuts.splice(i, 1); changed(); });
    chip.appendChild(undo);
    chips.appendChild(chip);
  });

  $('#dims').textContent = cuts.length
    ? `${fmt(duration)} → ${fmt(keptDuration())} after removing ${cuts.length} part${cuts.length === 1 ? '' : 's'}`
    : `${fmt(duration)} · ${video.videoWidth || '?'} × ${video.videoHeight || '?'}`;
  $('#save').disabled = !cuts.length || saving;
}

function renderPlayhead() {
  $('#playhead').style.left = pct(video.currentTime);
  $('#time').textContent = `${fmt(video.currentTime)} / ${fmt(duration)}`;
}

function renderTicks() {
  const ticks = $('#ticks');
  ticks.innerHTML = '';
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const span = document.createElement('span');
    span.textContent = fmt((duration * i) / n, duration < 60); // tenths when the video is short
    ticks.appendChild(span);
  }
}

function changed() {
  cuts = normaliseCuts(cuts, duration);
  renderTimeline();
}

// ---------------------------------------------------------------------------
// Playback: removed parts are skipped, so you can check the result before saving
// ---------------------------------------------------------------------------

function skipCuts() {
  const t = video.currentTime;
  for (const [a, b] of cuts) {
    if (t >= a && t < b - 0.01) {
      if (b >= duration - 0.05) { video.pause(); video.currentTime = duration; }
      else video.currentTime = b;
      return;
    }
  }
}

video.addEventListener('play', () => {
  $('#play').textContent = 'Pause';
  clearInterval(skipTimer);
  skipTimer = setInterval(() => { skipCuts(); renderPlayhead(); }, 30);
});
video.addEventListener('pause', () => { $('#play').textContent = 'Play'; clearInterval(skipTimer); renderPlayhead(); });
video.addEventListener('ended', () => { $('#play').textContent = 'Play'; });
video.addEventListener('timeupdate', renderPlayhead);
video.addEventListener('seeked', renderPlayhead);

function togglePlay() {
  if (!duration) return;
  if (video.paused) {
    if (video.currentTime >= duration - 0.05) video.currentTime = 0;
    video.play();
  } else video.pause();
}
$('#play').addEventListener('click', togglePlay);

// ---------------------------------------------------------------------------
// Selecting what to remove
// ---------------------------------------------------------------------------

function timeAt(clientX) {
  const r = track.getBoundingClientRect();
  return clamp(((clientX - r.left) / r.width) * duration);
}

function setSel(a, b) {
  a = clamp(a);
  b = clamp(b);
  sel = { a: Math.min(a, b), b: Math.max(a, b) };
  renderTimeline();
}

let drag = null;
track.addEventListener('pointerdown', (e) => {
  if (!duration || saving) return;
  track.setPointerCapture(e.pointerId);
  const t = timeAt(e.clientX);
  if (e.target.id === 'hIn' || e.target.id === 'hOut') {
    drag = { mode: e.target.id, moved: true };
    return;
  }
  drag = { mode: 'new', start: t, moved: false, x: e.clientX };
  video.currentTime = t;
});
track.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const t = timeAt(e.clientX);
  if (drag.mode === 'hIn') setSel(t, sel.b);
  else if (drag.mode === 'hOut') setSel(sel.a, t);
  else if (Math.abs(e.clientX - drag.x) > 3) { drag.moved = true; setSel(drag.start, t); }
  video.currentTime = t;
});
track.addEventListener('pointerup', () => { drag = null; });

function markIn() {
  const t = video.currentTime;
  setSel(t, sel && sel.b > t ? sel.b : Math.min(duration, t + 1));
}
function markOut() {
  const t = video.currentTime;
  setSel(sel && sel.a < t ? sel.a : Math.max(0, t - 1), t);
}
$('#markIn').addEventListener('click', markIn);
$('#markOut').addEventListener('click', markOut);

function fromFields() {
  const a = parse($('#from').value);
  const b = parse($('#to').value);
  $('#from').classList.toggle('bad', $('#from').value !== '' && !Number.isFinite(a));
  $('#to').classList.toggle('bad', $('#to').value !== '' && !Number.isFinite(b));
  if (Number.isFinite(a) && Number.isFinite(b)) setSel(a, b);
  else if (Number.isFinite(a) && !sel) setSel(a, Math.min(duration, a + 1));
}
['#from', '#to'].forEach((id) => {
  $(id).addEventListener('change', fromFields);
  $(id).addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { fromFields(); if (sel) removeSelection(); }
  });
});

function removeSelection() {
  if (!sel || sel.b - sel.a <= 0.01) return;
  const next = normaliseCuts([...cuts, [sel.a, sel.b]], duration);
  if (keptRanges(next, duration).reduce((s, [a, b]) => s + (b - a), 0) < 0.2) {
    setStatus('That would remove the whole video. Select a smaller part.');
    return;
  }
  cuts = next;
  const end = sel.b;
  sel = null;
  changed();
  video.currentTime = Math.min(end, duration);
  setStatus('Part removed. Press Play to check the result, then save.');
}
$('#remove').addEventListener('click', removeSelection);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (cuts.length) { cuts.pop(); changed(); } return; }
  if (mod) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key.toLowerCase() === 'i') markIn();
  else if (e.key.toLowerCase() === 'o') markOut();
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelection(); }
  else if (e.key === 'Escape') { sel = null; renderTimeline(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1);
    video.pause();
    video.currentTime = clamp(video.currentTime + step);
  }
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function showProgress(fraction) {
  $('#progress').hidden = false;
  $('#bar').style.width = `${Math.round(fraction * 100)}%`;
}

async function save() {
  if (saving || !cuts.length) return;
  saving = true;
  video.pause();
  renderTimeline();
  showProgress(0);
  setStatus('Saving…');
  try {
    let result;
    try {
      result = await cutVideo(blob, cuts, (f) => { showProgress(f); setStatus(`Saving… ${Math.round(f * 100)}%`); });
    } catch (err) {
      // "Nothing left" is the person's choice to fix; anything else means the fast method couldn't
      // handle this file, so fall back to playing it back and re-recording it.
      if (/Nothing would be left/.test(err.message)) throw err;
      console.warn('Fast save failed, using real-time save:', err && (err.name + ': ' + err.message));
      setStatus(`Saving in real time, which takes about ${fmt(keptDuration(), false)}. Keep this window open.`);
      result = await cutVideoRealtime(blob, cuts, duration, (f) => showProgress(f));
    }
    const res = await api.invoke('video:save', { buffer: result.buffer, ext: result.ext });
    if (!res.ok) throw new Error('The file could not be written.');
    setStatus(`Saved ${res.name} (${fmt(result.duration)}). The original recording is unchanged.${result.withoutSound ? ' The sound could not be included this time.' : ''}`);
    lastSaved = res.file;
  } catch (err) {
    console.error('Save failed:', err && (err.name + ': ' + err.message));
    setStatus(`Couldn't save: ${err.message}`);
  } finally {
    saving = false;
    $('#progress').hidden = true;
    renderTimeline();
  }
}
let lastSaved = null;
$('#save').addEventListener('click', save);
$('#reveal').addEventListener('click', () => api.invoke('video:reveal', lastSaved || file));
$('#player').addEventListener('click', () => api.invoke('video:play', lastSaved || file));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init() {
  const cfg = await api.invoke('video:config');
  if (!cfg) { setStatus('This video could not be opened.'); return; }
  file = cfg.file;
  $('#name').textContent = cfg.name;
  $('#name').title = cfg.file;
  const type = /\.webm$/i.test(cfg.name) ? 'video/webm' : 'video/mp4';
  blob = new Blob([cfg.bytes], { type });
  video.src = URL.createObjectURL(blob);

  await new Promise((res) => {
    if (video.readyState >= 1) res();
    else video.addEventListener('loadedmetadata', res, { once: true });
  });
  try {
    duration = (await probe(blob)).duration;
  } catch {
    duration = Number.isFinite(video.duration) ? video.duration : 0;
  }
  if (!duration) { setStatus('Couldn\'t read the length of this video.'); return; }
  $('#play').disabled = false;
  renderTicks();
  renderTimeline();
  renderPlayhead();
}

init();
