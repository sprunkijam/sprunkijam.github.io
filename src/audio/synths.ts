export function makeDistortionCurve(amount: number): Float32Array {
  const n = 441;
  const curve = new Float32Array(n);
  const k = 1 + amount * 18;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(x * k);
  }
  return curve;
}

export function noiseBuffer(ctx: AudioContext, seconds = 1): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export function impulseBuffer(ctx: AudioContext, seconds = 1.2, decay = 3): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
    }
  }
  return buf;
}

function envGain(ctx: AudioContext, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

/**
 * iOS WebKit keeps stopped oscillators in the graph until disconnect().
 * A full 10-friend mix schedules many nodes every step; without this, a
 * minute at phase 1000/100000 can exhaust createOscillator (often silently).
 */
function autoRelease(sources: AudioScheduledSourceNode[], extras: AudioNode[] = []): void {
  let left = sources.length;
  if (left <= 0) return;
  const release = (): void => {
    left -= 1;
    if (left > 0) return;
    for (const n of extras) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    for (const s of sources) {
      try {
        s.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  };
  for (const s of sources) {
    s.addEventListener("ended", release);
  }
}

export function playKick(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  opts: { pitch: number; end: number; decay: number; punch: number; slam: boolean },
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(opts.pitch, t);
  osc.frequency.exponentialRampToValueAtTime(opts.end, t + 0.07);
  gain.gain.setValueAtTime(opts.punch, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.decay);
  osc.connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + opts.decay + 0.02);

  const click = ctx.createOscillator();
  const cg = ctx.createGain();
  click.type = "square";
  click.frequency.value = 1400;
  cg.gain.setValueAtTime(opts.punch * 0.12, t);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
  click.connect(cg).connect(dest);
  click.start(t);
  click.stop(t + 0.03);

  const sources: AudioScheduledSourceNode[] = [osc, click];
  const extras: AudioNode[] = [gain, cg];
  if (opts.slam) {
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(opts.pitch * 0.82, t + 0.11);
    osc2.frequency.exponentialRampToValueAtTime(opts.end * 0.85, t + 0.2);
    g2.gain.setValueAtTime(opts.punch * 0.92, t + 0.11);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.11 + opts.decay * 0.9);
    osc2.connect(g2).connect(dest);
    osc2.start(t + 0.11);
    osc2.stop(t + 0.11 + opts.decay);
    sources.push(osc2);
    extras.push(g2);
  }
  autoRelease(sources, extras);
}

export function playShaker(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  noise: AudioBuffer,
  opts: { cutoff: number; decay: number; gain: number; metal: number },
): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = opts.cutoff;
  bp.Q.value = 1.6 + opts.metal * 4;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1800 + opts.metal * 2200;
  const g = envGain(ctx, t, opts.gain, 0.002, opts.decay);
  src.connect(hp).connect(bp).connect(g).connect(dest);
  src.start(t);
  src.stop(t + opts.decay + 0.03);
  autoRelease([src], [hp, bp, g]);
}

export function playChorus(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  opts: {
    freq: number;
    dur: number;
    gain: number;
    whisper: number;
    minor: boolean;
    detune: number;
    noise: AudioBuffer;
  },
): void {
  const voice = ctx.createGain();
  voice.gain.setValueAtTime(0.0001, t);
  voice.gain.exponentialRampToValueAtTime(opts.gain, t + 0.04);
  voice.gain.exponentialRampToValueAtTime(opts.gain * 0.7, t + opts.dur * 0.5);
  voice.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);

  const f1 = ctx.createBiquadFilter();
  f1.type = "bandpass";
  f1.frequency.value = opts.whisper > 0.5 ? 920 : 760;
  f1.Q.value = 6;
  const f2 = ctx.createBiquadFilter();
  f2.type = "bandpass";
  f2.frequency.value = opts.whisper > 0.5 ? 1640 : 1280;
  f2.Q.value = 5;

  const mix = ctx.createGain();
  mix.gain.value = 1;
  mix.connect(f1).connect(voice);
  mix.connect(f2).connect(voice);
  voice.connect(dest);

  const freqs = [opts.freq, opts.freq * 1.995, opts.freq * 0.501];
  const sources: AudioScheduledSourceNode[] = [];
  const extras: AudioNode[] = [voice, f1, f2, mix];
  freqs.forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = i === 2 ? "triangle" : "sawtooth";
    osc.frequency.value = f;
    osc.detune.value = (i - 1) * (7 + opts.detune * 40);
    const g = ctx.createGain();
    g.gain.value = i === 0 ? 0.22 : 0.1;
    osc.connect(g).connect(mix);
    osc.start(t);
    osc.stop(t + opts.dur + 0.02);
    sources.push(osc);
    extras.push(g);
  });

  if (opts.whisper > 0.15) {
    const src = ctx.createBufferSource();
    src.buffer = opts.noise;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(opts.whisper * 0.18, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 2.2;
    src.connect(bp).connect(ng).connect(dest);
    src.start(t);
    src.stop(t + opts.dur + 0.02);
    sources.push(src);
    extras.push(ng, bp);
  }
  autoRelease(sources, extras);
}

