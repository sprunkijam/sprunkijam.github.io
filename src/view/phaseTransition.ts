import { Container, Graphics, Rectangle, Sprite } from "pixi.js";
import type { Phase } from "../types";
import { PhaseRippleFilter } from "./phaseRipple";
import {
  makeSoftEyeSprite,
  makeSoftGlowSprite,
  makeSoftVignetteSprite,
  placeSoftFalloff,
  softEyeTexture,
  softGlowTexture,
} from "./softFalloff";

/** Ordered ladder used to detect forward / skip / reverse hops. */
export const PHASE_ORDER: Phase[] = [1, 2, 3, 10, 100, 1000, 100000];

export type TransitionRecipeId =
  | "meadow-to-dusk"
  | "dusk-to-horror"
  | "horror-to-forest"
  | "forest-to-cosmic"
  | "cosmic-to-vortex"
  | "vortex-intensify"
  | "reverse-unwind";

export interface TransitionHooks {
  /** 0→1 progress for revealing the prepared background photo. */
  onRevealProgress: (t: number) => void;
  /** Scare beat: swap portraits, update HUD watermark, play impact. */
  onScareBeat: () => void;
  /** Camera shake offsets in px applied to the stage world. */
  onShake: (x: number, y: number) => void;
  /** Audio cue id for the engine (recipe + compressed flag). */
  onAudio: (recipe: TransitionRecipeId, compressed: boolean, reverse: boolean) => void;
}

interface Particle {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  color: number;
  kind: "ember" | "eye" | "petal" | "spark" | "leaf" | "glitch";
}

interface Recipe {
  id: TransitionRecipeId;
  duration: number;
  scareAt: number;
  revealStart: number;
  revealEnd: number;
  shake: number;
  flash: "white" | "red" | "none";
  vignette: number;
  particleBurst: number;
}

const RECIPES: Record<Exclude<TransitionRecipeId, "reverse-unwind">, Recipe> = {
  "meadow-to-dusk": {
    id: "meadow-to-dusk",
    duration: 1.05,
    scareAt: 0.55,
    revealStart: 0.2,
    revealEnd: 0.85,
    shake: 2.5,
    flash: "none",
    vignette: 0x2a1040,
    particleBurst: 28,
  },
  "dusk-to-horror": {
    id: "dusk-to-horror",
    duration: 1.25,
    scareAt: 0.48,
    revealStart: 0.15,
    revealEnd: 0.8,
    shake: 5,
    flash: "red",
    vignette: 0x1a060c,
    particleBurst: 36,
  },
  "horror-to-forest": {
    id: "horror-to-forest",
    duration: 1.35,
    scareAt: 0.52,
    revealStart: 0.18,
    revealEnd: 0.82,
    shake: 6,
    flash: "red",
    vignette: 0x140820,
    particleBurst: 40,
  },
  "forest-to-cosmic": {
    id: "forest-to-cosmic",
    duration: 1.45,
    scareAt: 0.5,
    revealStart: 0.12,
    revealEnd: 0.78,
    shake: 8,
    flash: "white",
    vignette: 0x0a0418,
    particleBurst: 44,
  },
  "cosmic-to-vortex": {
    id: "cosmic-to-vortex",
    duration: 1.55,
    scareAt: 0.42,
    revealStart: 0.1,
    revealEnd: 0.75,
    shake: 11,
    flash: "red",
    vignette: 0x120018,
    particleBurst: 52,
  },
  "vortex-intensify": {
    id: "vortex-intensify",
    duration: 1.6,
    scareAt: 0.38,
    revealStart: 0.08,
    revealEnd: 0.7,
    shake: 14,
    flash: "red",
    vignette: 0x1a0020,
    particleBurst: 56,
  },
};

const REVERSE: Recipe = {
  id: "reverse-unwind",
  duration: 0.9,
  scareAt: 0.4,
  revealStart: 0.15,
  revealEnd: 0.85,
  shake: 2,
  flash: "white",
  vignette: 0x204060,
  particleBurst: 22,
};

const PARTICLE_POOL = 64;
const WISP_COUNT = 5;
const RING_COUNT = 4;

function phaseIndex(p: Phase): number {
  return PHASE_ORDER.indexOf(p);
}

