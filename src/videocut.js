// Cuts time ranges out of a video, entirely on this computer.
//
// The video is decoded and re-encoded (so cuts land on the exact frame), using the hardware
// encoder through WebCodecs. The audio is copied as-is with shifted timestamps, which is fast,
// keeps the original quality and doesn't need an audio encoder.

import {
  Input, BlobSource, ALL_FORMATS,
  Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat,
  VideoSampleSink, VideoSampleSource, EncodedPacketSink, EncodedAudioPacketSource,
  QUALITY_HIGH, canEncodeVideo,
} from '../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs';

export async function probe(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const duration = await input.computeDuration();
    const mime = await input.getMimeType();
    const video = await input.getPrimaryVideoTrack();
    return {
      duration,
      mime,
      width: video ? video.displayWidth : 0,
      height: video ? video.displayHeight : 0,
    };
  } finally {
    input.dispose();
  }
}

/** Merge, clamp and sort the ranges to remove. Returns [[start, end], ...] in seconds. */
export function normaliseCuts(cuts, duration) {
  const sorted = cuts
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(duration, Math.max(a, b))])
    .filter(([a, b]) => b - a > 0.01)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 0.001) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** The parts of the video that stay, as [[start, end], ...]. */
export function keptRanges(cuts, duration) {
  const kept = [];
  let t = 0;
  for (const [a, b] of normaliseCuts(cuts, duration)) {
    if (a > t) kept.push([t, a]);
    t = Math.max(t, b);
  }
  if (duration > t) kept.push([t, duration]);
  return kept.filter(([a, b]) => b - a > 0.01);
}

async function pickVideoCodec(isMp4, width, height) {
  const options = isMp4 ? ['avc', 'hevc'] : ['vp9', 'vp8'];
  for (const codec of options) {
    try {
      if (await canEncodeVideo(codec, { width, height })) return codec;
    } catch { /* try the next */ }
  }
  throw new Error('This computer can\'t encode video in the format needed to save the edit.');
}

/**
 * Remove the given time ranges from a video.
 * @param {Blob} blob the original video
 * @param {Array<[number, number]>} cuts ranges to remove, in seconds
 * @param {(fraction: number) => void} onProgress
 * @returns {Promise<{ buffer: ArrayBuffer, ext: string, duration: number }>}
 */
export async function cutVideo(blob, cuts, onProgress = () => {}) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const duration = await input.computeDuration();
    const keep = keptRanges(cuts, duration);
    const total = keep.reduce((sum, [a, b]) => sum + (b - a), 0);
    if (total < 0.2) throw new Error('Nothing would be left of the video. Remove a smaller part.');

    const mime = await input.getMimeType();
    const isMp4 = !/webm|matroska/i.test(mime);
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack) throw new Error('This file has no video track.');
    if (!(await videoTrack.canDecode())) {
      const err = new Error('The fast method can\'t read this video on this computer.');
      err.code = 'NO_DECODE';
      throw err;
    }

    const output = new Output({
      format: isMp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });

    const width = videoTrack.displayWidth;
    const height = videoTrack.displayHeight;
    const videoCodec = await pickVideoCodec(isMp4, width, height);
    const videoSource = new VideoSampleSource({ codec: videoCodec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource);

    let audioSource = null;
    const audioCodec = audioTrack ? audioTrack.codec : null;
    if (audioTrack && audioCodec) {
      audioSource = new EncodedAudioPacketSource(audioCodec);
      output.addAudioTrack(audioSource);
    }

    await output.start();

    // Video: decode the kept frames, shift their timestamps, re-encode.
    const doVideo = (async () => {
      const sink = new VideoSampleSink(videoTrack);
      let offset = 0;
      let lastTs = -1;
      for (const [start, end] of keep) {
        for await (const sample of sink.samples(start, end)) {
          const ts = Math.max(offset, sample.timestamp - start + offset);
          if (ts <= lastTs) { sample.close(); continue; } // never go backwards
          lastTs = ts;
          sample.setTimestamp(ts);
          await videoSource.add(sample);
          sample.close();
          onProgress(Math.min(0.99, (sample.timestamp - start + offset) / total));
        }
        offset += end - start;
      }
      videoSource.close();
    })();

    // Audio: copy the packets that fall inside the kept parts, with shifted timestamps.
    const doAudio = (async () => {
      if (!audioSource) return;
      const sink = new EncodedPacketSink(audioTrack);
      const decoderConfig = await audioTrack.getDecoderConfig();
      let first = true;
      let offset = 0;
      let lastTs = -1;
      for (const [start, end] of keep) {
        let packet = (await sink.getPacket(start)) || (await sink.getFirstPacket());
        while (packet && packet.timestamp < end) {
          if (packet.timestamp + packet.duration > start) {
            const ts = Math.max(offset, packet.timestamp - start + offset);
            if (ts > lastTs) {
              lastTs = ts;
              await audioSource.add(packet.clone({ timestamp: ts }), first ? { decoderConfig } : undefined);
              first = false;
            }
          }
          packet = await sink.getNextPacket(packet);
        }
        offset += end - start;
      }
      audioSource.close();
    })();

    await Promise.all([doVideo, doAudio]);
    await output.finalize();
    onProgress(1);
    return { buffer: output.target.buffer, ext: isMp4 ? '.mp4' : '.webm', duration: total };
  } finally {
    input.dispose();
  }
}

