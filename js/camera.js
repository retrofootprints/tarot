/* Camera capture and frame pumping.
 *
 * Frames are downscaled to PROCESS_WIDTH before being handed to the worker — recognition
 * was validated at that resolution and anything larger only costs time. The pixel buffer
 * is transferred rather than copied.
 */

const PROCESS_WIDTH = 720;
const TARGET_FPS = 6;

class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.timer = null;
    this.onFrame = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    this.timer = setInterval(() => this.pump(), Math.round(1000 / TARGET_FPS));
  }

  pump() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    if (!vw || !vh || !this.onFrame) return;

    const scale = Math.min(1, PROCESS_WIDTH / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(this.video, 0, 0, w, h);
    const image = this.ctx.getImageData(0, 0, w, h);
    this.onFrame(image, { videoWidth: vw, videoHeight: vh });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

/** Decode a still image file into ImageData at processing resolution. */
async function imageDataFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PROCESS_WIDTH / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return ctx.getImageData(0, 0, w, h);
}

window.CameraKit = { Camera, imageDataFromFile, PROCESS_WIDTH };