/** Pick the cinematic recipe for a hop (destination-flavored on skips). */
export function recipeForHop(from: Phase, to: Phase): { recipe: Recipe; compressed: boolean; reverse: boolean } {
  const a = phaseIndex(from);
  const b = phaseIndex(to);
  if (b < a) {
    return { recipe: { ...REVERSE }, compressed: false, reverse: true };
  }
  const consecutive = b === a + 1;
  const destId = recipeIdForArrival(to, from);
  const base = { ...RECIPES[destId] };
  if (!consecutive && b > a + 1) {
    base.duration = Math.max(0.9, base.duration * 0.72);
    base.scareAt = Math.min(0.55, base.scareAt + 0.04);
    return { recipe: base, compressed: true, reverse: false };
  }
  return { recipe: base, compressed: false, reverse: false };
}

function recipeIdForArrival(to: Phase, from: Phase): Exclude<TransitionRecipeId, "reverse-unwind"> {
  if (to === 2) return "meadow-to-dusk";
  if (to === 3) return "dusk-to-horror";
  if (to === 10) return "horror-to-forest";
  if (to === 100) return "forest-to-cosmic";
  if (to === 1000) return "cosmic-to-vortex";
  if (to === 100000) {
    return from === 1000 ? "vortex-intensify" : "cosmic-to-vortex";
  }
  return "meadow-to-dusk";
}

/**
 * Full-screen Pixi cinematic overlay for in-game phase changes.
 * Organic radial blooms / wisps / shockwaves, plus one full-stage dark scrim
 * so the hop never leaves right/bottom strips uncovered. WebGL attaches one
 * custom ripple+bloom Filter (GLSL) with filterArea pinned to the stage.
 * Never a full-stage filter on the jam world.
 */
export class PhaseTransition {
  root = new Container();
  private bloom = new Container();
  private glowBlob = makeSoftGlowSprite();
  private glowAccent = makeSoftGlowSprite();
  private wash = makeSoftGlowSprite();
  private flashBlob = makeSoftGlowSprite();
  private vignetteSpr = makeSoftVignetteSprite();
  private wisps: Sprite[] = [];
  private rings: Sprite[] = [];
  private motifOrbs: Sprite[] = [];
  private flashEyes: Sprite[] = [];
  private motifEyes: Sprite[] = [];
  private fx = new Graphics();
  /** Full-stage darken — never a soft blob that leaves right/bottom strips. */
  private scrim = new Graphics();
  private rgbA = new Graphics();
  private rgbB = new Graphics();
  private particleLayer = new Container();
  private particles: Particle[] = [];
  private w = 100;
  private h = 100;
  private bloomPaused = false;
  private freezeU: number | null = null;
  private ripple: PhaseRippleFilter | null = null;
  private rippleList: PhaseRippleFilter[] | null = null;
  /** Once a custom filter fails/stalls on this device, stay on baked sprites. */
  private bloomFailed = false;
  private failSafeTimer: ReturnType<typeof setTimeout> | null = null;
  /** overlay filter RT refits — must stay 0 while idle / same-size resize. */
  private filterResizeCount = 0;
  private active: {
    recipe: Recipe;
    t: number;
    scareDone: boolean;
    reverse: boolean;
    compressed: boolean;
    hooks: TransitionHooks;
    resolve: () => void;
  } | null = null;

  constructor() {
    this.root.eventMode = "none";
    this.root.visible = false;
    this.bloom.eventMode = "none";
    this.particleLayer.eventMode = "none";
    this.glowBlob.blendMode = "add";
    this.glowAccent.blendMode = "add";
    this.wash.blendMode = "add";
    this.flashBlob.blendMode = "add";
    for (let i = 0; i < WISP_COUNT; i++) {
      const s = makeSoftGlowSprite();
      s.blendMode = "add";
      this.wisps.push(s);
    }
    for (let i = 0; i < RING_COUNT; i++) {
      const s = makeSoftGlowSprite();
      s.blendMode = "add";
      this.rings.push(s);
    }
    for (let i = 0; i < 8; i++) {
      const s = makeSoftGlowSprite();
      s.blendMode = "add";
      this.motifOrbs.push(s);
    }
    for (let i = 0; i < 2; i++) {
      const s = makeSoftEyeSprite();
      s.blendMode = "normal";
      this.flashEyes.push(s);
    }
    for (let i = 0; i < 16; i++) {
      const s = makeSoftEyeSprite();
      s.blendMode = "normal";
      this.motifEyes.push(s);
    }
    this.bloom.addChild(
      this.wash,
      this.glowBlob,
      this.glowAccent,
      ...this.wisps,
      ...this.rings,
      ...this.motifOrbs,
      this.flashBlob,
    );
    this.seedParticlePool();
    this.scrim.eventMode = "none";
    this.root.addChild(
      this.scrim,
      this.vignetteSpr,
      this.bloom,
      this.fx,
      this.particleLayer,
      ...this.motifEyes,
      ...this.flashEyes,
      this.rgbA,
      this.rgbB,
    );
  }

