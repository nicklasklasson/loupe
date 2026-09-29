'use strict';

// Text recognition (OCR) that runs entirely on this computer. Uses tesseract.js with the
// English and Swedish language data bundled in assets/ocr, so nothing is downloaded or sent anywhere.

const path = require('path');
const fs = require('fs');

const LANGUAGES = ['eng', 'swe'];
const IDLE_MS = 5 * 60 * 1000; // free the memory after five minutes without use

let workerPromise = null;
let idleTimer = null;

function langPath() {
  return path.join(__dirname, 'assets', 'ocr');
}

function getWorker(cachePath) {
  if (!workerPromise) {
    // Loaded on first use so the app starts just as fast as before.
    const { createWorker } = require('tesseract.js');
    fs.mkdirSync(cachePath, { recursive: true });
    workerPromise = createWorker(LANGUAGES, 1, {
      langPath: langPath(),
      cachePath,
      gzip: true,
      logger: () => {},
      errorHandler: (err) => console.warn('OCR worker error', err),
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function scheduleIdleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = workerPromise;
    workerPromise = null;
    if (p) {
      try { (await p).terminate(); } catch { /* already gone */ }
    }
  }, IDLE_MS);
}

function tidy(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, '').replace(/^[|¦]\s+/, '').replace(/\s+[|¦]$/, '')) // borders read as "|"
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Recognise the text in a PNG image.
 * @param {Buffer} png
 * @param {string} cachePath a writable folder for tesseract's unpacked language data
 * @returns {Promise<string>}
 */
async function recognize(png, cachePath) {
  const worker = await getWorker(cachePath);
  clearTimeout(idleTimer);
  try {
    const { data } = await worker.recognize(png);
    return tidy(data.text);
  } finally {
    scheduleIdleShutdown();
  }
}

async function shutdown() {
  clearTimeout(idleTimer);
  const p = workerPromise;
  workerPromise = null;
  if (p) {
    try { (await p).terminate(); } catch { /* ignore */ }
  }
}

module.exports = { recognize, shutdown };
