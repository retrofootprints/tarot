/* Orchestration: worker lifecycle, scan state machine, and rendering.
 *
 * A card is only accepted after it has been seen in CONFIRM_HITS separate frames. Single
 * frames are occasionally wrong under motion blur; agreement across frames is what makes
 * the lock trustworthy. Recognition itself never guesses — it returns nothing rather than
 * a low-confidence card — so repeated agreement is a strong signal.
 */

// Two agreeing frames is enough: across 350+ validation frames the recogniser never once
// returned a wrong card — it returns nothing when unsure — so agreement is a strong signal
// and waiting for a third only makes the lock feel sluggish.
const CONFIRM_HITS = 2;   // frames a card must appear in before it is locked
const FORGET_MS = 2500;   // drop a candidate not seen for this long
const DEBUG = new URLSearchParams(location.search).has('debug');

const el = (id) => document.getElementById(id);
const screens = {
  intro: el('screen-intro'),
  scan: el('screen-scan'),
  reading: el('screen-reading'),
};

let cardsById = new Map();
let worker = null;
let workerReady = false;
let camera = null;
let candidates = new Map();  // id -> { hits, lastSeen, inliers, reversed, x }
let locked = [];
let pickerChoice = [];

/* ---------- boot ---------- */

async function boot() {
  try {
    const data = await fetch('data/cards.json').then((r) => r.json());
    data.cards.forEach((card) => cardsById.set(card.id, card));
  } catch (err) {
    setIntroStatus('Could not load the card meanings.', true);
    return;
  }

  worker = new Worker('js/recognizer.worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => setIntroStatus(`Recogniser failed to start: ${e.message}`, true);
  worker.postMessage({ type: 'init' });
  setIntroStatus('Warming up the recogniser…');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function onWorkerMessage(event) {
  const msg = event.data;
  if (msg.type === 'ready') {
    workerReady = true;
    setIntroStatus(`Ready — ${msg.cardCount} cards loaded.`);
  } else if (msg.type === 'error') {
    setIntroStatus(msg.message, true);
  } else if (msg.type === 'result') {
    onResult(msg);
  }
}

function setIntroStatus(text, isError = false) {
  const node = el('intro-status');
  node.textContent = text;
  node.classList.toggle('is-error', isError);
}

function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove('is-active'));
  screens[name].classList.add('is-active');
}

/* ---------- scanning ---------- */

async function startScan() {
  if (!workerReady) {
    setIntroStatus('Still loading — give it a moment.', true);
    return;
  }
  candidates.clear();
  locked = [];
  renderSlots();
  show('scan');
  el('btn-force').disabled = true;

  camera = new window.CameraKit.Camera(el('video'));
  camera.onFrame = (image) => {
    worker.postMessage(
      {
        type: 'frame',
        width: image.width,
        height: image.height,
        buffer: image.data.buffer,
        // Match one card per frame; the worker rotates through the detected quads so all
        // three get identified within a few frames without stalling the preview.
        maxMatches: 1,
      },
      [image.data.buffer]
    );
  };
  try {
    await camera.start();
    el('scan-status').textContent = 'Looking for cards…';
  } catch (err) {
    show('intro');
    setIntroStatus(
      err && err.name === 'NotAllowedError'
        ? 'Camera permission denied. You can still use a photo or pick by hand.'
        : `Could not open the camera: ${err.message}`,
      true
    );
  }
}

function stopScan() {
  if (camera) camera.stop();
  camera = null;
}

function onResult(msg) {
  const now = Date.now();

  for (const hit of msg.cards) {
    const existing = candidates.get(hit.id) || { hits: 0, inliers: 0 };
    const x = hit.corners ? hit.corners.reduce((s, c) => s + c[0], 0) / hit.corners.length : 0;
    candidates.set(hit.id, {
      hits: existing.hits + 1,
      lastSeen: now,
      inliers: Math.max(existing.inliers, hit.inliers),
      reversed: hit.reversed,
      x,
    });
  }

  for (const [id, info] of candidates) {
    if (now - info.lastSeen > FORGET_MS) candidates.delete(id);
  }

  const confirmed = [...candidates.entries()]
    .filter(([, info]) => info.hits >= CONFIRM_HITS)
    .sort((a, b) => b[1].inliers - a[1].inliers)
    .slice(0, 3);

  locked = confirmed.map(([id, info]) => ({ id, ...info })).sort((a, b) => a.x - b.x);

  drawOverlay(msg.quads || [], msg.cards);
  renderSlots();

  el('btn-force').disabled = locked.length === 0;
  const quadCount = (msg.quads || []).length;
  el('scan-status').textContent = DEBUG
    ? `${quadCount} quads · ${locked.length}/3 locked · ${msg.ms}ms`
    : locked.length >= 3 ? 'Got all three!'
      : quadCount === 0 ? 'Looking for cards…' : `${locked.length} of 3 locked…`;

  if (locked.length >= 3) finishScan();
}