  /**
   * Drop the overlay filter while the live canvas is torn out for a desktop
   * resize snapshot — filter targets must not churn mid-drag.
   */
  pauseFx(paused: boolean): void {
    this.bloomPaused = paused;
    if (paused) this.disableBloom();
    else if (this.active) this.enableBloom();
  }

  testFx(): { budget: "webgl"; bloom: boolean; paused: boolean } {
    return {
      budget: "webgl",
      bloom: Boolean(this.root.filters && this.root.filters.length),
      paused: this.bloomPaused,
    };
  }

  testFilterResizeCount(): number {
    return this.filterResizeCount;
  }

  freezeAt(u: number | null): void {
    if (u == null) {
      this.freezeU = null;
      return;
    }
    this.freezeU = Math.max(0, Math.min(0.98, u));
    const run = this.active;
    if (!run) return;
    run.t = this.freezeU * run.recipe.duration;
    const { recipe, hooks, reverse } = run;
    if (!run.scareDone && this.freezeU >= recipe.scareAt) {
      run.scareDone = true;
      hooks.onScareBeat();
    }
    this.pulseBloom(recipe, this.freezeU);
    this.drawFrame(recipe, this.freezeU, reverse);
  }

  resize(w: number, h: number): void {
    const nw = Math.max(1, w);
    const nh = Math.max(1, h);
    if (Math.abs(this.w - nw) > 0.5 || Math.abs(this.h - nh) > 0.5) {
      this.filterResizeCount += 1;
    }
    this.w = nw;
    this.h = nh;
    // Pin filter RT to the full stage. Without this, enabling bloom before the
    // first drawFrame can lock the ripple filter to ~2×2 soft-sprite bounds at
    // the origin — a black top-left rectangle that never covers the jam.
    this.root.filterArea = new Rectangle(0, 0, nw, nh);
  }

  get busy(): boolean {
    return Boolean(this.active);
  }

  play(from: Phase, to: Phase, hooks: TransitionHooks): Promise<void> {
    if (from === to) {
      hooks.onRevealProgress(1);
      hooks.onScareBeat();
      hooks.onShake(0, 0);
      return Promise.resolve();
    }
    if (this.active) {
      this.finish();
    }
    const { recipe, compressed, reverse } = recipeForHop(from, to);
    recipe.duration = Math.min(1.8, recipe.duration);

    this.root.visible = true;
    // filterArea must match the live stage before bloom compiles its RT.
    this.root.filterArea = new Rectangle(0, 0, this.w, this.h);
    this.resetParticles(recipe);
    this.enableBloom();

    return new Promise((resolve) => {
      this.active = {
        recipe,
        t: 0,
        scareDone: false,
        reverse,
        compressed,
        hooks,
        resolve,
      };
      hooks.onAudio(recipe.id, compressed, reverse);
      hooks.onRevealProgress(0);
      // Software WebGL / flaky ANGLE can stall while compiling a custom Filter.
      // Never leave jam.scareBusy wedged — finish on a wall-clock failsafe.
      if (this.failSafeTimer != null) clearTimeout(this.failSafeTimer);
      this.failSafeTimer = setTimeout(() => {
        this.failSafeTimer = null;
        if (this.active?.resolve === resolve) {
          this.bloomFailed = true;
          this.disableBloom();
          this.finish();
        }
      }, Math.ceil(recipe.duration * 1000) + 900);
    });
  }

  tick(dt: number): void {
    const run = this.active;
    if (!run) return;
    try {
      if (this.freezeU != null) {
        run.t = this.freezeU * run.recipe.duration;
        this.pulseBloom(run.recipe, this.freezeU);
        this.drawFrame(run.recipe, this.freezeU, run.reverse);
        return;
      }
      run.t += dt;
      const u = Math.min(1, run.t / run.recipe.duration);
      const { recipe, hooks } = run;

      const rs = recipe.revealStart;
      const re = recipe.revealEnd;
      let reveal = 0;
      if (u <= rs) reveal = 0;
      else if (u >= re) reveal = 1;
      else reveal = (u - rs) / Math.max(0.001, re - rs);
      reveal = reveal * reveal * (3 - 2 * reveal);
      hooks.onRevealProgress(run.reverse ? 1 - (1 - reveal) * 0.15 : reveal);

      if (!run.scareDone && u >= recipe.scareAt) {
        run.scareDone = true;
        hooks.onScareBeat();
      }

      const scareDist = Math.abs(u - recipe.scareAt);
      const shakeEnv = Math.max(0, 1 - scareDist * 4) * recipe.shake * (run.compressed ? 1.15 : 1);
      const shakeX = Math.sin(run.t * 62) * shakeEnv;
      const shakeY = Math.cos(run.t * 71) * shakeEnv * 0.85;
      hooks.onShake(shakeX, shakeY);

      this.stepParticles(dt, recipe, u);
      this.pulseBloom(recipe, u);
      this.drawFrame(recipe, u, run.reverse);

      if (u >= 1) this.finish();
    } catch {
      this.bloomFailed = true;
      this.disableBloom();
      this.finish();
    }
  }

