/**
 * Soft looping title-bed for the gate screen.
 * Original Web Audio only — warm backyard pads + a gentle chime arpeggio.
 * Starts on first user gesture; fades out before the stage jam.
 * Does not try to bypass the iOS silent switch.
 */

import {
  createAudioContext,
  kickAudioUnlock,
  kickResumeContext,
  kickUnlockHtmlAudio,
  watchAudioResume,
} from "./unlock";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let started = false;
let attempted = false;
let stopping = false;
let resumeWatched = false;
const nodes: AudioNode[] = [];
const oscs: OscillatorNode[] = [];
let lfo: OscillatorNode | null = null;
let arpTimer: number | null = null;
let arpDest: AudioNode | null = null;
let arpStep = 0;

/** C major pentatonic bells — clearly “music”, still gentle. */
const ARP_NOTES = [523.25, 659.25, 783.99, 659.25, 880.0, 783.99, 659.25, 523.25];

/**
 * Kick the title bed in this user-gesture turn (no await).
 * Safe to call repeatedly — only the first gesture starts it.
 * PR #4 unlock (HTMLAudio + ctx.resume + silent buffer) runs before the bed.
 */
export function startTitleBed(): void {
  if (started || stopping) return;
  attempted = true;
  try {
    kickUnlockHtmlAudio(true);
    if (!ctx || ctx.state === "closed") {
      ctx = createAudioContext();
      resumeWatched = false;
    }
    kickAudioUnlock(ctx);
    kickResumeContext(ctx);
    buildBed(ctx);
    if (!resumeWatched) {
      watchAudioResume(ctx, {
        onResume: () => {
          resumeTitleBedClock();
        },
      });
      resumeWatched = true;
    }
    started = true;
  } catch (err) {
    console.error(err);
  }
}

/** Fade out and release so stage stems do not fight the title bed. */
export function stopTitleBed(): void {
  if (!started || stopping) {
    // Still mark stopping so a late startTitleBed after TAP TO JAM is ignored.
    stopping = true;
    return;
  }
  stopping = true;
  clearArp();
  const c = ctx;
  const g = master;
  if (!c || !g) {
    teardown();
    return;
  }
  const now = c.currentTime;
  try {
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
  } catch {
    /* ignore */
  }
  window.setTimeout(() => {
    for (const osc of oscs) {
      try {
        osc.stop();
      } catch {
        /* ignore */
      }
    }
    if (lfo) {
      try {
        lfo.stop();
      } catch {
        /* ignore */
      }
    }
    teardown();
  }, 520);
}

export function isTitleBedPlaying(): boolean {
  if (!started || stopping || !ctx) return false;
  const state = ctx.state as string;
  return state === "running";
}

/** True after the first startTitleBed() call (even if the context stayed suspended). */
export function titleBedAttempted(): boolean {
  return attempted;
}

/** Live Web Audio state, or null before any context exists. Includes WebKit `interrupted`. */
export function titleBedContextState(): string | null {
  return ctx ? (ctx.state as string) : null;
}

/** Playwright: suspend the title-bed context (iOS hide simulation). */
export async function suspendTitleBedForTest(): Promise<void> {
  if (!ctx || ctx.state === "closed") return;
  try {
    await ctx.suspend();
  } catch {
    /* ignore */
  }
}

/**
 * Restart the title-bed arp if a backgrounded timer was dropped.
 * Does not start the bed — TAP TO JAM / gate gesture still own start.
 */
function resumeTitleBedClock(): void {
  if (!started || stopping || !ctx || !master || !arpDest) return;
  if (arpTimer == null) scheduleArp(ctx, arpDest, ctx.currentTime + 0.05);
}

function teardown(): void {
  clearArp();
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      /* ignore */
    }
  }
  nodes.length = 0;
  oscs.length = 0;
  lfo = null;
  master = null;
  started = false;
  arpDest = null;
  // Leave ctx around — reuse is fine on gate retry.
}

function clearArp(): void {
  if (arpTimer != null) {
    window.clearTimeout(arpTimer);
    arpTimer = null;
  }
}

