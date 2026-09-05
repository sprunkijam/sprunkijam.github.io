import {
  createAudioContext,
  kickAudioUnlock,
  kickResumeContext,
  kickUnlockHtmlAudio,
  resumeContext,
} from "./unlock";

let chimeCtx: AudioContext | null = null;

async function ensureChimeCtx(): Promise<AudioContext> {
  kickUnlockHtmlAudio();
  if (!chimeCtx || chimeCtx.state === "closed") {
    chimeCtx = createAudioContext();
  }
  await resumeContext(chimeCtx);
  return chimeCtx;
}

/**
 * Big crash/cymbal stinger for TAP TO JAM — sync, same user-gesture turn as unlock.
 * Original Web Audio only (no samples). Must not await before unlock/resume kick.
 */
export function playJamStartCymbal(): void {
  try {
    kickUnlockHtmlAudio(true);
    if (!chimeCtx || chimeCtx.state === "closed") {
      chimeCtx = createAudioContext();
    }
    kickAudioUnlock(chimeCtx);
    kickResumeContext(chimeCtx);
    const ctx = chimeCtx;
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.85, now + 0.012);
    master.gain.exponentialRampToValueAtTime(0.28, now + 0.18);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
    master.connect(ctx.destination);

    // Bright noise burst through a bandpass → crash wash.
    const dur = 1.55;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      const env = Math.pow(1 - i / frames, 1.65);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(4200, now);
    bp.frequency.exponentialRampToValueAtTime(1800, now + 0.55);
    bp.Q.value = 0.55;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 600;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.95, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    noise.connect(hp).connect(bp).connect(noiseGain).connect(master);
    noise.start(now);
    noise.stop(now + dur);

    // Metallic partials — short ping stack on top of the wash.
    const partials = [520, 780, 1180, 1640, 2450];
    for (const [i, freq] of partials.entries()) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = i % 2 === 0 ? "triangle" : "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.008;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22 - i * 0.03, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55 + i * 0.08);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.7 + i * 0.08);
    }
  } catch (err) {
    console.error(err);
  }
}

/** Soft sparkle chime for the ring easter egg (gesture-safe). */
export async function playRingChime(): Promise<void> {
  const ctx = await ensureChimeCtx();
  const now = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.22, now + 0.03);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
  master.connect(ctx.destination);

  const notes = [784, 988, 1175, 1568]; // G5 B5 D6 G6
  notes.forEach((freq, i) => {
    const t = now + i * 0.07;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = i === 3 ? "sine" : "triangle";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 - i * 0.02, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.6);
  });
}

/** Kid cartoon-horror “dark hat” sting for Mr. Black’s secret hotspot. */
export async function playDarkHatChime(): Promise<void> {
  const ctx = await ensureChimeCtx();
  const now = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.2, now + 0.04);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
  master.connect(ctx.destination);

  // Low, soft descent — playful spooky, not scary-loud.
  const notes = [220, 196, 164.81, 130.81]; // A3 G3 E3 C3
  notes.forEach((freq, i) => {
    const t = now + i * 0.11;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = i % 2 === 0 ? "triangle" : "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 - i * 0.02, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.75);
  });
}