  private resetFx(unloadGpu: boolean): void {
    this.fx.clear();
    this.scrim.clear();
    this.rgbA.clear();
    this.rgbB.clear();
    this.glowBlob.alpha = 0;
    this.glowAccent.alpha = 0;
    this.wash.alpha = 0;
    this.flashBlob.alpha = 0;
    this.vignetteSpr.alpha = 0;
    for (const s of this.wisps) s.alpha = 0;
    for (const s of this.rings) s.alpha = 0;
    for (const s of this.motifOrbs) s.alpha = 0;
    for (const s of this.flashEyes) s.alpha = 0;
    for (const s of this.motifEyes) s.alpha = 0;
    for (const p of this.particles) p.sprite.alpha = 0;
    if (unloadGpu) {
      this.disableBloom();
      this.fx.context.unload();
      this.rgbA.context.unload();
      this.rgbB.context.unload();
    }
  }

  private ensureRipple(): PhaseRippleFilter {
    if (!this.ripple) {
      const res = 0.45;
      this.ripple = new PhaseRippleFilter(res);
    }
    return this.ripple;
  }

  private enableBloom(): void {
    if (this.bloomPaused || this.bloomFailed) {
      this.disableBloom();
      return;
    }
    try {
      const ripple = this.ensureRipple();
      if (this.rippleList && this.root.filters === this.rippleList) return;
      this.rippleList = [ripple];
      this.root.filters = this.rippleList;
    } catch {
      this.bloomFailed = true;
      this.disableBloom();
    }
  }

  private disableBloom(): void {
    if (this.root.filters) this.root.filters = null;
    this.rippleList = null;
  }

  private pulseBloom(recipe: Recipe, u: number): void {
    if (!this.ripple || this.bloomPaused || this.bloomFailed) return;
    try {
      const scare = pulseNear(u, recipe.scareAt, 0.32);
      const rich = 0.72;
      const cy = recipe.id === "forest-to-cosmic" ? 0.4 : 0.3;
      this.ripple.setPulse(u * recipe.duration, (0.22 + scare * 0.85) * rich, 0.5, cy);
    } catch {
      this.bloomFailed = true;
      this.disableBloom();
    }
  }

  private finish(): void {
    const run = this.active;
    if (!run) return;
    if (this.failSafeTimer != null) {
      clearTimeout(this.failSafeTimer);
      this.failSafeTimer = null;
    }
    this.freezeU = null;
    if (!run.scareDone) run.hooks.onScareBeat();
    run.hooks.onRevealProgress(1);
    run.hooks.onShake(0, 0);
    this.active = null;
    this.root.visible = false;
    // Clear drawing state; skip GPU geometry unload every hop — unload can
    // stall software WebGL/ANGLE and wedge scareBusy across later dial taps.
    this.resetFx(false);
    this.disableBloom();
    run.resolve();
  }

