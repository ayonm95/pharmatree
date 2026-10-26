/**
 * Web Audio API synthesized sensory feedback for PharmaTree POS Terminal.
 * 100% self-contained: zero external audio assets or network downloads required.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Triggers physical device haptic vibration if supported (mobile / barcode terminals).
 */
export function triggerHaptic(pattern: number | number[] = 100) {
  if (typeof window !== "undefined" && "navigator" in window && navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {
      // Ignore vibration failures if permissions denied
    }
  }
}

/**
 * Positive scanning chime: Dual-tone ascending chirp (880Hz -> 1760Hz)
 */
export function playBeepSuccess() {
  const ctx = getAudioContext();
  if (!ctx) return;

  triggerHaptic([40, 30, 40]);

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(880, now); // A5
  osc.frequency.exponentialRampToValueAtTime(1760, now + 0.08); // A6

  gain.gain.setValueAtTime(0.18, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.15);
}

/**
 * Dispensed confirmation chord: Ascending C Major Triad (C5, E5, G5, C6)
 */
export function playDispensedSuccess() {
  const ctx = getAudioContext();
  if (!ctx) return;

  triggerHaptic([80, 50, 120]);

  const freqs = [523.25, 659.25, 783.99, 1046.5];
  const now = ctx.currentTime;

  freqs.forEach((freq, idx) => {
    const startTime = now + idx * 0.06;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.2, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.25);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + 0.25);
  });
}

/**
 * Emergency Counterfeit / Replay / Contamination Siren:
 * Pulsing high-low alarm sweep (880Hz <-> 440Hz) with aggressive square/sawtooth tones
 * Accompanied by urgent long haptic vibration pulses.
 */
export function playSirenAlarm() {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Heavy emergency vibration
  triggerHaptic([200, 100, 200, 100, 400]);

  const now = ctx.currentTime;
  const duration = 0.9; // 900ms duration

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sawtooth";

  // Modulate frequency to create an emergency warble
  const pulseCount = 3;
  for (let i = 0; i < pulseCount; i++) {
    const startPulse = now + (i * duration) / pulseCount;
    const midPulse = startPulse + duration / pulseCount / 2;
    const endPulse = startPulse + duration / pulseCount;

    osc.frequency.setValueAtTime(880, startPulse);
    osc.frequency.linearRampToValueAtTime(440, midPulse);
    osc.frequency.linearRampToValueAtTime(880, endPulse);
  }

  gain.gain.setValueAtTime(0.25, now);
  gain.gain.linearRampToValueAtTime(0.25, now + duration - 0.1);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + duration);
}

/**
 * Tactile UI click sound
 */
export function playClickSound() {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(1200, now);
  gain.gain.setValueAtTime(0.08, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.04);
}