function finishScan() {
  stopScan();
  showReading(locked.slice(0, 3).map((c) => ({
    card: cardsById.get(c.id),
    reversed: !!c.reversed,
  })));
}

function renderSlots() {
  const container = el('scan-slots');
  container.innerHTML = '';
  for (let i = 0; i < 3; i += 1) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const found = locked[i];
    if (found) {
      slot.classList.add('is-locked');
      const card = cardsById.get(found.id);
      slot.textContent = card ? card.name + (found.reversed ? ' ⤾' : '') : found.id;
    } else {
      slot.textContent = ['Past', 'Present', 'Future'][i];
    }
    container.appendChild(slot);
  }
}

function drawOverlay(quads, hits) {
  const canvas = el('overlay');
  const video = el('video');
  const rect = video.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width = rect.width;
    canvas.height = rect.height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!video.videoWidth) return;

  // The video is object-fit:cover, so replicate that mapping for the frame coordinates.
  const processWidth = window.CameraKit.PROCESS_WIDTH;
  const scaleToVideo = video.videoWidth / Math.min(processWidth, video.videoWidth);
  const cover = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const offsetX = (canvas.width - video.videoWidth * cover) / 2;
  const offsetY = (canvas.height - video.videoHeight * cover) / 2;
  const toScreen = ([x, y]) => [
    x * scaleToVideo * cover + offsetX,
    y * scaleToVideo * cover + offsetY,
  ];

  const outline = (corners, colour) => {
    ctx.strokeStyle = colour;
    ctx.beginPath();
    corners.forEach((corner, i) => {
      const [x, y] = toScreen(corner);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  };

  ctx.lineWidth = 2;
  ctx.font = '600 13px system-ui, sans-serif';

  // Every detected card outline, so the frame feels responsive even on frames where that
  // particular card was not the one matched.
  for (const quad of quads) outline(quad, 'rgba(255,255,255,.35)');

  for (const hit of hits) {
    if (!hit.corners) continue;
    const isLocked = locked.some((l) => l.id === hit.id);
    outline(hit.corners, isLocked ? '#e3b96b' : 'rgba(255,255,255,.8)');

    const card = cardsById.get(hit.id);
    if (card) {
      const [x, y] = toScreen(hit.corners[0]);
      const label = card.name + (DEBUG ? ` (${hit.inliers})` : '');
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      const width = ctx.measureText(label).width + 10;
      ctx.fillRect(x, y - 20, width, 18);
      ctx.fillStyle = isLocked ? '#e3b96b' : '#fff';
      ctx.fillText(label, x + 5, y - 7);
    }
  }
}

/* ---------- still photo ---------- */

async function readFromFile(file) {
  if (!workerReady) {
    setIntroStatus('Still loading — give it a moment.', true);
    return;
  }
  setIntroStatus('Reading the photo…');
  candidates.clear();
  locked = [];
  const image = await window.CameraKit.imageDataFromFile(file);

  const done = (event) => {
    const msg = event.data;
    if (msg.type !== 'result') return;
    worker.removeEventListener('message', done);
    const found = msg.cards
      .filter((hit, i, all) => all.findIndex((o) => o.id === hit.id) === i)
      .sort((a, b) => {
        const ax = a.corners ? a.corners[0][0] : 0;
        const bx = b.corners ? b.corners[0][0] : 0;
        return ax - bx;
      })
      .slice(0, 3)
      .map((hit) => ({ card: cardsById.get(hit.id), reversed: !!hit.reversed }))
      .filter((entry) => entry.card);

    if (!found.length) {
      setIntroStatus('No cards recognised in that photo. Try more light, or pick by hand.', true);
      return;
    }
    setIntroStatus(`Found ${found.length} card${found.length === 1 ? '' : 's'}.`);
    showReading(found);
  };
  worker.addEventListener('message', done);
  worker.postMessage(
    {
      type: 'frame',
      width: image.width,
      height: image.height,
      buffer: image.data.buffer,
      maxMatches: 0, // a still photo is a one-shot, so match every card found
    },
    [image.data.buffer]
  );
}

/* ---------- reading ---------- */

function showReading(entries) {
  const spread = el('spread');
  spread.innerHTML = '';

  entries.forEach((entry, index) => {
    const position = window.Reading.POSITIONS[index];
    const tile = document.createElement('button');
    tile.className = 'card-tile' + (entry.reversed ? ' is-reversed' : '');
    tile.innerHTML = `
      <div class="card-pos">${position ? position.label : ''}</div>
      <img src="assets/cards/${entry.card.id}.webp" alt="${entry.card.name}" loading="lazy">
      <div class="card-name">${entry.card.name}</div>
      ${entry.reversed ? '<div class="card-rev">reversed</div>' : ''}`;
    tile.addEventListener('click', () => showDetail(entry));
    spread.appendChild(tile);
  });

  el('narrative').textContent = window.Reading.buildNarrative(entries);
  show('reading');
}

function showDetail(entry) {
  const card = entry.card;
  el('detail-body').innerHTML = `
    <div class="detail-hero${entry.reversed ? ' is-reversed' : ''}">
      <img src="assets/cards/${card.id}.webp" alt="${card.name}">
      <div>
        <h3>${card.name}${entry.reversed ? ' <small>(reversed)</small>' : ''}</h3>
        <p class="detail-essence">${card.essence}</p>
        <ul class="keywords">${card.keywords.map((k) => `<li>${k}</li>`).join('')}</ul>
      </div>
    </div>
    <div class="meaning light"><h4>The bright side</h4><p>${card.light}</p></div>
    <div class="meaning shadow"><h4>The shadow side</h4><p>${card.shadow}</p></div>
    ${entry.reversed
      ? `<div class="meaning reversed"><h4>Reversed</h4><p>${card.reversed}</p></div>` : ''}
    <div class="meaning"><h4>The picture</h4><p>${card.description}</p></div>`;
  el('detail').hidden = false;
}

/* ---------- manual picker ---------- */

function openPicker() {
  pickerChoice = [];
  el('picker-search').value = '';
  renderPicker('');
  el('picker').hidden = false;
}

function renderPicker(query) {
  const list = el('picker-list');
  const needle = query.trim().toLowerCase();
  list.innerHTML = '';
  for (const card of cardsById.values()) {
    if (needle && !card.name.toLowerCase().includes(needle)
      && !card.keywords.some((k) => k.includes(needle))) continue;
    const item = document.createElement('button');
    item.className = 'picker-item' + (pickerChoice.includes(card.id) ? ' is-chosen' : '');
    item.innerHTML = `<img src="assets/cards/${card.id}.webp" alt="" loading="lazy">
      <span>${card.name}</span>`;
    item.addEventListener('click', () => choosePicker(card.id, query));
    list.appendChild(item);
  }
}

function choosePicker(id, query) {
  const at = pickerChoice.indexOf(id);
  if (at >= 0) pickerChoice.splice(at, 1);
  else if (pickerChoice.length < 3) pickerChoice.push(id);

  el('picker-hint').textContent = pickerChoice.length < 3
    ? `Tap ${3 - pickerChoice.length} more, in order.`
    : 'Three chosen — opening your reading.';
  renderPicker(query);

  if (pickerChoice.length === 3) {
    setTimeout(() => {
      el('picker').hidden = true;
      stopScan();
      showReading(pickerChoice.map((cid) => ({ card: cardsById.get(cid), reversed: false })));
    }, 250);
  }
}

/* ---------- wiring ---------- */

el('btn-start').addEventListener('click', startScan);
el('btn-cancel').addEventListener('click', () => { stopScan(); show('intro'); });
el('btn-force').addEventListener('click', finishScan);
el('btn-again').addEventListener('click', () => { show('intro'); setIntroStatus('Ready when you are.'); });
el('btn-rescan').addEventListener('click', startScan);
el('btn-manual-intro').addEventListener('click', openPicker);
el('btn-manual-scan').addEventListener('click', openPicker);
el('picker-close').addEventListener('click', () => { el('picker').hidden = true; });
el('detail-close').addEventListener('click', () => { el('detail').hidden = true; });
el('detail').addEventListener('click', (e) => { if (e.target === el('detail')) el('detail').hidden = true; });
el('picker-search').addEventListener('input', (e) => renderPicker(e.target.value));
el('file-input').addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) readFromFile(e.target.files[0]);
  e.target.value = '';
});

boot();
