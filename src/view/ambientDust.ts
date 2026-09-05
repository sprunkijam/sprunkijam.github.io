import { Container, Particle, ParticleContainer, Rectangle } from "pixi.js";
import type { Phase } from "../types";
import { softMoteTexture } from "./softFalloff";

interface Mote {
  p: Particle;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bob: number;
  bobSpeed: number;
  size: number;
  life: number;
  max: number;
  spin: number;
}

/**
 * Ambient translucent motes. Phase 1 is warm meadow pollen; later phases cool
 * and slow down. Count is capped so Windows WebGL stays cheap.
 * Ticker-driven — a paused Pixi ticker (resize snapshot) freezes them for free.
 *
 * Visibility hunches (Phase 1 was missing even on the first playable frame):
 * - Motes lived *under* the pad/tray world, so the bright JPEG only showed in
 *   thin gaps; they now float above the jam world (under the hop overlay).
 * - Display size was 5–14px of a 64px soft disc (~1–3px core) at α≈0.10–0.26.
 * - ParticleContainer.update() ran once *before* scale/tint/alpha were set, and
 *   never again — static GPU buffers could stay at alpha 0.
 * - Phase 1 budget was reduced (*0.78) on the photo that most needs motes.
 */
export class AmbientDust {
  root = new Container();
  private layer: ParticleContainer | null = null;
  private motes: Mote[] = [];
  private w = 100;
  private h = 100;
  private phase: Phase = 1;
  private dim = 1;
  private paused = false;
  private family = "";
  /** ParticleContainer.update() calls — idle Windows must not flush every tick. */
  private updates = 0;
  private flushTick = 0;

  constructor() {
    this.root.eventMode = "none";
    this.root.interactiveChildren = false;
    this.root.visible = true;
    this.root.alpha = 1;
  }

  setFxBudget(family = ""): void {
    this.family = family;
    this.rebuild();
  }

  setPhase(phase: Phase): void {
    this.phase = phase;
    this.recolor();
    this.applyLiveCount();
    this.flush();
  }

  /** 0–1; secret overlay dims motes so pads stay readable — never kills them. */
  setDim(dim: number): void {
    this.dim = Math.max(0, Math.min(1, dim));
    this.root.alpha = this.dim;
    this.root.visible = this.dim > 0.02;
    this.flush();
  }

  pause(paused: boolean): void {
    this.paused = paused;
  }

  resize(w: number, h: number): void {
    const grew = Math.abs(this.w - w) > 8 || Math.abs(this.h - h) > 8;
    this.w = w;
    this.h = h;
    if (this.layer) {
      this.layer.boundsArea = new Rectangle(0, 0, w, h);
    }
    if (grew) {
      for (const m of this.motes) this.resetMote(m, false);
      this.applyLiveCount();
    }
    this.flush();
  }

  testState(): {
    count: number;
    live: number;
    dim: number;
    paused: boolean;
    phase: Phase;
    visible: boolean;
    particleChildren: number;
    w: number;
    h: number;
    updates: number;
  } {
    let live = 0;
    for (const m of this.motes) if (m.p.alpha > 0.04) live += 1;
    return {
      count: this.motes.length,
      live,
      dim: this.dim,
      paused: this.paused,
      phase: this.phase,
      visible: this.root.visible && this.root.alpha > 0.02,
      particleChildren: this.layer?.particleChildren.length ?? 0,
      w: this.w,
      h: this.h,
      updates: this.updates,
    };
  }

  tick(dt: number): void {
    if (this.paused || this.dim < 0.02) return;
    const { w, h } = this;
    const live = dustBudget(this.family, this.phase);
    const peak = peakAlpha(this.phase);
    for (let i = 0; i < live; i++) {
      const m = this.motes[i];
      if (!m) continue;
      m.life += dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt + Math.sin(m.life * m.bobSpeed) * m.bob * dt;
      m.p.rotation += m.spin * dt;
      if (m.x < -40) m.x = w + 24;
      if (m.x > w + 40) m.x = -24;
      if (m.y < -40) m.y = h + 24;
      if (m.y > h + 40) m.y = -24;
      const fade = Math.sin((m.life / m.max) * Math.PI);
      m.p.x = m.x;
      m.p.y = m.y;
      m.p.alpha = peak * Math.max(0.12, fade) * this.dim;
      if (m.life > m.max) this.resetMote(m, true);
    }
    // Windows: skip every other GPU upload. Dust still moves in JS; the
    // previous buffer stays on screen for one frame. Full-rate uploads were
    // not the 3MP leak, but they add idle GPU traffic on the hot present path.
    this.flushTick += 1;
    const every = this.family === "windows" ? 2 : 1;
    if (this.flushTick % every === 0) this.flush();
  }

