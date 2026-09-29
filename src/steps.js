'use strict';

// The step-capture control bar. It keeps a live view of each screen so that, when you click,
// the screenshot shows the screen at the moment of the click rather than a moment later.
const api = window.loupe;
const $ = (s) => document.querySelector(s);
const live = new Map(); // displayId -> video element
const history = new Map(); // displayId -> recent frames [{ at, bitmap }]
const KEEP_MS = 600;
let paused = false;

// Keep the last few frames of each screen, so a step can show the screen from just *before*
// the click, not after the app has already reacted to it.
async function remember() {
  const now = Date.now();
  for (const [id, video] of live) {
    if (!video.videoWidth) continue;
    try {
      const bitmap = await createImageBitmap(video);
      const list = history.get(id) || [];
      list.push({ at: now, bitmap });
      while (list.length > 1 && now - list[0].at > KEEP_MS) list.shift().bitmap.close();
      history.set(id, list);
    } catch { /* frame not ready */ }
  }
}
setInterval(remember, 60);

async function openLiveViews() {
  const displays = await api.invoke('steps:config');
  for (const d of displays) {
    if (!d.sourceId) continue;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: d.sourceId,
            maxWidth: d.pixelSize.width,
            maxHeight: d.pixelSize.height,
            maxFrameRate: 15,
          },
        },
      });
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      $('#videos').appendChild(video);
      await video.play();
      live.set(d.displayId, video);
    } catch (err) {
      console.warn('Live view unavailable for display', d.displayId, err);
    }
  }
}

async function grab({ id, displayId, at }) {
  const video = live.get(displayId);
  if (!video || !video.videoWidth) return; // the main process falls back to a screenshot
  // The newest frame taken at least 40 ms before the click, so it shows the screen as it was.
  const list = history.get(displayId) || [];
  const before = list.filter((f) => f.at <= (at || Date.now()) - 40).pop();
  const source = before ? before.bitmap : video;
  const canvas = document.createElement('canvas');
  canvas.width = source.width || video.videoWidth;
  canvas.height = source.height || video.videoHeight;
  canvas.getContext('2d').drawImage(source, 0, 0);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const png = await blob.arrayBuffer();
  api.invoke('steps:frame', { id, png, width: canvas.width });
}

api.on('steps:grab', grab);
api.on('steps:count', (n) => {
  const badge = $('#count');
  badge.textContent = n;
  badge.classList.remove('flash');
  void badge.offsetWidth;
  badge.classList.add('flash');
  $('#state').textContent = n === 1 ? '1 step. Keep clicking, then press Done.' : `${n} steps. Keep clicking, then press Done.`;
});

$('#pause').addEventListener('click', () => {
  paused = !paused;
  api.invoke('steps:pause', paused);
  $('#pause').textContent = paused ? 'Resume' : 'Pause';
  $('#state').textContent = paused ? 'Paused. Clicks aren\'t captured.' : 'Capturing clicks again.';
});
$('#done').addEventListener('click', () => api.invoke('steps:done'));
$('#cancel').addEventListener('click', () => api.invoke('steps:cancel'));

openLiveViews();
