'use strict';

const api = window.loupe;
const bubble = document.getElementById('bubble');
let sizeIndex = 1;
let drag = null;

document.getElementById('close').addEventListener('click', () => api.invoke('camera:close'));
document.getElementById('size').addEventListener('click', async () => { sizeIndex = (sizeIndex + 1) % 3; await api.invoke('camera:size', sizeIndex); });

bubble.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.tagName === 'BUTTON') return;
  drag = { x: e.screenX, y: e.screenY };
  bubble.classList.add('dragging');
  bubble.setPointerCapture(e.pointerId);
});
bubble.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (!dx && !dy) return;
  drag = { x: e.screenX, y: e.screenY };
  api.invoke('camera:move', dx, dy);
});
bubble.addEventListener('pointerup', () => { drag = null; bubble.classList.remove('dragging'); });

async function init() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: 'user' },
    });
    document.getElementById('video').srcObject = stream;
  } catch (err) {
    const msg = document.getElementById('msg');
    msg.hidden = false;
    msg.textContent = 'Camera unavailable. Check camera permission in System Settings.';
    console.warn('Camera unavailable:', err && (err.name + ': ' + err.message));
  }
}

init();