export function playClap(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  noise: AudioBuffer,
  gain: number,
): void {
  const sources: AudioScheduledSourceNode[] = [];
  const extras: AudioNode[] = [];
  for (const delay of [0, 0.012, 0.023, 0.041]) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1400;
    bp.Q.value = 1.1;
    const g = envGain(ctx, t + delay, gain * (delay === 0 ? 1 : 0.55), 0.001, 0.09);
    src.connect(bp).connect(g).connect(dest);
    src.start(t + delay);
    src.stop(t + delay + 0.12);
    sources.push(src);
    extras.push(bp, g);
  }
  autoRelease(sources, extras);
}

export function playCowbell(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  opts: { gain: number; detune: number; decay: number },
): void {
  const freqs = [640 * (1 + opts.detune * 0.08), 862 * (1 - opts.detune * 0.05)];
  const g = envGain(ctx, t, opts.gain, 0.001, opts.decay);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 720;
  bp.Q.value = 3.5;
  bp.connect(g).connect(dest);
  const sources: AudioScheduledSourceNode[] = [];
  const extras: AudioNode[] = [g, bp];
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = f;
    const og = ctx.createGain();
    og.gain.value = 0.18;
    osc.connect(og).connect(bp);
    osc.start(t);
    osc.stop(t + opts.decay + 0.02);
    sources.push(osc);
    extras.push(og);
  }
  autoRelease(sources, extras);
}

export function playBass(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  opts: { freq: number; gain: number; decay: number; growl: number },
): void {
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(opts.freq, t);
  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.value = opts.freq * 0.5;
  const g = envGain(ctx, t, opts.gain, 0.008, opts.decay);
  const sg = ctx.createGain();
  sg.gain.value = 0.45;
  osc.connect(g).connect(dest);
  sub.connect(sg).connect(g);
  osc.start(t);
  sub.start(t);
  osc.stop(t + opts.decay + 0.02);
  sub.stop(t + opts.decay + 0.02);
  const sources: AudioScheduledSourceNode[] = [osc, sub];
  const extras: AudioNode[] = [g, sg];

  if (opts.growl > 0.2) {
    const f = ctx.createOscillator();
    f.type = "sawtooth";
    f.frequency.value = opts.freq * 0.99;
    const fg = envGain(ctx, t, opts.gain * 0.22 * opts.growl, 0.01, opts.decay * 0.8);
    f.connect(fg).connect(dest);
    f.start(t);
    f.stop(t + opts.decay);
    sources.push(f);
    extras.push(fg);
  }
  autoRelease(sources, extras);
}

export function playSparkle(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  opts: { freq: number; gain: number; ice: number },
): void {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = opts.freq;
  const g = envGain(ctx, t, opts.gain, 0.004, 0.18 + opts.ice * 0.08);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 600;
  osc.connect(hp).connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.28);

  const ping = ctx.createOscillator();
  ping.type = "triangle";
  ping.frequency.value = opts.freq * 2.01;
  const pg = envGain(ctx, t, opts.gain * 0.35, 0.002, 0.1);
  ping.connect(pg).connect(dest);
  ping.start(t);
  ping.stop(t + 0.14);
  autoRelease([osc, ping], [hp, g, pg]);
}

export function playStinger(ctx: AudioContext, dest: AudioNode, t: number, noise: AudioBuffer): void {
  const sources: AudioScheduledSourceNode[] = [];
  const extras: AudioNode[] = [];

  const boom = ctx.createOscillator();
  boom.type = "sine";
  boom.frequency.setValueAtTime(90, t);
  boom.frequency.exponentialRampToValueAtTime(28, t + 0.45);
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(1.15, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  boom.connect(bg).connect(dest);
  boom.start(t);
  boom.stop(t + 0.72);
  sources.push(boom);
  extras.push(bg);

  const stabFreqs = [155, 196, 233, 311];
  for (const f of stabFreqs) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.72, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + 0.45);
    sources.push(osc);
    extras.push(g);
  }

  const scream = ctx.createOscillator();
  scream.type = "sawtooth";
  scream.frequency.setValueAtTime(1860, t);
  scream.frequency.exponentialRampToValueAtTime(420, t + 0.55);
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(0.2, t);
  sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1400;
  bp.Q.value = 4;
  scream.connect(bp).connect(sg).connect(dest);
  scream.start(t);
  scream.stop(t + 0.62);
  sources.push(scream);
  extras.push(sg, bp);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.55, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 900;
  src.connect(hp).connect(ng).connect(dest);
  src.start(t);
  src.stop(t + 0.85);
  sources.push(src);
  extras.push(ng, hp);
  autoRelease(sources, extras);
}

