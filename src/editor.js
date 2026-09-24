'use strict';

const api = window.loupe;
const $ = (s) => document.querySelector(s);

const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const stage = $('#stage');
const wrap = $('#wrap');
const textEditor = $('#textEditor');
const measureCtx = document.createElement('canvas').getContext('2d');
const scratch = document.createElement('canvas');

const DPR = window.devicePixelRatio || 1;
const U = Math.max(1, DPR); // annotation sizes follow the capture's pixel density
const BRASS = '#C99230';
const FONT = getComputedStyle(document.body).fontFamily;

const COLORS = [
  ['#E5484D', 'Red'], ['#F5A524', 'Orange'], ['#FFE14D', 'Yellow'], ['#30A46C', 'Green'],
  ['#0090FF', 'Blue'], ['#8E4EC6', 'Purple'], ['#1C2430', 'Black'], ['#FFFFFF', 'White'],
];

const ICONS = {
  select: '<path d="M6 3.5l11 7-5 1.3-2.4 4.7z"/><path d="M12 11.8l3.5 5"/>',
  arrow: '<path d="M4.5 17.5L16 6"/><path d="M9 5.5h7.5V13"/>',
  line: '<path d="M4.5 17.5l13-13"/>',
  rect: '<rect x="3.5" y="5.5" width="15" height="11" rx="1.5"/>',
  ellipse: '<ellipse cx="11" cy="11" rx="7.5" ry="5.8"/>',
  text: '<path d="M5 5.5h12M11 5.5V17M8.5 17h5"/>',
  step: '<circle cx="11" cy="11" r="7.5"/><path d="M9.6 8.6L11.4 7.4V14.8"/>',
  highlight: '<path d="M13.6 3.8l4.6 4.6-7.6 7.6H6v-4.6z"/><path d="M3.5 19h15"/>',
  blur: '<rect class="solid" x="4" y="4" width="4.6" height="4.6"/><rect x="8.6" y="4" width="4.6" height="4.6"/><rect class="solid" x="13.2" y="4" width="4.6" height="4.6"/><rect x="4" y="8.6" width="4.6" height="4.6"/><rect class="solid" x="8.6" y="8.6" width="4.6" height="4.6"/><rect x="13.2" y="8.6" width="4.6" height="4.6"/><rect class="solid" x="4" y="13.2" width="4.6" height="4.6"/><rect x="8.6" y="13.2" width="4.6" height="4.6"/><rect class="solid" x="13.2" y="13.2" width="4.6" height="4.6"/>',
  crop: '<path d="M6.5 2.5v13h13"/><path d="M2.5 6.5h13v13"/>',
};

const TOOLS = [
  { id: 'select', key: 'v', label: 'Select and move', props: ['selecttip'] },
  null,
  { id: 'arrow', key: 'a', label: 'Arrow', props: ['color', 'width'] },
  { id: 'line', key: 'l', label: 'Line', props: ['color', 'width'] },
  { id: 'rect', key: 'r', label: 'Rectangle', props: ['color', 'width', 'fill'] },
  { id: 'ellipse', key: 'e', label: 'Ellipse', props: ['color', 'width', 'fill'] },
  { id: 'text', key: 't', label: 'Text', props: ['color', 'size', 'fill'] },
  { id: 'step', key: 's', label: 'Numbered step', props: ['color', 'size', 'next'] },
  { id: 'highlight', key: 'h', label: 'Highlighter', props: ['color'] },
  { id: 'blur', key: 'b', label: 'Blur sensitive info', props: ['strength'] },
  null,
  { id: 'crop', key: 'c', label: 'Crop', props: ['croptip'] },
];
const TOOL_BY_ID = Object.fromEntries(TOOLS.filter(Boolean).map((t) => [t.id, t]));

