'use strict';

// A pinned capture: drag to move, scroll or pinch to zoom, double-click or Esc to close,
// right-click for more.
const api = window.loupe;
let drag = null;

document.getElementById('close').addEventListener('click', () => api.invoke('pin:close'));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.invoke('pin:close'); });
window.addEventListener('dblclick', () => api.invoke('pin:close'));
window.addEventListener('contextmenu', (e) => { e.preventDefault(); api.invoke('pin:menu'); });

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.id === 'close') return;
  drag = { x: e.screenX, y: e.screenY };
  document.body.classList.add('dragging');
  document.body.setPointerCapture(e.pointerId);
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (!dx && !dy) return;
  drag = { x: e.screenX, y: e.screenY };
  api.invoke('pin:move', dx, dy);
});
window.addEventListener('pointerup', () => { drag = null; document.body.classList.remove('dragging'); });

let wheelTimer = 0;
let pending = 1;
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  pending *= e.deltaY < 0 ? 1.06 : 1 / 1.06;
  if (wheelTimer) return;
  wheelTimer = setTimeout(() => { api.invoke('pin:zoom', pending); pending = 1; wheelTimer = 0; }, 30);
}, { passive: false });

async function init() {
  const cfg = await api.invoke('pin:config');
  if (!cfg) return;
  const img = document.getElementById('img');
  img.src = URL.createObjectURL(new Blob([cfg.bytes], { type: 'image/png' }));
}

init();