  private seedParticlePool(): void {
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const sprite = makeSoftGlowSprite();
      sprite.blendMode = "add";
      this.particleLayer.addChild(sprite);
      this.particles.push({
        sprite,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        max: 1,
        r: 3,
        color: 0xffe566,
        kind: "spark",
      });
    }
  }

  private resetParticles(recipe: Recipe): void {
    const n = Math.min(PARTICLE_POOL, recipe.particleBurst);
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!;
      if (i < n) {
        this.spawnInto(p, recipe.id, i / n);
      } else {
        p.sprite.alpha = 0;
        p.life = 0;
        p.max = 1e6;
      }
    }
  }

  private spawnInto(p: Particle, id: TransitionRecipeId, seed: number): void {
    const { w, h } = this;
    const kind = particleKind(id, seed);
    p.kind = kind;
    p.x = Math.random() * w;
    p.y = Math.random() * h;
    const speed = 40 + Math.random() * 120;
    const angle =
      id === "forest-to-cosmic" || id === "cosmic-to-vortex" || id === "vortex-intensify"
        ? Math.atan2(h * 0.35 - p.y, w * 0.5 - p.x) + (Math.random() - 0.5) * 0.8
        : id === "reverse-unwind"
          ? -Math.PI / 2 + (Math.random() - 0.5)
          : Math.random() * Math.PI * 2;
    p.vx = Math.cos(angle) * speed * (id === "meadow-to-dusk" ? 0.35 : 1);
    p.vy =
      id === "meadow-to-dusk"
        ? 30 + Math.random() * 40
        : id === "reverse-unwind"
          ? -60 - Math.random() * 80
          : Math.sin(angle) * speed;
    p.life = 0;
    p.max = 0.5 + Math.random() * 1.1;
    p.r = kind === "eye" ? 18 + Math.random() * 16 : 3 + Math.random() * 5;
    p.color = particleColor(kind, id);
    p.sprite.texture = kind === "eye" ? softEyeTexture() : softGlowTexture();
    p.sprite.tint = p.color;
    p.sprite.blendMode = kind === "eye" ? "normal" : "add";
  }

  private stepParticles(dt: number, recipe: Recipe, u: number): void {
    const { w, h } = this;
    const vortex =
      recipe.id === "cosmic-to-vortex" || recipe.id === "vortex-intensify" || recipe.id === "forest-to-cosmic";
    const cx = w * 0.5;
    const cy = h * (recipe.id === "forest-to-cosmic" ? 0.42 : 0.32);
    const n = Math.min(PARTICLE_POOL, recipe.particleBurst + (u > recipe.scareAt ? 12 : 0));

    for (let i = 0; i < n; i++) {
      const p = this.particles[i]!;
      p.life += dt;
      if (vortex) {
        const dx = cx - p.x;
        const dy = cy - p.y;
        const pull = (recipe.id === "vortex-intensify" ? 2.2 : 1.4) * u;
        p.vx += dx * pull * dt;
        p.vy += dy * pull * dt;
        p.vx += -dy * 0.8 * dt;
        p.vy += dx * 0.8 * dt;
      }
      if (recipe.id === "meadow-to-dusk") {
        p.vy += 20 * dt;
        p.vx += Math.sin(p.life * 6 + p.x) * 12 * dt;
      }
      if (recipe.id === "horror-to-forest") {
        p.vx += (Math.random() - 0.5) * 200 * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.life > p.max) this.spawnInto(p, recipe.id, Math.random());
    }
  }

  private drawFrame(recipe: Recipe, u: number, reverse: boolean): void {
    const { w, h } = this;
    this.fx.clear();
    this.scrim.clear();
    this.rgbA.clear();
    this.rgbB.clear();

    // Full-stage darken (axis-aligned on purpose). Soft blobs alone left a
    // top-left "black rectangle" with the jam still visible on the right/bottom
    // when filter bounds or overlay math lagged the live buffer.
    const scare = pulseNear(u, recipe.scareAt, 0.35);
    const scrimA =
      (0.22 + 0.55 * Math.sin(u * Math.PI) + 0.35 * scare) * (reverse ? 0.65 : 1);
    this.scrim.rect(0, 0, w, h);
    this.scrim.fill({ color: 0x0a0608, alpha: Math.min(0.88, scrimA) });

    const vigA =
      (0.25 + 0.45 * pulseNear(u, recipe.scareAt, 0.25) + 0.2 * Math.sin(u * Math.PI)) *
      (reverse ? 0.7 : 1);
    this.vignetteSpr.tint = recipe.vignette;
    this.vignetteSpr.alpha = Math.min(0.78, vigA);
    // Radius ≥ half-diagonal so the soft rim always reaches every corner.
    const halfDiag = Math.hypot(w, h) * 0.5;
    placeSoftFalloff(this.vignetteSpr, w * 0.5, h * 0.5, halfDiag * 1.05, halfDiag * 1.05);

    this.drawGlow(recipe, u, reverse);
    this.drawMotif(recipe.id, u, reverse);

    const n = Math.min(PARTICLE_POOL, recipe.particleBurst + (u > recipe.scareAt ? 12 : 0));
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!;
      if (i >= n) {
        p.sprite.alpha = 0;
        continue;
      }
      const a = Math.max(0, 1 - p.life / p.max) * (0.45 + 0.4 * pulseNear(u, recipe.scareAt, 0.35));
      p.sprite.tint = p.color;
      p.sprite.alpha = a;
      const rx =
        p.kind === "petal" || p.kind === "leaf"
          ? p.r * 2.2
          : p.kind === "eye"
            ? p.r * 1.45
            : p.r * 1.6;
      const ry =
        p.kind === "petal" || p.kind === "leaf"
          ? p.r * 1.1
          : p.kind === "eye"
            ? p.r * 1.05
            : p.r * 1.6;
      placeSoftFalloff(p.sprite, p.x, p.y, rx, ry);
    }

    const chroma = pulseNear(u, recipe.scareAt, 0.12);
    if (chroma > 0.05 && recipe.flash !== "none") {
      const ox = 5 + chroma * 10;
      for (let i = 0; i < 5; i++) {
        const ex = w * (0.2 + i * 0.15);
        const ey = h * (0.22 + (i % 2) * 0.08);
        this.rgbA.circle(ex - ox, ey, 5);
        this.rgbA.fill({ color: 0xff2244, alpha: chroma * 0.55 });
        this.rgbB.circle(ex + ox, ey, 5);
        this.rgbB.fill({ color: 0x44e0ff, alpha: chroma * 0.45 });
      }
    }

    if (recipe.flash !== "none") {
      const flash = pulseNear(u, recipe.scareAt, 0.045);
      this.flashBlob.tint = recipe.flash === "red" ? 0xff1a22 : 0xfff4e8;
      this.flashBlob.alpha = flash * (recipe.flash === "red" ? 0.72 : 0.62);
      placeSoftFalloff(this.flashBlob, w * 0.5, h * 0.42, w * 0.55, h * 0.48);
      if (flash > 0.01 && recipe.id !== "meadow-to-dusk" && recipe.id !== "reverse-unwind") {
        const eyeA = flash * 0.95;
        const er = Math.min(w, h) * 0.055;
        this.placeEye(this.flashEyes[0]!, w * 0.38, h * 0.42, er * 1.15, er * 0.85, 0xffe566, eyeA);
        this.placeEye(this.flashEyes[1]!, w * 0.62, h * 0.42, er * 1.15, er * 0.85, 0xffe566, eyeA);
      } else {
        for (const s of this.flashEyes) s.alpha = 0;
      }
    } else {
      this.flashBlob.alpha = 0;
      for (const s of this.flashEyes) s.alpha = 0;
    }
  }

  /**
   * Radial glow sprites + wisps + expanding shock rings. The overlay filter
   * blooms the same discs. No stacked hard ovals (scrim is separate).
   */
  private drawGlow(recipe: Recipe, u: number, reverse: boolean): void {
    const { w, h } = this;
    const scare = pulseNear(u, recipe.scareAt, 0.3);
    const rich = 0.78;
    const a = (0.22 + scare * 0.55) * rich * (reverse ? 0.65 : 1);
    const cx = w * 0.5;
    const cy = h * (recipe.id === "forest-to-cosmic" ? 0.4 : 0.3);
    const col =
      recipe.flash === "red" ? 0xff2244 : recipe.id === "meadow-to-dusk" ? 0xff8844 : 0xaa44ff;
    const radius = Math.min(w, h) * (0.38 + u * 0.22);
    this.glowBlob.tint = col;
    this.glowBlob.alpha = a;
    placeSoftFalloff(this.glowBlob, cx, cy, radius, radius * 0.92);

    this.wash.tint = recipe.vignette;
    this.wash.alpha = 0.18 * rich * (0.35 + scare);
    placeSoftFalloff(this.wash, cx, h * 0.18, w * 0.62, h * 0.34);

    this.placeMotifAccent(recipe.id, u, reverse, rich);
    this.placeWisps(recipe, u, rich);
    this.placeShockwaves(recipe, u, rich, cx, cy);
  }

  private placeWisps(recipe: Recipe, u: number, rich: number): void {
    const { w, h } = this;
    const scare = pulseNear(u, recipe.scareAt, 0.4);
    for (let i = 0; i < this.wisps.length; i++) {
      const s = this.wisps[i]!;
      const ang = u * (2.2 + i * 0.4) + i * 1.3;
      const rad = Math.min(w, h) * (0.18 + (i % 3) * 0.07 + scare * 0.08);
      const x = w * 0.5 + Math.cos(ang) * rad;
      const y = h * 0.34 + Math.sin(ang * 0.85) * rad * 0.55;
      s.tint = i % 2 ? recipe.vignette || 0xaa66ff : recipe.flash === "red" ? 0xff6688 : 0xffcc88;
      s.alpha = (0.12 + scare * 0.28) * rich;
      const rr = Math.min(w, h) * (0.1 + (i % 2) * 0.05);
      placeSoftFalloff(s, x, y, rr, rr * 0.62);
    }
  }

  private placeShockwaves(recipe: Recipe, u: number, rich: number, cx: number, cy: number): void {
    const scare = Math.max(0, u - recipe.scareAt);
    for (let i = 0; i < this.rings.length; i++) {
      const s = this.rings[i]!;
      const delay = i * 0.045;
      const t = scare - delay;
      if (t <= 0 || t > 0.55) {
        s.alpha = 0;
        continue;
      }
      const grow = t / 0.55;
      const rr = Math.min(this.w, this.h) * (0.12 + grow * 0.55);
      s.tint = recipe.flash === "red" ? 0xff4466 : 0xd0a0ff;
      s.alpha = (1 - grow) * 0.38 * rich;
      placeSoftFalloff(s, cx, cy, rr, rr * 0.88);
    }
  }

  private placeMotifAccent(id: TransitionRecipeId, u: number, reverse: boolean, rich: number): void {
    const { w, h } = this;
    const accent = this.glowAccent;
    if (id === "meadow-to-dusk" || (id === "reverse-unwind" && reverse)) {
      const sunY = reverse ? h * (0.35 - u * 0.2) : h * (0.12 + u * 0.22);
      const sunR = Math.min(w, h) * (0.22 + u * 0.06);
      accent.tint = reverse ? 0xfff1a0 : lerpColor(0xfff1a0, 0xff6633, u);
      accent.alpha = (0.7 + u * 0.25) * rich;
      placeSoftFalloff(accent, w * 0.82, sunY, sunR, sunR);
      return;
    }
    if (id === "dusk-to-horror") {
      const r = Math.min(w, h) * (0.18 + u * 0.1);
      accent.tint = 0xff2244;
      accent.alpha = 0.4 * u * rich;
      placeSoftFalloff(accent, w * 0.22, h * 0.14, r, r);
      return;
    }
    if (id === "cosmic-to-vortex" || id === "vortex-intensify") {
      const er = Math.min(w, h) * (0.14 + u * 0.1) * (id === "vortex-intensify" ? 1.15 : 1);
      accent.tint = 0xff2266;
      accent.alpha = (0.2 + u * 0.14) * rich;
      placeSoftFalloff(accent, w * 0.5, h * 0.3, er, er);
      return;
    }
    accent.alpha = 0;
  }

  private hideOrbs(): void {
    for (const s of this.motifOrbs) s.alpha = 0;
    for (const s of this.motifEyes) s.alpha = 0;
  }

  private placeEye(sprite: Sprite, x: number, y: number, rx: number, ry: number, tint: number, alpha: number): void {
    sprite.tint = tint;
    sprite.alpha = alpha;
    sprite.blendMode = "normal";
    placeSoftFalloff(sprite, x, y, rx, ry);
  }

  private drawMotif(id: TransitionRecipeId, u: number, reverse: boolean): void {
    const { w, h } = this;
    const g = this.fx;
    this.hideOrbs();
    if (id === "meadow-to-dusk" || (id === "reverse-unwind" && reverse)) {
      const orb = this.motifOrbs[0]!;
      orb.tint = 0x4a2060;
      orb.alpha = (reverse ? 1 - u : u) * 0.38;
      placeSoftFalloff(orb, w * 0.5, h * 0.18, w * 0.55, h * 0.32);
      return;
    }
    if (id === "dusk-to-horror") {
      const r = Math.min(w, h) * (0.08 + u * 0.06);
      const sx = w * 0.22;
      const sy = h * 0.14;
      g.circle(sx, sy, r);
      g.fill({ color: 0x0a0608, alpha: 0.9 });
      g.circle(sx + r * 0.15, sy, r * 0.35);
      g.fill({ color: 0xff2244, alpha: 0.7 * pulseNear(u, 0.48, 0.2) });
      const crackA = Math.max(0, u - 0.25) / 0.75;
      for (let i = 0; i < 6; i++) {
        const x0 = w * (0.15 + i * 0.12);
        const y0 = h * 0.62;
        g.moveTo(x0, y0);
        g.lineTo(x0 + (i % 2 ? 18 : -14) * crackA, y0 + 50 * crackA);
        g.lineTo(x0 + (i % 2 ? -8 : 12) * crackA, y0 + 90 * crackA);
        g.stroke({ width: 2 + (i % 3), color: 0x2a0608, alpha: 0.55 * crackA });
      }
      return;
    }
    if (id === "horror-to-forest") {
      const bloom = Math.min(1, u * 1.4);
      for (let i = 0; i < 14; i++) {
        const x = w * (0.08 + (i % 7) * 0.14);
        const y = h * (0.12 + Math.floor(i / 7) * 0.16 + Math.sin(u * 8 + i) * 0.02);
        const er = (12 + (i % 4) * 3) * bloom;
        const eye = this.motifEyes[i];
        if (eye) this.placeEye(eye, x, y, er * 1.15, er * 0.85, 0xff3355, 0.88 * bloom);
      }
      const lash = Math.max(0, u - 0.2);
      for (let i = 0; i < 4; i++) {
        const y = h * (0.3 + i * 0.12);
        g.moveTo(0, y);
        g.bezierCurveTo(w * 0.3 * lash, y - 40, w * 0.6 * lash, y + 50, w * lash, y + Math.sin(u * 10 + i) * 20);
        g.stroke({ width: 5, color: 0x2a4a28, alpha: 0.65 * lash });
      }
      return;
    }
    if (id === "forest-to-cosmic") {
      const orb = this.motifOrbs[0]!;
      orb.tint = 0x0a0418;
      orb.alpha = 0.28 + u * 0.4;
      placeSoftFalloff(orb, w * 0.5, h * 0.42, w * 0.55, h * 0.48);
      const slam = Math.max(0, (u - 0.35) / 0.4);
      for (let i = 0; i < 5; i++) {
        const ix = w * (0.15 + i * 0.17);
        const iy = h * (0.25 + (i % 3) * 0.1) + (1 - slam) * (80 + i * 30);
        const blob = this.motifOrbs[i + 1];
        if (blob) {
          blob.tint = 0x2a1040;
          blob.alpha = 0.55 * slam;
          placeSoftFalloff(blob, ix, iy, 34, 26);
        }
        const eye = this.motifEyes[i];
        if (eye) this.placeEye(eye, ix, iy, 16, 12, 0xff4466, 0.9 * slam);
      }
      return;
    }
    if (id === "cosmic-to-vortex" || id === "vortex-intensify") {
      const cx = w * 0.5;
      const cy = h * 0.3;
      const rings = id === "vortex-intensify" ? 6 : 4;
      const spin = u * (id === "vortex-intensify" ? 10 : 7);
      for (let i = 0; i < rings; i++) {
        const blob = this.motifOrbs[i];
        if (!blob) continue;
        const rr = Math.min(w, h) * (0.08 + i * 0.07) * (0.6 + u * 0.6);
        blob.tint = i % 2 ? 0xff2299 : 0x66eeff;
        blob.alpha = 0.18 + 0.16 * Math.sin(spin + i);
        placeSoftFalloff(blob, cx, cy, rr, rr * 0.72);
      }
      const er = Math.min(w, h) * (0.08 + u * 0.05) * (id === "vortex-intensify" ? 1.15 : 1);
      const core = this.motifEyes[0];
      if (core) this.placeEye(core, cx, cy, er * 1.15, er * 0.9, 0xff3355, 0.92);
      for (let i = 0; i < 6; i++) {
        const ang = spin + i * 1.1;
        const rad = Math.min(w, h) * (0.42 - u * 0.28);
        const ix = cx + Math.cos(ang) * rad;
        const iy = cy + Math.sin(ang) * rad * 0.65;
        const eye = this.motifEyes[i + 1];
        if (eye) this.placeEye(eye, ix, iy, 14 - u * 3, 11 - u * 2, 0xaa66ff, 0.72);
      }
    }
  }
}

