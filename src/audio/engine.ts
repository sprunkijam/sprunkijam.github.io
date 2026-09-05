import type { Phase, SlotId, StemId } from "../types";
import { bpmForPhase, mutationForPhase } from "../types";
import {
  playSecretClear as synthSecretClear,
  playSecretHit as synthSecretHit,
  playSecretMiss as synthSecretMiss,
} from "./secretHits";
import {
  impulseBuffer,
  makeDistortionCurve,
  noiseBuffer,
  playBass,
  playChorus,
  playClap,
  playCowbell,
  playKick,
  playPhaseTransitionCue,
  playShaker,
  playSparkle,
  playStinger,
  playWhoosh,
  type PhaseCueKind,
} from "./synths";
import {
  createAudioContext,
  kickAudioUnlock,
  kickResumeContext,
  kickUnlockHtmlAudio,
  watchAudioResume,
} from "./unlock";

const STEPS = 16;

const MAJOR = [261.63, 329.63, 392.0, 523.25, 659.25, 783.99];
const MINOR = [246.94, 293.66, 349.23, 415.3, 493.88, 587.33];
const SPARK_MAJ = [1046.5, 1318.5, 1568.0, 2093.0];
const SPARK_MIN = [987.77, 1174.7, 1396.9, 1661.2];
const BASS_MAJ = [65.41, 82.41, 98.0, 130.81];
const BASS_MIN = [61.74, 73.42, 92.5, 123.47];

export interface EnginePulse {
  step: number;
  beat: number;
  bar: number;
  intensity: Record<StemId, number>;
}

