'use strict';

const api = window.loupe;
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const hint = document.getElementById('hint');

const LOUPE = 132;      // CSS px diameter of the magnifier
const CELLS = 11;       // image pixels shown across the magnifier
const BRASS = '#C99230';

let img = null;
let sample = null;      // full-resolution copy for colour sampling
let sampleCtx = null;
let scale = 1;          // image px per CSS px
let mode = 'capture';
let cursor = { x: -1, y: -1 };
let start = null;
let sel = null;
let finished = false;
let frame = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestDraw();
}

function requestDraw() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; draw(); });
}

function normRect(a, b) {
  const x = Math.max(0, Math.min(a.x, b.x));
  const y = Math.max(0, Math.min(a.y, b.y));
  const x2 = Math.min(innerWidth, Math.max(a.x, b.x));
  const y2 = Math.min(innerHeight, Math.max(a.y, b.y));
  return { x, y, width: x2 - x, height: y2 - y };
}

function pixelHex(x, y) {
  if (!sampleCtx) return '';
  const ix = Math.min(sample.width - 1, Math.max(0, Math.floor(x * scale)));
  const iy = Math.min(sample.height - 1, Math.max(0, Math.floor(y * scale)));
  const [r, g, b] = sampleCtx.getImageData(ix, iy, 1, 1).data;
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function pill(text, x, y, swatch) {
  ctx.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
  const pad = 8;
  const sw = swatch ? 14 : 0;
  const w = ctx.measureText(text).width + pad * 2 + sw;
  const h = 22;
  const px = Math.min(Math.max(4, x), innerWidth - w - 4);
  const py = Math.min(Math.max(4, y), innerHeight - h - 4);
  ctx.fillStyle = 'rgba(28, 36, 48, 0.92)';
  ctx.beginPath();
  ctx.roundRect(px, py, w, h, 5);
  ctx.fill();
  if (swatch) {
    ctx.fillStyle = swatch;
    ctx.fillRect(px + pad, py + 6, 10, 10);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + pad + 0.5, py + 6.5, 9, 9);
  }
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, px + pad + sw, py + h / 2 + 0.5);
}

function drawLoupe() {
  if (cursor.x < 0) return;
  const gap = 22;
  let lx = cursor.x + gap;
  let ly = cursor.y + gap;
  if (lx + LOUPE > innerWidth - 4) lx = cursor.x - gap - LOUPE;
  if (ly + LOUPE + 30 > innerHeight - 4) ly = cursor.y - gap - LOUPE - 30;

  const cell = LOUPE / CELLS;
  const half = Math.floor(CELLS / 2);
  const ix = Math.floor(cursor.x * scale);
  const iy = Math.floor(cursor.y * scale);

  ctx.save();
  ctx.beginPath();
  ctx.arc(lx + LOUPE / 2, ly + LOUPE / 2, LOUPE / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(lx, ly, LOUPE, LOUPE);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, ix - half, iy - half, CELLS, CELLS, lx, ly, LOUPE, LOUPE);
  // pixel grid
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  for (let i = 1; i < CELLS; i++) {
    ctx.beginPath(); ctx.moveTo(lx + i * cell, ly); ctx.lineTo(lx + i * cell, ly + LOUPE); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(lx, ly + i * cell); ctx.lineTo(lx + LOUPE, ly + i * cell); ctx.stroke();
  }
  // centre pixel
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#000';
  ctx.strokeRect(lx + half * cell, ly + half * cell, cell, cell);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(lx + half * cell + 1.5, ly + half * cell + 1.5, cell - 3, cell - 3);
  ctx.restore();

  // brass rim
  ctx.beginPath();
  ctx.arc(lx + LOUPE / 2, ly + LOUPE / 2, LOUPE / 2, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = BRASS;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(lx + LOUPE / 2, ly + LOUPE / 2, LOUPE / 2 + 2.5, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.stroke();

  const hex = pixelHex(cursor.x, cursor.y);
  const label = sel
    ? `${Math.round(sel.width * scale)} × ${Math.round(sel.height * scale)}`
    : `${ix}, ${iy}   ${hex}`;
  pill(label, lx + LOUPE / 2 - 60, ly + LOUPE + 8, sel ? null : hex);
}

function draw() {
  if (!img) return;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, innerWidth, innerHeight);

  // dim everything outside the selection
  ctx.fillStyle = 'rgba(10, 14, 20, 0.48)';
  ctx.beginPath();
  ctx.rect(0, 0, innerWidth, innerHeight);
  if (sel && sel.width > 0 && sel.height > 0) ctx.rect(sel.x, sel.y, sel.width, sel.height);
  ctx.fill('evenodd');

  if (sel && sel.width > 0 && sel.height > 0) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = BRASS;
    ctx.strokeRect(sel.x + 0.75, sel.y + 0.75, sel.width - 1.5, sel.height - 1.5);
  } else if (cursor.x >= 0) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.floor(cursor.y) + 0.5); ctx.lineTo(innerWidth, Math.floor(cursor.y) + 0.5);
    ctx.moveTo(Math.floor(cursor.x) + 0.5, 0); ctx.lineTo(Math.floor(cursor.x) + 0.5, innerHeight);
    ctx.stroke();
  }

  drawLoupe();
}

function finish(rect) {
  if (finished) return;
  finished = true;
  api.invoke('overlay:done', rect);
}

function fullScreenRect() {
  return { x: 0, y: 0, width: innerWidth, height: innerHeight };
}

window.addEventListener('pointermove', (e) => {
  cursor = { x: e.clientX, y: e.clientY };
  if (start) sel = normRect(start, cursor);
  requestDraw();
});

window.addEventListener('pointerdown', (e) => {
  if (e.button === 2) { finish(null); return; }
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  start = { x: e.clientX, y: e.clientY };
  sel = normRect(start, start);
  hint.style.display = 'none';
  requestDraw();
});

window.addEventListener('pointerup', (e) => {
  if (!start || e.button !== 0) return;
  const rect = normRect(start, { x: e.clientX, y: e.clientY });
  start = null;
  if (rect.width < 4 || rect.height < 4) finish(fullScreenRect());
  else finish(rect);
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') finish(null);
  else if (e.key === 'Enter') finish(fullScreenRect());
});

window.addEventListener('blur', () => { /* stay open; the user may alt-tab back */ });
window.addEventListener('resize', resize);

async function init() {
  const config = await api.invoke('overlay:config');
  if (!config) { finish(null); return; }
  mode = config.mode;
  hint.innerHTML = mode === 'record'
    ? 'Drag over the area to record. <kbd>Enter</kbd> records the whole screen, <kbd>Esc</kbd> cancels.'
    : 'Drag to capture an area. Click or press <kbd>Enter</kbd> for the whole screen, <kbd>Esc</kbd> cancels.';

  const blob = new Blob([config.jpeg], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  img = new Image();
  img.onload = () => {
    scale = img.naturalWidth / innerWidth;
    sample = document.createElement('canvas');
    sample.width = img.naturalWidth;
    sample.height = img.naturalHeight;
    sampleCtx = sample.getContext('2d', { willReadFrequently: true });
    sampleCtx.drawImage(img, 0, 0);
    resize();
  };
  img.src = url;
}

init();