// Per-tool defaults, in "UI units" (multiplied by U when drawn)
const style = {
  arrow: { color: '#E5484D', width: 5 },
  line: { color: '#E5484D', width: 4 },
  rect: { color: '#E5484D', width: 4, fill: false },
  ellipse: { color: '#E5484D', width: 4, fill: false },
  text: { color: '#E5484D', size: 28, fill: false },
  step: { color: '#E5484D', size: 30 },
  highlight: { color: '#FFE14D' },
  blur: { strength: 16 },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let base = null;          // canvas with the captured pixels (replaced on crop)
let W = 0;
let H = 0;
let objects = [];
let tool = 'arrow';
let selected = null;
let draft = null;
let drag = null;
let cropRect = null;
let editing = null;       // text being edited
let history = [];
let future = [];
let liveSnap = null;      // snapshot taken when a slider drag starts
let dirty = false;
let zoomMode = 'fit';
let zoom = 1;             // CSS px per image px
let spaceDown = false;
let stepOverride = null;
let fileName = 'Capture';

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const clone = (o) => structuredClone(o);
const ipx = () => 1 / zoom; // image px per CSS px

function norm(o) {
  const x = Math.min(o.x, o.x + o.w);
  const y = Math.min(o.y, o.y + o.h);
  return { x, y, w: Math.abs(o.w), h: Math.abs(o.h) };
}

function inside(p, b, tol = 0) {
  return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
}

function distToSegment(p, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - x1) * dx + (p.y - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrastFor = (hex) => (luminance(hex) > 0.45 ? '#1C2430' : '#FFFFFF');

function fontFor(size) { return `600 ${size}px ${FONT}`; }

function textLayout(o) {
  measureCtx.font = fontFor(o.size);
  const lines = (o.text || '').split('\n');
  const lh = o.size * 1.25;
  const w = Math.max(o.size * 0.4, ...lines.map((l) => measureCtx.measureText(l).width));
  const h = lines.length * lh;
  const pad = o.fill ? o.size * 0.35 : 0;
  return { lines, lh, w, h, pad };
}

function bounds(o) {
  switch (o.type) {
    case 'arrow':
    case 'line': {
      const pad = o.width;
      return {
        x: Math.min(o.x1, o.x2) - pad, y: Math.min(o.y1, o.y2) - pad,
        w: Math.abs(o.x2 - o.x1) + pad * 2, h: Math.abs(o.y2 - o.y1) + pad * 2,
      };
    }
    case 'text': {
      const t = textLayout(o);
      return { x: o.x - t.pad, y: o.y - t.pad, w: t.w + t.pad * 2, h: t.h + t.pad * 2 };
    }
    case 'step': {
      const r = o.size * 0.72;
      return { x: o.x - r, y: o.y - r, w: r * 2, h: r * 2 };
    }
    default:
      return norm(o);
  }
}

function translate(o, dx, dy) {
  if (o.type === 'arrow' || o.type === 'line') {
    o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
  } else {
    o.x += dx; o.y += dy;
  }
}

function isBox(o) { return ['rect', 'ellipse', 'highlight', 'blur'].includes(o.type); }

function handlesFor(o) {
  if (o.type === 'arrow' || o.type === 'line') {
    return [{ id: 'p1', x: o.x1, y: o.y1 }, { id: 'p2', x: o.x2, y: o.y2 }];
  }
  if (isBox(o)) {
    const b = norm(o);
    return [
      { id: 'nw', x: b.x, y: b.y }, { id: 'ne', x: b.x + b.w, y: b.y },
      { id: 'sw', x: b.x, y: b.y + b.h }, { id: 'se', x: b.x + b.w, y: b.y + b.h },
    ];
  }
  return [];
}

function hitObject(o, p) {
  const tol = 6 * ipx();
  switch (o.type) {
    case 'arrow':
    case 'line':
      return distToSegment(p, o.x1, o.y1, o.x2, o.y2) <= o.width / 2 + tol;
    case 'rect': {
      const b = norm(o);
      if (o.fill) return inside(p, b, tol);
      const edge = o.width / 2 + tol;
      return inside(p, b, edge) && !(b.w > edge * 2 && b.h > edge * 2 && inside(p, { x: b.x + edge, y: b.y + edge, w: b.w - edge * 2, h: b.h - edge * 2 }));
    }
    case 'ellipse': {
      const b = norm(o);
      const rx = b.w / 2;
      const ry = b.h / 2;
      if (rx < 1 || ry < 1) return inside(p, b, tol);
      const d = Math.hypot((p.x - (b.x + rx)) / rx, (p.y - (b.y + ry)) / ry);
      if (o.fill) return d <= 1 + tol / Math.min(rx, ry);
      return Math.abs(d - 1) * Math.min(rx, ry) <= o.width / 2 + tol;
    }
    default:
      return inside(p, bounds(o), tol);
  }
}

function topObjectAt(p) {
  for (let i = objects.length - 1; i >= 0; i--) if (hitObject(objects[i], p)) return objects[i];
  return null;
}

function handleAt(p) {
  if (!selected) return null;
  const r = 7 * ipx();
  return handlesFor(selected).find((h) => Math.abs(h.x - p.x) <= r && Math.abs(h.y - p.y) <= r) || null;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function withShadow(c) {
  c.shadowColor = 'rgba(0, 0, 0, 0.28)';
  c.shadowBlur = 4 * U;
  c.shadowOffsetY = 1 * U;
}

function drawArrow(c, o) {
  const { x1, y1, x2, y2, color, width: w } = o;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const head = Math.min(len * 0.65, Math.max(w * 3.6, 12 * U));
  const half = head * 0.52;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const bx = x2 - cos * head * 0.85;
  const by = y2 - sin * head * 0.85;
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = w;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(bx, by);
  c.stroke();
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(x2 - head * cos + half * sin, y2 - head * sin - half * cos);
  c.lineTo(x2 - head * cos - half * sin, y2 - head * sin + half * cos);
  c.closePath();
  c.lineJoin = 'round';
  c.lineWidth = Math.max(1, w * 0.4);
  c.fill();
  c.stroke();
}

function drawText(c, o) {
  const t = textLayout(o);
  c.font = fontFor(o.size);
  c.textBaseline = 'middle';
  if (o.fill) {
    c.fillStyle = o.color;
    c.beginPath();
    c.roundRect(o.x - t.pad, o.y - t.pad, t.w + t.pad * 2, t.h + t.pad * 2, o.size * 0.22);
    c.fill();
    c.shadowColor = 'transparent';
    c.fillStyle = contrastFor(o.color);
    t.lines.forEach((line, i) => c.fillText(line, o.x, o.y + t.lh * i + t.lh / 2));
    return;
  }
  c.lineJoin = 'round';
  c.lineWidth = Math.max(2, o.size * 0.16);
  c.strokeStyle = contrastFor(o.color) === '#FFFFFF' ? 'rgba(255,255,255,0.95)' : 'rgba(28,36,48,0.9)';
  t.lines.forEach((line, i) => c.strokeText(line, o.x, o.y + t.lh * i + t.lh / 2));
  c.shadowColor = 'transparent';
  c.fillStyle = o.color;
  t.lines.forEach((line, i) => c.fillText(line, o.x, o.y + t.lh * i + t.lh / 2));
}

function drawStep(c, o) {
  const r = o.size * 0.72;
  c.fillStyle = o.color;
  c.beginPath();
  c.arc(o.x, o.y, r, 0, Math.PI * 2);
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = Math.max(1.5, o.size * 0.07);
  c.strokeStyle = contrastFor(o.color) === '#FFFFFF' ? '#FFFFFF' : '#1C2430';
  c.globalAlpha = 0.9;
  c.stroke();
  c.globalAlpha = 1;
  c.fillStyle = contrastFor(o.color);
  const label = String(o.n);
  c.font = `700 ${o.size * (label.length > 2 ? 0.62 : 0.8)}px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(label, o.x, o.y + o.size * 0.03);
}

function drawBlur(c, o) {
  const b = norm(o);
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const w = Math.min(c.canvas.width, Math.ceil(b.x + b.w)) - x;
  const h = Math.min(c.canvas.height, Math.ceil(b.y + b.h)) - y;
  if (w < 1 || h < 1) return;
  const block = Math.max(2, o.strength);
  const sw = Math.max(1, Math.round(w / block));
  const sh = Math.max(1, Math.round(h / block));
  scratch.width = sw;
  scratch.height = sh;
  const s = scratch.getContext('2d');
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = 'medium';
  s.drawImage(c.canvas, x, y, w, h, 0, 0, sw, sh);
  c.imageSmoothingEnabled = false;
  c.drawImage(scratch, 0, 0, sw, sh, x, y, w, h);
}

function drawObject(c, o) {
  c.save();
  switch (o.type) {
    case 'arrow':
      withShadow(c);
      drawArrow(c, o);
      break;
    case 'line':
      withShadow(c);
      c.strokeStyle = o.color;
      c.lineWidth = o.width;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(o.x1, o.y1);
      c.lineTo(o.x2, o.y2);
      c.stroke();
      break;
    case 'rect': {
      const b = norm(o);
      withShadow(c);
      c.beginPath();
      c.roundRect(b.x, b.y, b.w, b.h, Math.min(3 * U, b.w / 2, b.h / 2));
      if (o.fill) { c.fillStyle = o.color; c.fill(); }
      else { c.strokeStyle = o.color; c.lineWidth = o.width; c.lineJoin = 'round'; c.stroke(); }
      break;
    }
    case 'ellipse': {
      const b = norm(o);
      withShadow(c);
      c.beginPath();
      c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      if (o.fill) { c.fillStyle = o.color; c.fill(); }
      else { c.strokeStyle = o.color; c.lineWidth = o.width; c.stroke(); }
      break;
    }
    case 'text':
      withShadow(c);
      drawText(c, o);
      break;
    case 'step':
      withShadow(c);
      drawStep(c, o);
      break;
    case 'highlight': {
      const b = norm(o);
      c.globalCompositeOperation = 'multiply';
      c.globalAlpha = 0.75;
      c.fillStyle = o.color;
      c.fillRect(b.x, b.y, b.w, b.h);
      break;
    }
    case 'blur':
      drawBlur(c, o);
      break;
    default:
      break;
  }
  c.restore();
}

function renderScene(c, forExport) {
  c.clearRect(0, 0, W, H);
  c.drawImage(base, 0, 0);
  for (const o of objects) {
    if (!forExport && editing && editing.obj === o) continue;
    drawObject(c, o);
  }
  if (!forExport && draft) drawObject(c, draft);
}

function drawSelection() {
  if (!selected || editing) return;
  const px = ipx();
  const b = bounds(selected);
  ctx.save();
  ctx.lineWidth = 1.5 * px;
  ctx.setLineDash([5 * px, 4 * px]);
  ctx.strokeStyle = BRASS;
  if (selected.type === 'arrow' || selected.type === 'line') {
    ctx.beginPath();
    ctx.moveTo(selected.x1, selected.y1);
    ctx.lineTo(selected.x2, selected.y2);
    ctx.stroke();
  } else {
    const pad = 4 * px;
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  }
  ctx.setLineDash([]);
  const s = 9 * px;
  for (const h of handlesFor(selected)) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = BRASS;
    ctx.lineWidth = 1.5 * px;
    ctx.fillRect(h.x - s / 2, h.y - s / 2, s, s);
    ctx.strokeRect(h.x - s / 2, h.y - s / 2, s, s);
  }
  ctx.restore();
}

function drawCrop() {
  if (!cropRect) return;
  const b = norm(cropRect);
  const px = ipx();
  ctx.save();
  ctx.fillStyle = 'rgba(10, 14, 20, 0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = px;
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(b.x + (b.w * i) / 3, b.y); ctx.lineTo(b.x + (b.w * i) / 3, b.y + b.h);
    ctx.moveTo(b.x, b.y + (b.h * i) / 3); ctx.lineTo(b.x + b.w, b.y + (b.h * i) / 3);
  }
  ctx.stroke();
  ctx.strokeStyle = BRASS;
  ctx.lineWidth = 2 * px;
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.restore();
}

let frameRequested = false;
function render() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    if (!base) return;
    renderScene(ctx, false);
    drawSelection();
    drawCrop();
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function snapshot() { return { base, objects: clone(objects) }; }

function markDirty() {
  if (!dirty) { dirty = true; api.invoke('editor:dirty', true); }
}

function pushSnap(snap) {
  history.push(snap);
  if (history.length > 150) history.shift();
  future = [];
  markDirty();
  updateUndo();
}

function restoreSnap(snap) {
  const sizeChanged = snap.base !== base;
  base = snap.base;
  objects = snap.objects;
  selected = null;
  if (sizeChanged) resizeToBase();
  updateProps();
  render();
}

function undo() {
  commitText();
  if (!history.length) return;
  future.push(snapshot());
  restoreSnap(history.pop());
  markDirty();
  updateUndo();
}

function redo() {
  commitText();
  if (!future.length) return;
  history.push(snapshot());
  restoreSnap(future.pop());
  markDirty();
  updateUndo();
}

function updateUndo() {
  $('#undo').disabled = !history.length;
  $('#redo').disabled = !future.length;
}

// ---------------------------------------------------------------------------
// Tools and properties UI
// ---------------------------------------------------------------------------

function buildRail() {
  const rail = $('#rail');
  for (const t of TOOLS) {
    if (!t) { const s = document.createElement('div'); s.className = 'sep'; rail.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.tool = t.id;
    b.title = `${t.label} (${t.key.toUpperCase()})`;
    b.setAttribute('aria-label', t.label);
    b.innerHTML = `<svg viewBox="0 0 22 22">${ICONS[t.id]}</svg><span class="key">${t.key.toUpperCase()}</span>`;
    b.addEventListener('click', () => setTool(t.id));
    rail.appendChild(b);
  }
}

function buildSwatches() {
  const box = $('#swatches');
  for (const [hex, name] of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.dataset.color = hex;
    b.title = name;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', name);
    b.addEventListener('click', () => setProp('color', hex, true));
    box.appendChild(b);
  }
}

function setTool(id) {
  commitText();
  if (id !== 'crop') cancelCrop();
  tool = id;
  document.body.dataset.tool = id;
  document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
  if (id !== 'select' && selected && selected.type !== id) selected = null;
  updateCursor();
  updateProps();
  render();
}

function nextStepNumber() {
  if (stepOverride != null) return stepOverride;
  const nums = objects.filter((o) => o.type === 'step').map((o) => o.n);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// The object whose style the property bar edits: the selection, otherwise the tool defaults.
function propSource() {
  if (selected) {
    const o = selected;
    return {
      type: o.type,
      color: o.color,
      width: o.width != null ? Math.round(o.width / U) : undefined,
      size: o.size != null ? Math.round(o.size / U) : undefined,
      fill: o.fill,
      strength: o.strength != null ? Math.round(o.strength / U) : undefined,
      next: o.type === 'step' ? o.n : undefined,
    };
  }
  return { type: tool, ...(style[tool] || {}), next: tool === 'step' ? nextStepNumber() : undefined };
}

function updateProps() {
  const src = propSource();
  const def = TOOL_BY_ID[src.type];
  document.body.dataset.props = def ? def.props.join(' ') : '';
  if (src.color) {
    document.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.color.toLowerCase() === src.color.toLowerCase())));
  }
  if (src.width != null) { $('#width').value = src.width; $('#widthOut').textContent = src.width; }
  if (src.size != null) { $('#size').value = src.size; $('#sizeOut').textContent = src.size; }
  if (src.fill != null) $('#fill').checked = !!src.fill;
  if (src.strength != null) { $('#strength').value = src.strength; $('#strengthOut').textContent = src.strength; }
  if (src.next != null) $('#next').value = src.next;
}

function setProp(name, value, final) {
  const type = selected ? selected.type : tool;
  if (style[type] && name in style[type]) style[type][name] = value;
  if (name === 'next' && !selected) stepOverride = value;

  if (selected) {
    if (!liveSnap) liveSnap = snapshot();
    const o = selected;
    if (name === 'color' && 'color' in o) o.color = value;
    if (name === 'width' && 'width' in o) o.width = value * U;
    if (name === 'size' && 'size' in o) o.size = value * U;
    if (name === 'fill' && 'fill' in o) o.fill = value;
    if (name === 'strength' && 'strength' in o) o.strength = value * U;
    if (name === 'next' && o.type === 'step') o.n = value;
    if (final) { pushSnap(liveSnap); liveSnap = null; }
  }
  updateProps();
  render();
}

function wireProps() {
  const range = (id, name) => {
    const el = $(id);
    el.addEventListener('input', () => setProp(name, Number(el.value), false));
    el.addEventListener('change', () => {
      if (liveSnap) { pushSnap(liveSnap); liveSnap = null; }
    });
  };
  range('#width', 'width');
  range('#size', 'size');
  range('#strength', 'strength');
  $('#fill').addEventListener('change', (e) => setProp('fill', e.target.checked, true));
  $('#next').addEventListener('change', (e) => {
    const n = Math.max(1, Math.round(Number(e.target.value) || 1));
    setProp('next', n, true);
  });
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

function fitZoom() {
  const aw = Math.max(50, stage.clientWidth - 64);
  const ah = Math.max(50, stage.clientHeight - 64);
  return Math.min(aw / W, ah / H, 1 / DPR);
}

function applyZoom() {
  if (!W) return;
  zoom = zoomMode === 'fit' ? fitZoom() : zoomMode / DPR;
  canvas.style.width = `${W * zoom}px`;
  canvas.style.height = `${H * zoom}px`;
  const pct = Math.round(zoom * DPR * 100);
  $('#zoomLabel').textContent = `${pct}%`;
  const sel = $('#zoom');
  const match = [...sel.options].find((o) => o.value === String(zoomMode));
  if (match) sel.value = match.value;
  else {
    let custom = sel.querySelector('option[data-custom]');
    if (!custom) { custom = document.createElement('option'); custom.dataset.custom = '1'; sel.appendChild(custom); }
    custom.value = String(zoomMode);
    custom.textContent = `${pct}%`;
    sel.value = custom.value;
  }
  positionTextEditor();
  render();
}

function setZoom(mode) {
  commitText();
  zoomMode = mode === 'fit' ? 'fit' : Math.min(8, Math.max(0.1, Number(mode)));
  applyZoom();
}

function currentActualZoom() { return zoom * DPR; }

function resizeToBase() {
  W = base.width;
  H = base.height;
  canvas.width = W;
  canvas.height = H;
  $('#dims').textContent = `${W} × ${H} px`;
  applyZoom();
}

// ---------------------------------------------------------------------------
// Text editing
// ---------------------------------------------------------------------------

function positionTextEditor() {
  if (!editing) return;
  const o = editing.obj;
  const t = textLayout(o);
  textEditor.style.left = `${(o.x - t.pad) * zoom}px`;
  textEditor.style.top = `${(o.y - t.pad) * zoom}px`;
  textEditor.style.fontSize = `${o.size * zoom}px`;
  textEditor.style.padding = `${t.pad * zoom}px`;
  textEditor.style.color = o.fill ? contrastFor(o.color) : o.color;
  textEditor.style.background = o.fill ? o.color : 'transparent';
  textEditor.style.borderRadius = o.fill ? `${o.size * 0.22 * zoom}px` : '0';
}

function openText(obj, isNew) {
  editing = { obj, isNew, snap: snapshot() };
  selected = obj;
  textEditor.value = obj.text || '';
  textEditor.hidden = false;
  positionTextEditor();
  render();
  requestAnimationFrame(() => {
    textEditor.focus();
    if (!isNew) textEditor.select();
  });
}

function commitText() {
  if (!editing) return;
  const { obj, isNew, snap } = editing;
  editing = null;
  textEditor.hidden = true;
  const text = textEditor.value.replace(/\s+$/, '');
  if (!text) {
    if (!isNew) { objects = objects.filter((o) => o !== obj); pushSnap(snap); }
    selected = null;
  } else {
    const changed = isNew || text !== obj.text;
    obj.text = text;
    if (isNew) objects.push(obj);
    if (changed) pushSnap(snap);
    selected = obj;
  }
  updateProps();
  render();
}

textEditor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    commitText();
  }
});
textEditor.addEventListener('blur', () => commitText());
textEditor.addEventListener('pointerdown', (e) => e.stopPropagation());

// ---------------------------------------------------------------------------
// Crop
// ---------------------------------------------------------------------------

function showCropBar() {
  const bar = $('#cropbar');
  if (!cropRect) { bar.hidden = true; return; }
  const b = clampToImage(norm(cropRect));
  $('#cropSize').textContent = `${Math.round(b.w)} × ${Math.round(b.h)}`;
  bar.hidden = b.w < 2 || b.h < 2;
}

function clampToImage(b) {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return { x, y, w: Math.min(W, Math.round(b.x + b.w)) - x, h: Math.min(H, Math.round(b.y + b.h)) - y };
}

function cancelCrop() {
  cropRect = null;
  showCropBar();
  render();
}

function applyCrop() {
  if (!cropRect) return;
  const b = clampToImage(norm(cropRect));
  cropRect = null;
  showCropBar();
  if (b.w < 2 || b.h < 2) { render(); return; }
  pushSnap(snapshot());
  const next = document.createElement('canvas');
  next.width = b.w;
  next.height = b.h;
  next.getContext('2d').drawImage(base, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  base = next;
  objects.forEach((o) => translate(o, -b.x, -b.y));
  selected = null;
  zoomMode = 'fit';
  resizeToBase();
  setStatus(`Cropped to ${b.w} × ${b.h}.`);
  setTool('arrow');
}

$('#cropApply').addEventListener('click', applyCrop);
$('#cropCancel').addEventListener('click', cancelCrop);

// ---------------------------------------------------------------------------
// Pointer handling
// ---------------------------------------------------------------------------

function toImage(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
}

function newObject(type, p) {
  const s = style[type];
  switch (type) {
    case 'arrow':
    case 'line':
      return { type, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: s.color, width: s.width * U };
    case 'rect':
    case 'ellipse':
      return { type, x: p.x, y: p.y, w: 0, h: 0, color: s.color, width: s.width * U, fill: s.fill };
    case 'highlight':
      return { type, x: p.x, y: p.y, w: 0, h: 0, color: s.color };
    case 'blur':
      return { type, x: p.x, y: p.y, w: 0, h: 0, strength: s.strength * U };
    default:
      return null;
  }
}

function constrainLine(x1, y1, p) {
  const ang = Math.round(Math.atan2(p.y - y1, p.x - x1) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(p.x - x1, p.y - y1);
  return { x: x1 + Math.cos(ang) * len, y: y1 + Math.sin(ang) * len };
}

function constrainBox(ax, ay, p) {
  const size = Math.max(Math.abs(p.x - ax), Math.abs(p.y - ay));
  return { x: ax + Math.sign(p.x - ax || 1) * size, y: ay + Math.sign(p.y - ay || 1) * size };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!base) return;
  if (editing) { commitText(); return; }
  const p = toImage(e);

  if (e.button === 1 || spaceDown) {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    canvas.setPointerCapture(e.pointerId);
    updateCursor();
    return;
  }
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);

  const handle = tool !== 'crop' ? handleAt(p) : null;
  if (handle) {
    const orig = clone(selected);
    const b = isBox(selected) ? norm(selected) : null;
    let anchor = null;
    if (b) {
      anchor = {
        nw: { x: b.x + b.w, y: b.y + b.h }, ne: { x: b.x, y: b.y + b.h },
        sw: { x: b.x + b.w, y: b.y }, se: { x: b.x, y: b.y },
      }[handle.id];
    }
    drag = { mode: 'handle', handle: handle.id, anchor, orig, snap: snapshot(), moved: false };
    return;
  }

  if (tool === 'select') {
    const hit = topObjectAt(p);
    selected = hit;
    updateProps();
    if (hit) drag = { mode: 'move', start: p, orig: clone(hit), snap: snapshot(), moved: false };
    render();
    return;
  }

  if (tool === 'crop') {
    cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
    drag = { mode: 'crop', start: p };
    showCropBar();
    render();
    return;
  }

  if (tool === 'text') {
    const hit = topObjectAt(p);
    if (hit && hit.type === 'text') { openText(hit, false); return; }
    const s = style.text;
    openText({ type: 'text', x: p.x, y: p.y - (s.size * U * 1.25) / 2, text: '', color: s.color, size: s.size * U, fill: s.fill }, true);
    return;
  }

  if (tool === 'step') {
    const snap = snapshot();
    const s = style.step;
    const o = { type: 'step', x: p.x, y: p.y, n: nextStepNumber(), color: s.color, size: s.size * U };
    stepOverride = null;
    objects.push(o);
    pushSnap(snap);
    selected = o;
    drag = { mode: 'move', start: p, orig: clone(o), snap: null, moved: false };
    updateProps();
    render();
    return;
  }

  selected = null;
  draft = newObject(tool, p);
  drag = { mode: 'draw', start: p };
  render();
});

canvas.addEventListener('pointermove', (e) => {
  if (!base) return;
  const p = toImage(e);
  if (!drag) { updateCursor(p); return; }

  switch (drag.mode) {
    case 'pan':
      stage.scrollLeft = drag.left - (e.clientX - drag.sx);
      stage.scrollTop = drag.top - (e.clientY - drag.sy);
      return;
    case 'move': {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      const o = selected;
      Object.assign(o, clone(drag.orig));
      translate(o, dx, dy);
      drag.moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 0.5;
      break;
    }
    case 'handle': {
      const o = selected;
      drag.moved = true;
      if (o.type === 'arrow' || o.type === 'line') {
        if (drag.handle === 'p1') {
          const q = e.shiftKey ? constrainLine(o.x2, o.y2, p) : p;
          o.x1 = q.x; o.y1 = q.y;
        } else {
          const q = e.shiftKey ? constrainLine(o.x1, o.y1, p) : p;
          o.x2 = q.x; o.y2 = q.y;
        }
      } else if (drag.anchor) {
        const q = e.shiftKey ? constrainBox(drag.anchor.x, drag.anchor.y, p) : p;
        o.x = Math.min(drag.anchor.x, q.x);
        o.y = Math.min(drag.anchor.y, q.y);
        o.w = Math.abs(q.x - drag.anchor.x);
        o.h = Math.abs(q.y - drag.anchor.y);
      }
      break;
    }
    case 'crop': {
      const q = e.shiftKey ? constrainBox(drag.start.x, drag.start.y, p) : p;
      cropRect.w = q.x - cropRect.x;
      cropRect.h = q.y - cropRect.y;
      showCropBar();
      break;
    }
    case 'draw': {
      if (!draft) break;
      if (draft.type === 'arrow' || draft.type === 'line') {
        const q = e.shiftKey ? constrainLine(draft.x1, draft.y1, p) : p;
        draft.x2 = q.x; draft.y2 = q.y;
      } else {
        const q = e.shiftKey ? constrainBox(drag.start.x, drag.start.y, p) : p;
        draft.w = q.x - draft.x;
        draft.h = q.y - draft.y;
      }
      break;
    }
    default:
      break;
  }
  render();
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if ((d.mode === 'move' || d.mode === 'handle') && d.moved && d.snap) pushSnap(d.snap);
  if (d.mode === 'draw' && draft) {
    const o = draft;
    draft = null;
    const min = 3 * U;
    const big = (o.type === 'arrow' || o.type === 'line')
      ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) >= min
      : Math.abs(o.w) >= min && Math.abs(o.h) >= min;
    if (big) {
      if (isBox(o)) Object.assign(o, norm(o));
      const snap = snapshot();
      objects.push(o);
      pushSnap(snap);
      selected = o;
      updateProps();
    }
  }
  if (d.mode === 'crop') {
    const b = norm(cropRect);
    if (b.w < 2 || b.h < 2) cropRect = null;
    showCropBar();
  }
  updateCursor();
  render();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('dblclick', (e) => {
  const hit = topObjectAt(toImage(e));
  if (hit && hit.type === 'text') openText(hit, false);
});

stage.addEventListener('pointerdown', (e) => {
  // Clicking the empty workspace around the image clears the selection.
  if (e.target === stage) { commitText(); selected = null; updateProps(); render(); }
});

stage.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  setZoom(currentActualZoom() * factor);
}, { passive: false });

function updateCursor(p) {
  if (drag && drag.mode === 'pan') { canvas.style.cursor = 'grabbing'; return; }
  if (spaceDown) { canvas.style.cursor = 'grab'; return; }
  if (p) {
    const h = tool !== 'crop' ? handleAt(p) : null;
    if (h) {
      canvas.style.cursor = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }[h.id] || 'grab';
      return;
    }
    if (tool === 'select') { canvas.style.cursor = topObjectAt(p) ? 'move' : 'default'; return; }
  }
  canvas.style.cursor = tool === 'text' ? 'text' : tool === 'select' ? 'default' : 'crosshair';
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function deleteSelected() {
  if (!selected) return;
  const snap = snapshot();
  objects = objects.filter((o) => o !== selected);
  selected = null;
  pushSnap(snap);
  updateProps();
  render();
}

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type === 'number');
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  if (mod) {
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); return; }
    if (k === 's') { e.preventDefault(); save(e.shiftKey); return; }
    if (k === 'c' && !typing && !window.getSelection().toString()) { e.preventDefault(); copy(); return; }
    if (k === '0') { e.preventDefault(); setZoom('fit'); return; }
    if (k === '1') { e.preventDefault(); setZoom(1); return; }
    if (k === '=' || k === '+') { e.preventDefault(); setZoom(currentActualZoom() * 1.25); return; }
    if (k === '-') { e.preventDefault(); setZoom(currentActualZoom() / 1.25); return; }
    return;
  }
  if (typing) return;

  if (e.key === ' ') { if (!spaceDown) { spaceDown = true; updateCursor(); } e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (cropRect) cancelCrop();
    else { selected = null; updateProps(); render(); }
    return;
  }
  if (e.key === 'Enter' && cropRect) { e.preventDefault(); applyCrop(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); deleteSelected(); return; }
  if (selected && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const snap = snapshot();
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    translate(selected, dx, dy);
    pushSnap(snap);
    render();
    return;
  }
  const t = TOOLS.find((x) => x && x.key === k);
  if (t && !e.altKey) { setTool(t.id); }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceDown = false; updateCursor(); }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

let statusTimer = 0;
function setStatus(text) {
  $('#status').textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('#status').textContent = ''; }, 5000);
}

async function exportBuffer() {
  commitText();
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  renderScene(c.getContext('2d'), true);
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  return blob.arrayBuffer();
}

async function save(as) {
  if (!base) return;
  if (cropRect) applyCrop();
  const buffer = await exportBuffer();
  const res = await api.invoke(as ? 'editor:saveAs' : 'editor:save', buffer);
  if (res && res.ok) {
    dirty = false;
    fileName = res.name;
    $('#fileName').textContent = res.name;
    setStatus(`Saved ${res.name}`);
  }
}

async function copy() {
  if (!base) return;
  const buffer = await exportBuffer();
  await api.invoke('editor:copy', buffer);
  setStatus('Copied to the clipboard.');
}

$('#save').addEventListener('click', () => save(false));
$('#saveAs').addEventListener('click', () => save(true));
$('#copy').addEventListener('click', copy);
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#zoom').addEventListener('change', (e) => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value)));

new ResizeObserver(() => { if (zoomMode === 'fit') applyZoom(); }).observe(stage);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init() {
  buildRail();
  buildSwatches();
  wireProps();
  setTool('arrow');
  updateUndo();

  const config = await api.invoke('editor:config');
  if (!config) { setStatus('This capture could not be opened.'); return; }
  fileName = config.name;
  $('#fileName').textContent = config.name;
  $('#fileName').title = config.file;

  const bitmap = await createImageBitmap(new Blob([config.bytes]));
  base = document.createElement('canvas');
  base.width = bitmap.width;
  base.height = bitmap.height;
  base.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  resizeToBase();
  setStatus(config.inLibrary
    ? 'The capture is on your clipboard. Annotate it, then save or copy.'
    : 'Opened. Save creates a copy so the original stays untouched.');
}

init();
