/*
 * Worker transport around js/recognizer.core.js — keeps opencv.js and the ~46k descriptor
 * match off the main thread so the camera preview stays smooth.
 *
 * Protocol
 *   in : {type:'init'}                                    -> {type:'ready', cardCount}
 *        {type:'frame', width, height, buffer}  (RGBA, transferred)
 *   out: {type:'result', cards:[{id, inliers, margin, reversed, corners}], ms}
 *        {type:'error', message}
 */

let recognizer = null;
let cardCount = 0;
let busy = false;
let rotation = 0; // which quad to match next, so work is spread across frames

// Uncaught exceptions inside async callbacks (notably OpenCV's own WASM bootstrap promise
// chain) don't reach the try/catch below and don't trigger the main thread's worker.onerror
// either — they just vanish, which on some iPhones is exactly what happens when the WASM
// module fails to instantiate under memory pressure. Surface them explicitly instead of
// leaving the page stuck on "still loading" forever.
self.addEventListener('error', (event) => {
  self.postMessage({
    type: 'error',
    message: `Worker error: ${event.message || event} (${event.filename || '?'}:${event.lineno || '?'})`,
  });
});
self.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  self.postMessage({
    type: 'error',
    message: `Unhandled rejection during setup: ${(reason && reason.message) || reason}`,
  });
});

self.importScripts('recognizer.core.js');

function loadOpenCV() {
  return new Promise((resolve, reject) => {
    self.Module = {
      onRuntimeInitialized() { resolve(self.cv); },
      printErr() {},
    };
    try {
      self.importScripts('../vendor/opencv.js');
      // Some builds resolve a promise instead of calling onRuntimeInitialized.
      if (self.cv instanceof Promise) self.cv.then(resolve, reject);
      else if (self.cv && self.cv.Mat) resolve(self.cv);
    } catch (err) {
      reject(err);
    }
  });
}

async function init() {
  const cv = await loadOpenCV();
  const [meta, binary, signatures] = await Promise.all([
    fetch('../data/card_db.json').then((r) => r.json()),
    fetch('../data/card_db.bin').then((r) => r.arrayBuffer()),
    fetch('../data/card_sig.bin').then((r) => r.arrayBuffer()),
  ]);
  const db = self.RecognizerCore.buildDatabase(cv, meta, binary, signatures);
  recognizer = self.RecognizerCore.createRecognizer(cv, db);
  cardCount = db.entries.length;
}

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'init') {
    // If OpenCV's WASM bootstrap never calls back (seen on some iPhones under memory
    // pressure), surface something actionable instead of leaving the button spinning
    // forever with no explanation.
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        self.postMessage({
          type: 'error',
          message: 'Still trying to start the recogniser after 20s. On iPhone this usually '
            + 'means the browser ran low on memory loading OpenCV — try closing other tabs '
            + 'and apps, then reload the page.',
        });
      }
    }, 20000);

    try {
      await init();
      settled = true;
      clearTimeout(timer);
      self.postMessage({ type: 'ready', cardCount });
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
    return;
  }

  if (msg.type === 'frame') {
    // Drop frames that arrive mid-match; latency matters more than processing every one.
    if (busy || !recognizer) return;
    busy = true;
    try {
      const started = Date.now();
      const out = recognizer.processFrame(
        new Uint8Array(msg.buffer), msg.width, msg.height,
        { maxMatches: msg.maxMatches, startIndex: rotation });
      rotation += 1;
      self.postMessage({
        type: 'result',
        cards: out.cards,
        quads: out.quads,
        ms: Date.now() - started,
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    } finally {
      busy = false;
    }
  }
};