/**
 * Fallback for videos the fast method can't decode: play the kept parts back and record them.
 * Takes as long as the remaining video, but works anywhere the video can be played.
 */
export async function cutVideoRealtime(blob, cuts, duration, onProgress = () => {}) {
  try {
    return await playAndRecord(blob, cuts, duration, onProgress, true);
  } catch (err) {
    if (err.code !== 'STALLED') throw err;
    // Playback froze, which happens when the sound can't be played. Try again without sound.
    return playAndRecord(blob, cuts, duration, onProgress, false);
  }
}

async function playAndRecord(blob, cuts, duration, onProgress, allowSound) {
  const keep = keptRanges(cuts, duration);
  const total = keep.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (total < 0.2) throw new Error('Nothing would be left of the video. Remove a smaller part.');

  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.src = url;
  video.playsInline = true;
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('The video could not be loaded.')); });

  // Route the sound into the recording instead of the speakers. A suspended audio context stalls
  // the video attached to it, so only route the sound once the context is actually running.
  const audioCtx = new AudioContext();
  await Promise.race([audioCtx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  const dest = audioCtx.createMediaStreamDestination();
  let withSound = false;
  if (allowSound && audioCtx.state === 'running') {
    audioCtx.createMediaElementSource(video).connect(dest);
    withSound = true;
  } else {
    video.muted = true;
  }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  const draw = () => ctx.drawImage(video, 0, 0);
  const stream = canvas.captureStream(30);
  if (withSound) dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  const hasAudio = withSound && dest.stream.getAudioTracks().length > 0;
  // Only MP4 with H.264 plays everywhere; a plain "video/mp4" can mean VP9 inside MP4, which
  // QuickTime can't play. So without H.264, use WebM.
  const types = hasAudio
    ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const seek = (t) => new Promise((res) => {
    if (Math.abs(video.currentTime - t) < 0.001 && video.readyState >= 2) { res(); return; }
    const done = () => { clearTimeout(guard); video.removeEventListener('seeked', done); res(); };
    const guard = setTimeout(done, 3000);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
  let done = 0;
  const timer = setInterval(draw, 1000 / 30);
  try {
    for (const [start, end] of keep) {
      await seek(start);
      draw();
      if (recorder.state === 'inactive') recorder.start(1000);
      else recorder.resume();
      await video.play();
      // A timer rather than requestAnimationFrame, so this keeps going when the window is in the background.
      await new Promise((res, rej) => {
        let lastTime = video.currentTime;
        let lastMove = performance.now();
        const tick = setInterval(() => {
          onProgress(Math.min(0.99, (done + Math.max(0, video.currentTime - start)) / total));
          if (video.currentTime >= end - 0.02 || video.ended) { clearInterval(tick); res(); return; }
          if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastMove = performance.now(); }
          else if (performance.now() - lastMove > 2500) {
            clearInterval(tick);
            const err = new Error('Playback stalled.');
            err.code = 'STALLED';
            rej(err);
          }
        }, 15);
      });
      video.pause();
      recorder.pause();
      done += end - start;
    }
    const stopped = new Promise((res) => { recorder.onstop = res; });
    recorder.stop();
    await stopped;
  } catch (err) {
    video.pause();
    if (recorder.state !== 'inactive') recorder.stop();
    throw err;
  } finally {
    clearInterval(timer);
    audioCtx.close();
    URL.revokeObjectURL(url);
  }
  onProgress(1);
  const out = new Blob(chunks, { type: recorder.mimeType || mime });
  return {
    buffer: await out.arrayBuffer(),
    ext: /mp4/.test(recorder.mimeType || mime) ? '.mp4' : '.webm',
    duration: total,
    withoutSound: !withSound,
  };
}
