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
    try {
      await init();
      self.postMessage({ type: 'ready', cardCount });
    } catch (err) {
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