function buildBed(audio: AudioContext): void {
  // Tear any half-built graph from a prior failed start.
  clearArp();
  for (const osc of oscs) {
    try {
      osc.stop();
    } catch {
      /* ignore */
    }
  }
  oscs.length = 0;
  nodes.length = 0;

  const m = audio.createGain();
  m.gain.value = 0.0001;
  m.connect(audio.destination);
  master = m;
  nodes.push(m);

  // Warm low-pass — soft, not harsh; high enough that bells still read as melody.
  const lp = audio.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2400;
  lp.Q.value = 0.65;
  lp.connect(m);
  nodes.push(lp);

  // Gentle pulse bus (LFO → gain).
  const pulse = audio.createGain();
  pulse.gain.value = 0.78;
  pulse.connect(lp);
  nodes.push(pulse);

  lfo = audio.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 1.15; // soft heartbeat-ish pulse
  const lfoGain = audio.createGain();
  lfoGain.gain.value = 0.22;
  lfo.connect(lfoGain);
  lfoGain.connect(pulse.gain);
  nodes.push(lfoGain);
  lfo.start();

  // Soft backyard pad — C major-ish open voicing, clearly audible on iPhone.
  const padFreqs: { f: number; type: OscillatorType; gain: number }[] = [
    { f: 130.81, type: "sine", gain: 0.28 }, // C3
    { f: 196.0, type: "sine", gain: 0.22 }, // G3
    { f: 329.63, type: "triangle", gain: 0.14 }, // E4
    { f: 440.0, type: "sine", gain: 0.1 }, // A4 — airy top
    { f: 131.2, type: "triangle", gain: 0.1 }, // slight detune warmth
  ];

  const now = audio.currentTime;
  for (const [i, spec] of padFreqs.entries()) {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = spec.type;
    osc.frequency.value = spec.f;
    osc.detune.value = (i - 2) * 4;
    g.gain.value = spec.gain;
    osc.connect(g);
    g.connect(pulse);
    osc.start(now);
    oscs.push(osc);
    nodes.push(g);
  }

  // Bell bus — lighter filter so the arpeggio is obviously music, not a pad hum.
  const bellHp = audio.createBiquadFilter();
  bellHp.type = "highpass";
  bellHp.frequency.value = 420;
  const bellGain = audio.createGain();
  bellGain.gain.value = 0.55;
  bellHp.connect(bellGain);
  bellGain.connect(m);
  nodes.push(bellHp, bellGain);

  arpStep = 0;
  arpDest = bellHp;
  scheduleArp(audio, bellHp, now + 0.55);

  // Fade in to a clear gentle level (was ~0.16 — too quiet on device).
  m.gain.setValueAtTime(0.0001, now);
  m.gain.exponentialRampToValueAtTime(0.42, now + 0.55);
}

function scheduleArp(audio: AudioContext, dest: AudioNode, when: number): void {
  if (stopping) return;
  const playAt = Math.max(when, audio.currentTime + 0.02);
  const freq = ARP_NOTES[arpStep % ARP_NOTES.length];
  arpStep += 1;
  playBell(audio, dest, playAt, freq);

  arpTimer = window.setTimeout(() => {
    arpTimer = null;
    if (!ctx || stopping || !master) return;
    scheduleArp(ctx, dest, ctx.currentTime);
  }, 380);
}

function playBell(audio: AudioContext, dest: AudioNode, t: number, freq: number): void {
  const osc = audio.createOscillator();
  const ping = audio.createOscillator();
  const g = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  ping.type = "triangle";
  ping.frequency.value = freq * 2.01;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  osc.connect(g);
  const pg = audio.createGain();
  pg.gain.setValueAtTime(0.0001, t);
  pg.gain.exponentialRampToValueAtTime(0.08, t + 0.012);
  pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  ping.connect(pg);
  g.connect(dest);
  pg.connect(dest);
  osc.start(t);
  ping.start(t);
  osc.stop(t + 0.6);
  ping.stop(t + 0.28);
}
