// Live barcode scanning. Uses the native BarcodeDetector where it exists
// (Chrome/Android) and the ZXing WebAssembly polyfill everywhere else
// (iPhone Safari has no native detector). Also decodes still photos.
import { canonicalCode, digitsOnly, isValidGtin, upcEtoA } from './lookup.js';

const POLYFILL_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.4/dist/es/ponyfill.js/+esm';
const FORMATS = ['ean_13', 'upc_a', 'upc_e', 'ean_8'];

let detectorPromise = null;

export function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      if ('BarcodeDetector' in window) {
        try {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          const formats = FORMATS.filter(format => supported.includes(format));
          if (formats.length >= 2) return { detector: new window.BarcodeDetector({ formats }), engine: 'native' };
        } catch { /* fall back to the polyfill */ }
      }
      const module = await import(POLYFILL_URL);
      return { detector: new module.BarcodeDetector({ formats: FORMATS }), engine: 'zxing' };
    })().catch(error => {
      detectorPromise = null;
      throw Object.assign(new Error('The barcode reader could not load. Check your connection.'), { name: 'DetectorUnavailable', cause: error });
    });
  }
  return detectorPromise;
}

function validCodes(codes = []) {
  return codes
    .map(code => ({ value: digitsOnly(code.rawValue), format: code.format }))
    .filter(code => (code.format === 'upc_e' ? isValidGtin(upcEtoA(code.value) || '') : isValidGtin(code.value)))
    .map(code => ({ ...code, key: canonicalCode(code.value, code.format) }));
}

export class Scanner {
  constructor(video, { onCode, onState } = {}) {
    this.video = video;
    this.onCode = onCode || (() => {});
    this.onState = onState || (() => {});
    this.running = false;
    this.paused = false;
    this.busy = false;
    this.torchOn = false;
    this.torchSupported = false;
    this.loop = this.loop.bind(this);
  }

  async start() {
    if (this.running || this.starting) return;
    this.starting = true;
    this.onState('starting');
    try {
      if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
      const [streamResult, detectorResult] = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }),
        getDetector(),
      ]);
      if (streamResult.status === 'rejected') throw streamResult.reason;
      if (detectorResult.status === 'rejected') {
        streamResult.value.getTracks().forEach(track => track.stop());
        throw detectorResult.reason;
      }
      this.stream = streamResult.value;
      this.detector = detectorResult.value.detector;
      this.engine = detectorResult.value.engine;
      this.video.setAttribute('playsinline', '');
      this.video.muted = true;
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => {});
      this.track = this.stream.getVideoTracks()[0];
      const capabilities = this.track?.getCapabilities?.() || {};
      this.torchSupported = Boolean(capabilities.torch);
      if (capabilities.focusMode?.includes?.('continuous')) this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      this.running = true;
      this.paused = false;
      this.candidate = null;
      this.onState('scanning', { engine: this.engine });
      this.loop();
    } finally {
      this.starting = false;
    }
  }

  async loop() {
    if (!this.running) return;
    const startedAt = performance.now();
    if (!this.paused && !this.busy && this.video.readyState >= 2) {
      this.busy = true;
      try {
        this.handle(await this.detector.detect(this.video));
      } catch { /* a bad frame is not fatal */ }
      this.busy = false;
    }
    const elapsed = performance.now() - startedAt;
    this.timer = setTimeout(this.loop, Math.max(50, 130 - elapsed));
  }

  handle(raw) {
    const now = performance.now();
    const codes = validCodes(raw);
    if (this.suppressed) {
      if (codes.some(code => code.key === this.suppressed.key)) this.suppressed.lastSeen = now;
      if (now - this.suppressed.lastSeen > 900 || now - this.suppressed.since > 8000) this.suppressed = null;
    }
    const code = codes.find(candidate => candidate.key !== this.suppressed?.key);
    if (!code) return;
    // Require two matching reads in a row so a half-seen barcode can't slip through.
    if (this.candidate?.key === code.key && now - this.candidate.at < 1500) {
      this.candidate = null;
      this.suppressed = { key: code.key, since: now, lastSeen: now };
      this.paused = true;
      this.onCode(code);
    } else {
      this.candidate = { key: code.key, at: now };
    }
  }

  /** Continue scanning; the code just handled stays ignored until it leaves the frame. */
  resume() {
    if (!this.running) return;
    if (this.suppressed) this.suppressed.lastSeen = performance.now();
    this.paused = false;
    this.onState('scanning', { engine: this.engine });
  }

  pause() {
    this.paused = true;
  }

  async setTorch(on) {
    if (!this.track || !this.torchSupported) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: on }] });
      this.torchOn = on;
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.track = null;
    this.torchOn = false;
    if (this.video) this.video.srcObject = null;
    this.onState('stopped');
  }
}

/** Decode a barcode from a photo (works even without HTTPS camera access). */
export async function decodeImageFile(file) {
  const { detector } = await getDetector();
  const bitmap = await createImageBitmap(file);
  try {
    let codes = validCodes(await detector.detect(bitmap));
    if (!codes.length && bitmap.width > 1800) {
      const scale = 1600 / bitmap.width;
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      codes = validCodes(await detector.detect(canvas));
    }
    return codes[0] || null;
  } finally {
    bitmap.close?.();
  }
}

export function cameraErrorMessage(error) {
  const messages = {
    InsecureContext: 'Live camera scanning needs the app on a secure https:// link. Take a photo of the barcode instead, or search below.',
    NotAllowedError: 'Camera access is off for this site. Allow it in Settings › Safari › Camera (or your browser’s site settings), or take a photo instead.',
    NotFoundError: 'No camera was found on this device. Search or type the UPC below.',
    NotReadableError: 'The camera is busy in another app. Close it and try again.',
    OverconstrainedError: 'This camera doesn’t support scanning. Take a photo of the barcode instead.',
    NotSupportedError: 'This browser can’t open the camera. Take a photo of the barcode or search below.',
    SecurityError: 'Live camera scanning needs a secure https:// link. Take a photo of the barcode instead.',
    DetectorUnavailable: 'The barcode reader couldn’t load (are you offline?). Search or type the UPC below.',
  };
  return messages[error?.name] || 'Couldn’t start the camera. Take a photo of the barcode or search below.';
}

// Scan feedback: a short beep (Web Audio) plus a buzz where supported.
let audio;
export function primeAudio() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* audio is optional */ }
}

export function scanFeedback(enabled = true) {
  navigator.vibrate?.(35);
  if (!enabled || !audio) return;
  try {
    const now = audio.currentTime;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1318, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.14);
  } catch { /* ignore */ }
}