function pulseNear(u: number, center: number, width: number): number {
  const d = Math.abs(u - center) / Math.max(0.001, width);
  return Math.max(0, 1 - d);
}

function particleKind(id: TransitionRecipeId, seed: number): Particle["kind"] {
  if (id === "meadow-to-dusk") return seed < 0.55 ? "ember" : seed < 0.85 ? "petal" : "spark";
  if (id === "dusk-to-horror") return seed < 0.45 ? "eye" : seed < 0.75 ? "ember" : "spark";
  if (id === "horror-to-forest") return seed < 0.5 ? "eye" : seed < 0.75 ? "leaf" : "ember";
  if (id === "forest-to-cosmic") return seed < 0.4 ? "spark" : seed < 0.7 ? "eye" : "ember";
  if (id === "cosmic-to-vortex") return seed < 0.35 ? "eye" : seed < 0.7 ? "spark" : "glitch";
  if (id === "vortex-intensify") return seed < 0.4 ? "eye" : seed < 0.65 ? "glitch" : "spark";
  return seed < 0.5 ? "petal" : "spark";
}

function particleColor(kind: Particle["kind"], id: TransitionRecipeId): number {
  if (kind === "eye") return id === "meadow-to-dusk" ? 0xffe566 : 0xff3355;
  if (kind === "petal") return 0xff88cc;
  if (kind === "leaf") return 0x6edb9a;
  if (kind === "glitch") return Math.random() > 0.5 ? 0xff44aa : 0x44ffff;
  if (kind === "ember") return id === "meadow-to-dusk" ? 0xffcc66 : 0xff6644;
  return 0xffe566;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