  private flush(): void {
    // ParticleContainer only uploads static props when update() runs. Color /
    // vertex are marked dynamic, but a missed dirty flag left motes at α=0.
    this.updates += 1;
    this.layer?.update();
  }

  private rebuild(): void {
    if (this.layer) {
      this.layer.destroy();
      this.layer = null;
    }
    this.motes = [];
    const tex = softMoteTexture();
    const n = dustBudget(this.family, 100000);
    this.layer = new ParticleContainer({
      texture: tex,
      dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
      roundPixels: false,
    });
    this.layer.eventMode = "none";
    this.layer.boundsArea = new Rectangle(0, 0, this.w, this.h);
    this.layer.blendMode = "normal";
    this.root.removeChildren();
    this.root.addChild(this.layer);

    for (let i = 0; i < n; i++) {
      const p = new Particle({
        texture: tex,
        anchorX: 0.5,
        anchorY: 0.5,
        alpha: 0,
      });
      this.layer.addParticle(p);
      const mote: Mote = {
        p,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        bob: 0,
        bobSpeed: 1,
        size: 8,
        life: 0,
        max: 1,
        spin: 0,
      };
      this.resetMote(mote, false);
      this.motes.push(mote);
    }
    this.recolor();
    this.applyLiveCount();
    this.flush();
  }

  private applyLiveCount(): void {
    const live = dustBudget(this.family, this.phase);
    for (let i = 0; i < this.motes.length; i++) {
      const m = this.motes[i]!;
      if (i >= live) {
        m.p.alpha = 0;
        m.max = 1e9;
      } else if (m.max > 1e8) {
        this.resetMote(m, false);
      }
    }
  }

  private recolor(): void {
    const tint = dustTintHex(this.phase);
    for (const m of this.motes) m.p.tint = tint;
  }

  private resetMote(m: Mote, recycle: boolean): void {
    const { w, h } = this;
    const spook = spookAmount(this.phase);
    const base = 22;
    const spread = spook > 0.5 ? 12 : 18;
    const px = base + Math.random() * spread;
    m.size = px;
    m.x = recycle && Math.random() < 0.5 ? (Math.random() < 0.5 ? -12 : w + 12) : Math.random() * w;
    m.y = recycle && Math.random() < 0.5 ? h + 12 : Math.random() * h;
    const drift = (10 + Math.random() * 18) * (1 - spook * 0.45);
    const ang = this.phase === 1 ? -0.4 + Math.random() * 0.8 : Math.random() * Math.PI * 2;
    m.vx = Math.cos(ang) * drift * (this.phase === 1 ? 1 : 0.55);
    m.vy = Math.sin(ang) * drift * 0.4 - (8 + Math.random() * 10) * (1 - spook * 0.5);
    m.bob = 4 + Math.random() * 10;
    m.bobSpeed = 0.6 + Math.random() * 1.4;
    m.max = 7 + Math.random() * (this.phase === 1 ? 10 : 16);
    // Seed mid-life so the first playable frame is not a fade-in from zero.
    m.life = recycle ? 0 : 0.2 * m.max + Math.random() * 0.55 * m.max;
    m.spin = (Math.random() - 0.5) * 0.4;
    const s = px / 128;
    m.p.scaleX = s;
    m.p.scaleY = s * (0.78 + Math.random() * 0.3);
    m.p.rotation = Math.random() * Math.PI * 2;
    m.p.tint = dustTintHex(this.phase);
    m.p.x = m.x;
    m.p.y = m.y;
    const fade = Math.sin((m.life / m.max) * Math.PI);
    m.p.alpha = recycle ? 0.08 : peakAlpha(this.phase) * Math.max(0.18, fade) * this.dim;
  }
}

function dustBudget(family: string, phase: Phase): number {
  let n = 44;
  if (family === "windows") n = Math.round(n * 0.55);
  if (phase >= 1000) n = Math.round(n * 1.18);
  return Math.max(12, Math.min(88, n));
}

function spookAmount(phase: Phase): number {
  if (phase === 1) return 0;
  if (phase === 2) return 0.28;
  if (phase === 3) return 0.46;
  if (phase === 10) return 0.62;
  if (phase === 100) return 0.78;
  return 0.92;
}

function peakAlpha(phase: Phase): number {
  const spook = spookAmount(phase);
  return 0.42 + spook * 0.1;
}

/** Hex string so Particle.tint runs Pixi's BGR path (raw RGB numbers skip it). */
function dustTintHex(phase: Phase): string {
  if (phase === 1) return "#ffe29a";
  if (phase === 2) return "#ff9a62";
  if (phase === 3) return "#c9b0e8";
  if (phase === 10) return "#8eb4d4";
  if (phase === 100) return "#7a96c8";
  if (phase === 1000) return "#6e7cc0";
  return "#5c64a8";
}
