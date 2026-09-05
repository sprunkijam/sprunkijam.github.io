import type { SlotId } from "../types";

/** Unique pad notes — original Web Audio only, no samples. */
const PAD_TONES: Record<SlotId, { a: number; b: number; c: number }> = {
  tl: { a: 523.25, b: 659.25, c: 783.99 },
  tr: { a: 587.33, b: 739.99, c: 880.0 },
  left: { a: 659.25, b: 830.61, c: 987.77 },
  mid: { a: 783.99, b: 987.77, c: 1174.66 },
  right: { a: 880.0, b: 1108.73, c: 1318.51 },
};

const WAVES: OscillatorType[] = ["triangle", "sine", "square", "sawtooth"];

function autoRelease(sources: AudioScheduledSourceNode[], extras: AudioNode[]): void {
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
  for (const s of sources) s.addEventListener("ended", release);
}

/**
 * Satisfying hit that changes with pad + streak so repeats never drone.
 * Kind rotates: chime stack, blip, cowbell ping, sparkle, clap-tick.
 */
export function playSecretHit(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  slot: SlotId,
  streak: number,
  noise: AudioBuffer,
): void {
  const tone = PAD_TONES[slot];
  const kind = ((streak - 1) % 5 + 5) % 5;
  const lift = 1 + Math.min(0.18, streak * 0.012);
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.exponentialRampToValueAtTime(0.62, t + 0.008);
  master.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  master.connect(dest);

  const sources: AudioScheduledSourceNode[] = [];
  const extras: AudioNode[] = [master];

  if (kind === 0) {
    // Bright major chime.
    for (const [i, freq] of [tone.a * lift, tone.b * lift, tone.c * lift].entries()) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const start = t + i * 0.028;
      osc.type = i === 2 ? "sine" : "triangle";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.28 - i * 0.05, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(g).connect(master);
      osc.start(start);
      osc.stop(start + 0.24);
      sources.push(osc);
      extras.push(g);
    }
  } else if (kind === 1) {
    // Tight square blip + sine body.
    const click = ctx.createOscillator();
    const cg = ctx.createGain();
    click.type = "square";
    click.frequency.value = tone.b * lift;
    cg.gain.setValueAtTime(0.28, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    click.connect(cg).connect(master);
    click.start(t);
    click.stop(t + 0.05);
    sources.push(click);
    extras.push(cg);

    const body = ctx.createOscillator();
    const bg = ctx.createGain();
    body.type = "sine";
    body.frequency.setValueAtTime(tone.a * lift, t);
    body.frequency.exponentialRampToValueAtTime(tone.a * lift * 0.72, t + 0.14);
    bg.gain.setValueAtTime(0.34, t);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    body.connect(bg).connect(master);
    body.start(t);
    body.stop(t + 0.18);
    sources.push(body);
    extras.push(bg);
  } else if (kind === 2) {
    // Metallic ping (two close square partials).
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = tone.a * lift;
    bp.Q.value = 4.2;
    bp.connect(master);
    extras.push(bp);
    for (const f of [tone.a * lift, tone.a * lift * 1.34]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.16, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(g).connect(bp);
      osc.start(t);
      osc.stop(t + 0.22);
      sources.push(osc);
      extras.push(g);
    }
  } else if (kind === 3) {
    // Ice sparkle.
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 700;
    osc.type = WAVES[streak % WAVES.length] === "sawtooth" ? "triangle" : "sine";
    osc.frequency.value = tone.c * lift;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(hp).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.22);
    sources.push(osc);
    extras.push(g, hp);

    const ping = ctx.createOscillator();
    const pg = ctx.createGain();
    ping.type = "triangle";
    ping.frequency.value = tone.c * lift * 2.01;
    pg.gain.setValueAtTime(0.16, t);
    pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    ping.connect(pg).connect(master);
    ping.start(t);
    ping.stop(t + 0.12);
    sources.push(ping);
    extras.push(pg);
  } else {
    // Soft clap-tick (noise) under a triangle.
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1600;
    bp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.28, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    src.connect(bp).connect(ng).connect(master);
    src.start(t);
    src.stop(t + 0.1);
    sources.push(src);
    extras.push(bp, ng);

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = tone.b * lift;
    g.gain.setValueAtTime(0.24, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.16);
    sources.push(osc);
    extras.push(g);
  }

  autoRelease(sources, extras);
}

/**
 * Short chord when the last pad of a 2–4 set is cleared.
 * Stacks each pad's fundamental so the flourish matches the tiles just hit.
 */
export function playSecretClear(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  slots: readonly SlotId[],
): void {
  if (slots.length < 2) return;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.exponentialRampToValueAtTime(0.58, t + 0.012);
  master.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  master.connect(dest);

  const sources: AudioScheduledSourceNode[] = [];
  const extras: AudioNode[] = [master];

  for (const [i, slot] of slots.entries()) {
    const tone = PAD_TONES[slot];
    const start = t + i * 0.018;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = i % 2 === 0 ? "triangle" : "sine";
    osc.frequency.value = tone.a;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.22, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
    osc.connect(g).connect(master);
    osc.start(start);
    osc.stop(start + 0.3);
    sources.push(osc);
    extras.push(g);

    const sparkle = ctx.createOscillator();
    const sg = ctx.createGain();
    sparkle.type = "sine";
    sparkle.frequency.value = tone.c;
    sg.gain.setValueAtTime(0.0001, start + 0.02);
    sg.gain.exponentialRampToValueAtTime(0.12, start + 0.03);
    sg.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    sparkle.connect(sg).connect(master);
    sparkle.start(start + 0.02);
    sparkle.stop(start + 0.2);
    sources.push(sparkle);
    extras.push(sg);
  }

  autoRelease(sources, extras);
}

/** Short cartoon fail — not a scare stinger. */
export function playSecretMiss(ctx: AudioContext, dest: AudioNode, t: number, noise: AudioBuffer): void {
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.exponentialRampToValueAtTime(0.42, t + 0.01);
  master.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  master.connect(dest);

  const sources: AudioScheduledSourceNode[] = [];
  const extras: AudioNode[] = [master];

  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(196, t);
  osc.frequency.exponentialRampToValueAtTime(98, t + 0.18);
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + 0.24);
  sources.push(osc);
  extras.push(g);

  const osc2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(147, t + 0.03);
  osc2.frequency.exponentialRampToValueAtTime(73, t + 0.2);
  g2.gain.setValueAtTime(0.2, t + 0.03);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  osc2.connect(g2).connect(master);
  osc2.start(t + 0.03);
  osc2.stop(t + 0.26);
  sources.push(osc2);
  extras.push(g2);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 420;
  bp.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.16, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  src.connect(bp).connect(ng).connect(master);
  src.start(t);
  src.stop(t + 0.14);
  sources.push(src);
  extras.push(bp, ng);

  autoRelease(sources, extras);
}
