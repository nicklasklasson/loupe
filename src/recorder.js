'use strict';

const api = window.loupe;
const $ = (s) => document.querySelector(s);

let recorder = null;
let chunks = [];
let streams = [];
let drawTimer = 0;
let audioCtx = null;
let mime = 'video/webm';
let discarding = false;
let startedAt = 0;
let pausedTotal = 0;
let pausedAt = 0;
let clockTimer = 0;

function setState(text) { $('#state').textContent = text; }

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function tick() {
  if (!startedAt) return;
  const now = pausedAt || performance.now();
  $('#time').textContent = fmt(now - startedAt - pausedTotal);
}

function pickMime() {
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm'];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function desktopVideoConstraints(cfg) {
  return {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: cfg.sourceId,
      maxWidth: cfg.pixelSize.width,
      maxHeight: cfg.pixelSize.height,
      maxFrameRate: 30,
    },
  };
}

async function openDesktop(cfg) {
  const video = desktopVideoConstraints(cfg);
  if (cfg.systemAudio && cfg.platform === 'win32') {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video });
    } catch (err) {
      console.warn('System audio unavailable, recording without it', err);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: false, video });
}

async function openMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch (err) {
    console.warn('Microphone unavailable', err);
    return null;
  }
}

function mixAudio(sources) {
  const withAudio = sources.filter((s) => s && s.getAudioTracks().length);
  if (!withAudio.length) return [];
  if (withAudio.length === 1) return withAudio[0].getAudioTracks();
  audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  for (const s of withAudio) audioCtx.createMediaStreamSource(s).connect(dest);
  return dest.stream.getAudioTracks();
}

async function croppedTrack(desktop, cfg) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = desktop;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));

  const ratio = video.videoWidth / cfg.displaySize.width;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const sx = Math.round(cfg.rect.x * ratio);
  const sy = Math.round(cfg.rect.y * ratio);
  const sw = even(Math.min(cfg.rect.width * ratio, video.videoWidth - sx));
  const sh = even(Math.min(cfg.rect.height * ratio, video.videoHeight - sy));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d', { alpha: false });
  const draw = () => ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  draw();
  // A timer rather than requestAnimationFrame, so frames keep coming while this window is behind others.
  drawTimer = setInterval(draw, 1000 / 30);
  return canvas.captureStream(30).getVideoTracks()[0];
}

function countdown(n) {
  return new Promise((resolve) => {
    const step = () => {
      if (discarding) return resolve(false);
      if (n === 0) return resolve(true);
      setState(`Recording starts in ${n}…`);
      n -= 1;
      setTimeout(step, 1000);
    };
    step();
  });
}

function cleanup() {
  clearInterval(drawTimer);
  clearInterval(clockTimer);
  streams.forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  if (audioCtx) audioCtx.close();
}

async function start() {
  const cfg = await api.invoke('recorder:config');
  if (!cfg) { api.invoke('recorder:close'); return; }

  let desktop;
  try {
    desktop = await openDesktop(cfg);
  } catch (err) {
    api.invoke('recorder:error', `Loupe couldn't start recording: ${err.message || err.name}. On macOS, check Screen Recording permission in System Settings.`);
    return;
  }
  const mic = cfg.mic ? await openMic() : null;
  streams = [desktop, mic];

  const videoTrack = cfg.rect ? await croppedTrack(desktop, cfg) : desktop.getVideoTracks()[0];
  const audioTracks = mixAudio([desktop, mic]);
  const output = new MediaStream([videoTrack, ...audioTracks]);

  desktop.getVideoTracks()[0].addEventListener('ended', () => stop(true));

  const ok = await countdown(3);
  if (!ok) return;

  mime = pickMime();
  recorder = new MediaRecorder(output, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    cleanup();
    if (discarding || !chunks.length) { api.invoke('recorder:close'); return; }
    setState('Saving…');
    const blob = new Blob(chunks, { type: mime || 'video/webm' });
    const buffer = await blob.arrayBuffer();
    api.invoke('recorder:save', buffer, mime);
  };
  recorder.start(1000);

  startedAt = performance.now();
  clockTimer = setInterval(tick, 250);
  $('#dot').classList.add('live');
  const parts = [];
  if (mic) parts.push('mic');
  if (audioTracks.length && desktop.getAudioTracks().length) parts.push('computer sound');
  setState(parts.length ? `Recording with ${parts.join(' and ')}` : 'Recording');
  if (cfg.mic && !mic) setState('Recording without mic (not available)');
  $('#pause').disabled = false;
  $('#stop').disabled = false;
}

function stop(save = true) {
  if (!save) discarding = true;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else if (!recorder) { cleanup(); api.invoke('recorder:close'); }
}

$('#stop').addEventListener('click', () => stop(true));
$('#discard').addEventListener('click', () => stop(false));
$('#pause').addEventListener('click', () => {
  if (!recorder) return;
  if (recorder.state === 'recording') {
    recorder.pause();
    pausedAt = performance.now();
    $('#pause').textContent = 'Resume';
    $('#dot').classList.add('paused');
    setState('Paused');
  } else if (recorder.state === 'paused') {
    recorder.resume();
    pausedTotal += performance.now() - pausedAt;
    pausedAt = 0;
    $('#pause').textContent = 'Pause';
    $('#dot').classList.remove('paused');
    setState('Recording');
  }
});

start();