function ctxSuspended(ctx: AudioContext): boolean {
  const state = ctx.state as string;
  return state === "suspended" || state === "interrupted";
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private duck!: GainNode;
  private dark!: BiquadFilterNode;
  private drive!: WaveShaperNode;
  private bus!: GainNode;
  private verb!: ConvolverNode;
  private verbGain!: GainNode;
  private noise!: AudioBuffer;
  private startedAt = 0;
  private bpm = 110;
  private mutation = 0;
  private nextStep = 0;
  private placed = new Set<StemId>();
  private pad: { osc: OscillatorNode[]; gain: GainNode } | null = null;
  /** Place acks + phase stingers — bypasses duck so a stuck mix gain cannot mute them. */
  private cue!: GainNode;
  private duckRestoreTimer: number | null = null;
  private unlockKicked = false;
  private looping = false;
  pulse: EnginePulse = {
    step: 0,
    beat: 0,
    bar: 0,
    intensity: {
      oren: 0,
      pinki: 0,
      vineria: 0,
      black: 0,
      jevin: 0,
      red: 0,
      purple: 0,
      green: 0,
      orange: 0,
      blue: 0,
    },
  };

  /**
   * Unlock Web Audio in this user-gesture turn. Must not await — iOS WebKit
   * drops the gesture after a microtask, and a hung AudioContext.resume()
   * must never block entering the game.
   */
  unlock(): void {
    try {
      kickUnlockHtmlAudio(true);
      if (!this.ctx) this.build();
      const ctx = this.ctx;
      if (!ctx) return;
      kickResumeContext(ctx);
      if (!this.unlockKicked) {
        watchAudioResume(ctx, {
          onRunning: () => {
            if (this.looping) this.realign();
          },
          onResume: () => {
            this.restoreMixGain();
            if (this.looping) this.realign();
          },
        });
        this.unlockKicked = true;
      }
      this.restoreMixGain();
      if (!this.looping) {
        this.looping = true;
        this.startedAt = ctx.currentTime + 0.06;
        this.nextStep = 0;
        this.loop();
      } else if (!ctxSuspended(ctx)) {
        this.realign();
      }
    } catch (err) {
      console.error(err);
    }
  }

  private build(): void {
    const ctx = createAudioContext();
    this.ctx = ctx;
    this.noise = noiseBuffer(ctx, 1.4);

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.dark = ctx.createBiquadFilter();
    this.dark.type = "lowpass";
    this.dark.frequency.value = 18000;
    this.dark.Q.value = 0.7;
    this.drive = ctx.createWaveShaper();
    this.drive.curve = makeDistortionCurve(0) as unknown as Float32Array<ArrayBuffer>;
    // WebKit 2x oversample is a CPU/silence footgun on iPhone Edge; distortion still works.
    this.drive.oversample = "none";
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 42;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -12;
    limit.knee.value = 10;
    limit.ratio.value = 8;
    limit.attack.value = 0.004;
    limit.release.value = 0.18;
    const safety = ctx.createWaveShaper();
    safety.curve = makeDistortionCurve(0.15) as unknown as Float32Array<ArrayBuffer>;
    safety.oversample = "none";

    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    this.verb = ctx.createConvolver();
    this.verb.buffer = impulseBuffer(ctx, 1.15, 3.2);
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.18;
    this.cue = ctx.createGain();
    this.cue.gain.value = 1;

    this.bus.connect(this.drive);
    this.drive.connect(this.dark);
    this.dark.connect(this.duck);
    this.duck.connect(hp);
    hp.connect(limit);
    limit.connect(safety);
    safety.connect(this.master);
    this.master.connect(ctx.destination);

    this.bus.connect(this.verb);
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.duck);
    // Cues skip the duck so a Safari AudioParam glitch cannot mute place-acks / stingers.
    this.cue.connect(this.master);

    // Keep the destination graph pulling so iOS is less likely to idle the session.
    try {
      const keep = ctx.createBufferSource();
      keep.buffer = ctx.createBuffer(1, Math.max(1, ctx.sampleRate), ctx.sampleRate);
      keep.loop = true;
      const kg = ctx.createGain();
      kg.gain.value = 0.00001;
      keep.connect(kg).connect(ctx.destination);
      keep.start();
    } catch {
      /* ignore */
    }
  }

  setPhase(phase: Phase): void {
    this.bpm = bpmForPhase(phase);
    this.mutation = mutationForPhase(phase);
    if (this.ctx) {
      this.drive.curve = makeDistortionCurve(this.mutation * 0.85) as unknown as Float32Array<ArrayBuffer>;
      this.dark.frequency.setTargetAtTime(
        this.placed.has("black") ? 2200 - this.mutation * 1400 : 16000 - this.mutation * 4000,
        this.ctx.currentTime,
        0.08,
      );
      this.verbGain.gain.setTargetAtTime(0.14 + this.mutation * 0.16, this.ctx.currentTime, 0.1);
      this.rebuildPad();
    }
    this.restoreMixGain();
    this.realign();
  }

  /**
   * Seat a stem in the mix. Re-kicks resume (place is always a user gesture)
   * and plays a loud kid-friendly ack so silence is never the first feedback.
   */
  place(id: StemId, opts: { chime?: boolean } = {}): void {
    kickAudioUnlock(this.ctx);
    this.placed.add(id);
    if (id === "black") this.rebuildPad();
    if (this.ctx) {
      this.dark.frequency.setTargetAtTime(
        this.placed.has("black") ? 2200 - this.mutation * 1400 : 16000 - this.mutation * 4000,
        this.ctx.currentTime,
        0.06,
      );
      if (!ctxSuspended(this.ctx)) this.realign();
      this.restoreMixGain();
      if (opts.chime !== false) this.playPlaceAck();
    }
  }

  remove(id: StemId): void {
    this.placed.delete(id);
    if (id === "black") this.killPad();
    if (this.ctx) {
      this.dark.frequency.setTargetAtTime(16000 - this.mutation * 4000, this.ctx.currentTime, 0.08);
    }
  }

  /** Seated stems are always in the mix — no mute/solo tap cycle. */
  isAudible(id: StemId): boolean {
    return this.placed.has(id);
  }

  silence(on: boolean): void {
    if (!this.ctx) return;
    if (on) {
      this.setDuckGain(0.0001, this.ctx.currentTime);
      this.killPad();
    } else {
      this.restoreMixGain();
      this.rebuildPad();
    }
  }

  scareStinger(): void {
    if (!this.ctx) return;
    playStinger(this.ctx, this.cue, this.ctx.currentTime + 0.02, this.noise);
  }

  /** Reflex-mode hit — unique per pad + streak, bypasses the mix duck. */
  playSecretHit(slot: SlotId, streak: number): void {
    const ctx = this.ctx;
    if (!ctx || ctxSuspended(ctx) || !this.cue || !this.noise) return;
    synthSecretHit(ctx, this.cue, ctx.currentTime + 0.005, slot, streak, this.noise);
  }

  playSecretMiss(): void {
    const ctx = this.ctx;
    if (!ctx || ctxSuspended(ctx) || !this.cue || !this.noise) return;
    synthSecretMiss(ctx, this.cue, ctx.currentTime + 0.005, this.noise);
  }

  /** Chord when a 2–4 pad set is fully cleared. */
  playSecretClear(slots: readonly SlotId[]): void {
    const ctx = this.ctx;
    if (!ctx || ctxSuspended(ctx) || !this.cue || slots.length < 2) return;
    synthSecretClear(ctx, this.cue, ctx.currentTime + 0.03, slots);
  }

  whoosh(reverse: boolean): void {
    if (!this.ctx) return;
    playWhoosh(this.ctx, this.cue, this.ctx.currentTime + 0.01, this.noise, reverse);
  }

  /**
   * Cinematic phase-hop cue layered over the running jam (no full silence).
   * Mild duck around the impact so the sting reads without freezing the loop.
   *
   * Safari/iOS: never read duck.gain.value mid-automation. cancelScheduledValues
   * + reading .value during a ramp is a known WebKit footgun that can leave the
   * duck stuck near 0 (place acks share the same bus, so the whole mix goes silent).
   */
  phaseTransitionCue(kind: PhaseCueKind, opts: { compressed?: boolean; reverse?: boolean } = {}): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const t = now + 0.01;
    playPhaseTransitionCue(this.ctx, this.cue, t, this.noise, kind, opts);
    // Known constants only — start from 1, duck to 0.4, always land on 1.
    this.setDuckGain(1, now);
    this.duck.gain.setValueAtTime(0.4, t);
    this.duck.gain.linearRampToValueAtTime(1, t + 0.85);
    this.duck.gain.setValueAtTime(1, t + 0.86);
    this.armDuckRestore(900);
  }

  /** Current mix duck (1 = full). Test / diagnostics — do not use for scheduling. */
  mixGain(): number {
    if (!this.duck) return 1;
    const v = this.duck.gain.value;
    return Number.isFinite(v) ? v : 0;
  }

  /** Snap the mix duck to 1. Used after cues, place(), setPhase, unlock, reset. */
  restoreMixGain(): void {
    if (!this.ctx || !this.duck) return;
    this.setDuckGain(1, this.ctx.currentTime);
  }

  /**
   * Safari-safe AudioParam write: never read .value during a ramp.
   * cancelAndHoldAtTime is the WebKit-friendly cancel; fall back to cancelScheduledValues.
   */
  private setDuckGain(value: number, when: number): void {
    const param = this.duck.gain;
    try {
      param.cancelAndHoldAtTime(when);
    } catch {
      try {
        param.cancelScheduledValues(when);
      } catch {
        /* ignore */
      }
    }
    try {
      param.setValueAtTime(value, when);
    } catch {
      try {
        param.value = value;
      } catch {
        /* ignore */
      }
    }
  }

  private armDuckRestore(delayMs: number): void {
    if (this.duckRestoreTimer != null) window.clearTimeout(this.duckRestoreTimer);
    this.duckRestoreTimer = window.setTimeout(() => {
      this.duckRestoreTimer = null;
      this.restoreMixGain();
    }, delayMs);
  }

  /** Immediate audible success click/chime when a kid seats a Sprunki. */
  playPlaceAck(): void {
    const ctx = this.ctx;
    if (!ctx || ctxSuspended(ctx)) return;
    const t = ctx.currentTime + 0.01;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(0.55, t + 0.012);
    master.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    master.connect(this.cue);

    const sources: AudioScheduledSourceNode[] = [];
    const extras: AudioNode[] = [master];

    const click = ctx.createOscillator();
    const cg = ctx.createGain();
    click.type = "square";
    click.frequency.value = 880;
    cg.gain.setValueAtTime(0.35, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    click.connect(cg).connect(master);
    click.start(t);
    click.stop(t + 0.05);
    sources.push(click);
    extras.push(cg);

    for (const [i, freq] of [523.25, 659.25, 783.99].entries()) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const start = t + 0.02 + i * 0.045;
      osc.type = "triangle";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.28 - i * 0.04, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(g).connect(master);
      osc.start(start);
      osc.stop(start + 0.25);
      sources.push(osc);
      extras.push(g);
    }

    let left = sources.length;
    const release = (): void => {
      left -= 1;
      if (left > 0) return;
      for (const n of extras) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      for (const s of sources) {
        try {
          s.disconnect();
        } catch {
          /* ignore */
        }
      }
    };
    for (const s of sources) s.addEventListener("ended", release);
  }

  private realign(): void {
    if (!this.ctx) return;
    const stepDur = 60 / this.bpm / 4;
    const now = this.ctx.currentTime;
    const elapsed = Math.max(0, now - this.startedAt);
    this.nextStep = Math.ceil(elapsed / stepDur);
  }

  private loop = (): void => {
    try {
      if (!this.ctx || !this.looping) return;
      const ctx = this.ctx;
      // While suspended, currentTime is frozen — do not advance nextStep into the void.
      if (ctxSuspended(ctx)) return;
      const stepDur = 60 / this.bpm / 4;
      const horizon = ctx.currentTime + 0.18;
      while (this.startedAt + this.nextStep * stepDur < horizon) {
        const t = this.startedAt + this.nextStep * stepDur;
        const step = ((this.nextStep % STEPS) + STEPS) % STEPS;
        try {
          this.schedule(step, t);
        } catch {
          // iOS can throw (or fail silently) once the node cap is hit — keep the clock moving.
        }
        this.nextStep += 1;
      }
      const elapsed = Math.max(0, ctx.currentTime - this.startedAt);
      const stepFloat = elapsed / stepDur;
      this.pulse.step = ((stepFloat % STEPS) + STEPS) % STEPS;
      this.pulse.beat = (stepFloat / 4) % 1;
      this.pulse.bar = (stepFloat / STEPS) % 1;
      for (const id of Object.keys(this.pulse.intensity) as StemId[]) {
        this.pulse.intensity[id] *= 0.86;
      }
    } catch (err) {
      console.error(err);
    } finally {
      if (this.looping && this.ctx) {
        const wait = ctxSuspended(this.ctx) ? 50 : 25;
        window.setTimeout(this.loop, wait);
      }
    }
  };

  private schedule(step: number, t: number): void {
    const m = this.mutation;
    const rng = mulberry((step + 1) * 977 + Math.floor(m * 1000));
    const chaos = m > 0.5 && rng() < m * 0.35;
    const extra = m > 0.75 && rng() < m * 0.4;

    if (this.isAudible("oren") && shouldHit([0, 4, 8, 12, m > 0.25 ? 14 : -1], step, extra, rng)) {
      playKick(this.ctx!, this.bus, t, {
        pitch: m > 0.2 ? 118 - m * 40 : 168,
        end: m > 0.2 ? 34 : 48,
        decay: 0.28 + m * 0.18,
        punch: 0.95,
        slam: m > 0.2,
      });
      this.pulse.intensity.oren = 1;
    }

    if (this.isAudible("vineria")) {
      const pattern = m > 0.4 ? [0, 1, 2, 3, 5, 6, 8, 9, 10, 11, 13, 14, 15] : [1, 3, 5, 7, 9, 11, 13, 15];
      if (shouldHit(pattern, step, extra, rng) || chaos) {
        playShaker(this.ctx!, this.bus, t, this.noise, {
          cutoff: 4200 + (step % 4) * 400 - m * 800,
          decay: 0.045 + (chaos ? 0.08 : 0),
          gain: 0.22 + (step % 4 === 1 ? 0.08 : 0),
          metal: m,
        });
        this.pulse.intensity.vineria = 0.85;
      }
    }

    if (this.isAudible("pinki") && shouldHit([0, 3, 6, 8, 11, 14], step, extra, rng)) {
      const scale = m > 0.15 ? MINOR : MAJOR;
      const note = scale[(step + Math.floor(m * 7)) % scale.length];
      playChorus(this.ctx!, this.bus, t, {
        freq: note * (m > 0.8 && rng() < 0.3 ? 0.5 : 1),
        dur: 0.32 + m * 0.18,
        gain: 0.22,
        whisper: m,
        minor: m > 0.15,
        detune: m,
        noise: this.noise,
      });
      this.pulse.intensity.pinki = 1;
    }

    // Rainbow Friends — reuse the old extra-loop synths (clap / sparkle / cowbell / bass).
    if (this.isAudible("red") && shouldHit([4, 12], step, extra, rng)) {
      playClap(this.ctx!, this.bus, t, this.noise, 0.42);
      this.pulse.intensity.red = 1;
    }

    if (this.isAudible("green") && shouldHit([0, 6, 10], step, extra, rng)) {
      playCowbell(this.ctx!, this.bus, t, { gain: 0.22, detune: m, decay: 0.16 + m * 0.08 });
      this.pulse.intensity.green = 1;
    }

    if (this.isAudible("blue") && shouldHit([0, 3, 8, 11], step, extra, rng)) {
      const scale = m > 0.15 ? BASS_MIN : BASS_MAJ;
      playBass(this.ctx!, this.bus, t, {
        freq: scale[step % scale.length],
        gain: 0.38,
        decay: 0.28,
        growl: m,
      });
      this.pulse.intensity.blue = 1;
    }

    if (this.isAudible("purple") && shouldHit([0, 2, 4, 6, 8, 10, 12, 14], step, extra, rng)) {
      const scale = m > 0.15 ? SPARK_MIN : SPARK_MAJ;
      playSparkle(this.ctx!, this.bus, t, {
        freq: scale[(step / 2 + Math.floor(m * 5)) % scale.length],
        gain: 0.16,
        ice: m,
      });
      this.pulse.intensity.purple = 0.8;
    }

    if (this.isAudible("orange") && shouldHit([6, 14], step, extra, rng)) {
      playKick(this.ctx!, this.bus, t, {
        pitch: 240,
        end: 90,
        decay: 0.16,
        punch: 0.55,
        slam: false,
      });
      this.pulse.intensity.orange = 0.9;
    }

    // Jevin — cool navy chill: soft minor pulses on offbeats.
    if (this.isAudible("jevin") && shouldHit([2, 6, 10, 14], step, extra, rng)) {
      const chill = m > 0.15 ? [196.0, 233.08, 293.66, 349.23] : [220.0, 261.63, 329.63, 392.0];
      playChorus(this.ctx!, this.bus, t, {
        freq: chill[(step / 2) % chill.length] * 0.5,
        dur: 0.42 + m * 0.12,
        gain: 0.16,
        whisper: 0.2 + m * 0.35,
        minor: true,
        detune: 0.35 + m * 0.4,
        noise: this.noise,
      });
      this.pulse.intensity.jevin = 0.85;
    }

    if (this.isAudible("black")) this.pulse.intensity.black = 0.55 + m * 0.4;
  }

  private rebuildPad(): void {
    this.killPad();
    if (!this.ctx || !this.isAudible("black")) return;
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.gain.exponentialRampToValueAtTime(0.16 + this.mutation * 0.08, ctx.currentTime + 0.4);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 180 + this.mutation * 40;
    bp.Q.value = 3.5;
    const oscs: OscillatorNode[] = [];
    for (const [i, f] of [55, 82.5, 110.1].entries()) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? "sine" : "triangle";
      osc.frequency.value = f * (this.mutation > 0.7 ? 0.92 : 1);
      osc.detune.value = (i - 1) * (6 + this.mutation * 36);
      osc.connect(bp);
      osc.start();
      oscs.push(osc);
    }
    bp.connect(gain).connect(this.bus);
    this.pad = { osc: oscs, gain };
  }

  private killPad(): void {
    if (!this.pad) return;
    try {
      this.pad.gain.gain.exponentialRampToValueAtTime(0.0001, (this.ctx?.currentTime ?? 0) + 0.08);
    } catch {
      /* ignore */
    }
    for (const osc of this.pad.osc) {
      try {
        osc.stop((this.ctx?.currentTime ?? 0) + 0.1);
      } catch {
        /* ignore */
      }
      osc.addEventListener("ended", () => {
        try {
          osc.disconnect();
        } catch {
          /* ignore */
        }
      });
    }
    const padGain = this.pad.gain;
    window.setTimeout(() => {
      try {
        padGain.disconnect();
      } catch {
        /* ignore */
      }
    }, 160);
    this.pad = null;
  }
}

function shouldHit(pattern: number[], step: number, extra: boolean, rng: () => number): boolean {
  if (pattern.includes(step)) return extra ? rng() > 0.15 : true;
  return extra && rng() < 0.22;
}

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
