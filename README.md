# Tarot Helper

Point your phone at three tarot cards on a table and get an instant three-card reading.
Everything runs locally in the browser — no backend, no login, no data leaves the device.

**Live: https://retrofootprints.github.io/tarot/**

## How it works

No machine learning is involved. Each Rider-Waite-Smith card is a flat, rigid, highly
detailed picture, which makes it an ideal target for classical feature matching:

1. **Detect** — find card-shaped quadrilaterals in the frame (Canny + adaptive threshold,
   contours, 4-point convex polygons with a tarot-card aspect ratio).
2. **Rectify** — warp each quad to a canonical upright 360×620 rectangle, removing
   perspective.
3. **Shortlist** — rank all 78 cards by a small mean-subtracted intensity signature. This
   costs almost nothing and cuts the expensive step by ~6.5×.
4. **Match** — ORB descriptors against the shortlisted cards, Lowe ratio test, then verify
   the winner with a RANSAC homography. The homography also tells us whether the card is
   upright or reversed.
5. **Confirm** — a card is only locked once two separate frames agree.

Matching is deliberately conservative: when it is unsure it returns *nothing* rather than a
guess. Across validation it never once named the wrong card.

Everything is matched on **grayscale**, never colour. The line art is identical across
Rider-Waite-Smith reprints, so a deck printed with a different palette still matches.

## Measured accuracy

Validated against synthetic camera frames — perspective-warped up to 45°, rescaled, blurred,
JPEG-compressed, with randomised hue/saturation/gamma shifts standing in for a different
deck printing under uneven lighting.

| Condition | Card size in frame | Accuracy |
|---|---|---|
| Three-card scenes (**the real use case**) | 200 px | **120/120 = 100%** |
| Single card, roomy | 300 px | 100% |
| Single card, typical | 200 px | 100% |
| Single card, steep angle (45°) | 200 px | 100% |
| Single card, small | 150 px | 100% |
| Single card, very small | 110 px | 92.3% |

False identifications across every run: **0**.

## Using it

Lay three cards face up, side by side, reasonably well lit and not overlapping. Tap
**Start a reading** and hold the phone so all three are in frame.

- **Use a photo instead** — run it against a still image rather than the live camera.
- **Pick cards by hand** — searchable list of all 78, for when recognition struggles.
- **`?debug=1`** — shows detected quads, inlier counts and per-frame timings.

First load is ~3.4 MB gzipped (mostly OpenCV). A service worker caches it, so afterwards it
loads instantly and works offline.

## Repository layout

    index.html              the app
    css/styles.css
    js/app.js               state machine, UI, temporal locking
    js/camera.js            getUserMedia capture and frame pump
    js/reading.js           three-card narrative
    js/recognizer.core.js   the recognition algorithm (no DOM/worker APIs)
    js/recognizer.worker.js worker transport around the core
    data/cards.json         all 78 card meanings
    data/card_db.bin        46,800 ORB descriptors (1.4 MB)
    data/card_sig.bin       shortlist signatures (146 KB)
    assets/cards/           78 thumbnails
    vendor/opencv.js

The build tooling that generates `data/` and `assets/` is kept out of this repo; only the
files the site needs are committed.

## Credits

Card artwork is the Rider-Waite-Smith deck (Pamela Colman Smith, published 1909), in the
public domain, via [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:Rider-Waite_tarot_deck).
Card interpretations were written for this project.