export function playWhoosh(ctx: AudioContext, dest: AudioNode, t: number, noise: AudioBuffer, reverse: boolean): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.4;
  if (reverse) {
    bp.frequency.setValueAtTime(280, t);
    bp.frequency.exponentialRampToValueAtTime(4200, t + 0.55);
  } else {
    bp.frequency.setValueAtTime(3800, t);
    bp.frequency.exponentialRampToValueAtTime(220, t + 0.7);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.28, t + 0.12);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.72);
  src.connect(bp).connect(g).connect(dest);
  src.start(t);
  src.stop(t + 0.75);
  autoRelease([src], [bp, g]);
}

export type PhaseCueKind =
  | "meadow-to-dusk"
  | "dusk-to-horror"
  | "horror-to-forest"
  | "forest-to-cosmic"
  | "cosmic-to-vortex"
  | "vortex-intensify"
  | "reverse-unwind";

/**
 * Layered cartoon-horror riser + impact for cinematic phase hops.
 * Does not silence the jam — call alongside a mild duck if desired.
 */
export function playPhaseTransitionCue(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  noise: AudioBuffer,
  kind: PhaseCueKind,
  opts: { compressed?: boolean; reverse?: boolean } = {},
): void {
  const compressed = Boolean(opts.compressed);
  const reverse = Boolean(opts.reverse) || kind === "reverse-unwind";
  const dur = compressed ? 0.85 : reverse ? 0.75 : kind === "vortex-intensify" ? 1.35 : kind === "cosmic-to-vortex" ? 1.25 : 1.0;

  // Soft riser (noise sweep) — chill for dusk, harsh for later.
  {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = reverse ? 1.2 : kind === "meadow-to-dusk" ? 1.6 : 2.4;
    const f0 = reverse ? 220 : kind === "meadow-to-dusk" ? 600 : 400;
    const f1 = reverse ? 3200 : kind === "meadow-to-dusk" ? 180 : kind === "vortex-intensify" ? 90 : 140;
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur * 0.7);
    const g = ctx.createGain();
    const peak = kind === "meadow-to-dusk" ? 0.14 : kind === "vortex-intensify" ? 0.32 : 0.22;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(dest);
    src.start(t);
    src.stop(t + dur + 0.02);
    autoRelease([src], [bp, g]);
  }

  // Rumble bed
  if (kind !== "reverse-unwind") {
    const boom = ctx.createOscillator();
    boom.type = "sine";
    const low = kind === "meadow-to-dusk" ? 70 : kind === "vortex-intensify" ? 40 : 55;
    boom.frequency.setValueAtTime(low * 1.4, t);
    boom.frequency.exponentialRampToValueAtTime(low, t + dur * 0.8);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(kind === "meadow-to-dusk" ? 0.22 : 0.45, t + 0.08);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    boom.connect(bg).connect(dest);
    boom.start(t);
    boom.stop(t + dur + 0.02);
    autoRelease([boom], [bg]);
  }

  // Scare-beat impact (~mid cue)
  const hit = t + dur * (kind === "vortex-intensify" ? 0.38 : 0.48);
  playStinger(ctx, dest, hit, noise);

  // Whisper chorus (filtered noise pulses) for forest+
  if (
    kind === "horror-to-forest" ||
    kind === "forest-to-cosmic" ||
    kind === "cosmic-to-vortex" ||
    kind === "vortex-intensify"
  ) {
    for (let i = 0; i < 3; i++) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 900 + i * 400;
      bp.Q.value = 6;
      const g = ctx.createGain();
      const tt = t + 0.12 + i * 0.18;
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.1, tt + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.28);
      src.connect(bp).connect(g).connect(dest);
      src.start(tt);
      src.stop(tt + 0.3);
      autoRelease([src], [bp, g]);
    }
  }

  // Gravity lurch / glitch blips for cosmic+
  if (kind === "forest-to-cosmic" || kind === "cosmic-to-vortex" || kind === "vortex-intensify") {
    for (let i = 0; i < (kind === "vortex-intensify" ? 5 : 3); i++) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      const tt = hit + 0.02 + i * 0.05;
      osc.frequency.setValueAtTime(180 + i * 90, tt);
      osc.frequency.exponentialRampToValueAtTime(60, tt + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12, tt);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.14);
      osc.connect(g).connect(dest);
      osc.start(tt);
      osc.stop(tt + 0.15);
      autoRelease([osc], [g]);
    }
  }

  // Soft reverse chime unwind
  if (reverse) {
    playWhoosh(ctx, dest, t, noise, true);
    const bell = ctx.createOscillator();
    bell.type = "sine";
    bell.frequency.setValueAtTime(520, t + 0.2);
    bell.frequency.exponentialRampToValueAtTime(780, t + 0.55);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.28);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    bell.connect(g).connect(dest);
    bell.start(t + 0.2);
    bell.stop(t + 0.72);
    autoRelease([bell], [g]);
  }
}
