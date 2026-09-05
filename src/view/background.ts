import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { Phase } from "../types";
import {
  cssObjectPosition,
  hostCoverInGpuSpace,
  pivotForPhaseSet,
  type CoverPivot,
} from "./photoCover";
import { loadPhotoTexture } from "./textures";
import { photoOrientForHost, type PhotoOrient } from "./windowAspect";
import { artUrl } from "../publicUrl";

/** Game phases map to consecutive background sets A–G (1…7). */
const PHASE_BG_SET: Record<Phase, number> = {
  1: 1,
  2: 2,
  3: 3,
  10: 4,
  100: 5,
  1000: 6,
  100000: 7,
};

function bgUrl(set: number, orient: PhotoOrient): string {
  return artUrl(`bg-phase${set}-${orient}.jpeg`);
}

/**
 * Photo-based stage backdrop: cover-fit phase JPEGs.
 * Landscape vs portrait is picked from the **window / host CSS box**, not the
 * frozen GPU buffer and not `screen.orientation`. Cover scale is exact cover
 * (no extra zoom). Phase 1 biases the pivot toward the smiling tree.
 *
 * A CSS sibling (`#stage-fill`) uses the same JPEG + object-position so
 * letterboxed desktop presents never show empty stage color bars.
 */
export class StageBackground {
  root = new Container();
  private photoLayer = new Container();
  private spriteA = new Sprite();
  private spriteB = new Sprite();
  private frontIsA = true;
  private phase: Phase = 1;
  private w = 100;
  private h = 100;
  private hostW = 100;
  private hostH = 100;
  private loaded = new Map<string, Texture>();
  /** Manual reveal of the prepared back sprite (0–1). Null = not deferred. */
  private deferred: { back: Sprite; front: Sprite; from: Phase; phase: Phase } | null = null;
  private fillEl: HTMLImageElement | null = null;

  constructor() {
    this.spriteA.anchor.set(0.5);
    this.spriteB.anchor.set(0.5);
    this.spriteA.roundPixels = false;
    this.spriteB.roundPixels = false;
    this.spriteB.alpha = 0;
    this.photoLayer.addChild(this.spriteA, this.spriteB);
    this.root.addChild(this.photoLayer);
  }

  attachFill(el: HTMLImageElement | null): void {
    this.fillEl = el;
    this.syncFill();
  }

  /** Hide letterbox fill during cinematic hops so bars cannot outshine the FX. */
  setFillVisible(visible: boolean): void {
    const el = this.fillEl;
    if (!el) return;
    el.style.opacity = visible ? "1" : "0";
  }

  async preload(): Promise<void> {
    // Phase 1 first so boot paint is immediate; warm the rest in the background.
    await this.ensureLoaded(1);
    void Promise.all([2, 3, 4, 5, 6, 7].map((set) => this.ensureLoaded(set)));
  }

  /**
   * Immediate phase commit (boot / no-transition paths).
   * Swaps the photo right away with a short crossfade when the set changes.
   */
  setPhase(phase: Phase): void {
    void this.commitPhase(phase, true);
  }

  /**
   * Load the destination photo onto the back buffer at alpha 0.
   * Call before a cinematic transition so the overlay can reveal it.
   */
  async preparePhase(phase: Phase): Promise<void> {
    const set = PHASE_BG_SET[phase];
    await this.ensureLoaded(set);
    const tex = this.textureFor(set);
    if (!tex) return;

    const front = this.frontIsA ? this.spriteA : this.spriteB;
    const back = this.frontIsA ? this.spriteB : this.spriteA;

    // Same texture already showing — still mark deferred so reveal is a no-op fade.
    // CRITICAL: cover-fit BOTH buffers. Otherwise finishReveal / setRevealProgress
    // fades in an unfitted back (stale portrait size after a landscape rotate →
    // black half-screen).
    if (front.texture === tex && front.alpha > 0.9) {
      this.coverFit(front, tex, set);
      this.coverFit(back, tex, set);
      back.alpha = 0;
      this.deferred = { back, front, from: this.phase, phase };
      this.syncFill();
      return;
    }

    this.coverFit(back, tex, set);
    back.alpha = 0;
    // Ensure back draws above front during reveal.
    if (this.photoLayer.children[this.photoLayer.children.length - 1] !== back) {
      this.photoLayer.removeChild(back);
      this.photoLayer.addChild(back);
    }
    this.deferred = { back, front, from: this.phase, phase };
    this.syncFill();
  }

  /** Drive deferred photo reveal (0 = old, 1 = new). */
  setRevealProgress(t: number): void {
    const d = this.deferred;
    if (!d) return;
    const k = Math.max(0, Math.min(1, t));
    d.back.alpha = k;
    d.front.alpha = 1 - k * 0.92;
  }

  /**
   * Finish a deferred reveal: flip front buffer.
   * Portrait/HUD mood is owned by jam.ts (scare beat).
   */
  finishReveal(phase: Phase): void {
    const d = this.deferred;
    if (d) {
      d.back.alpha = 1;
      d.front.alpha = 0;
      this.frontIsA = d.back === this.spriteA;
      this.deferred = null;
      // Re-cover after swap so a mid-transition orientation change cannot leave
      // the newly visible buffer at a stale cover-fit.
      const tex = this.textureFor(PHASE_BG_SET[phase]);
      if (tex) {
        const front = this.frontIsA ? this.spriteA : this.spriteB;
        this.coverFit(front, tex, PHASE_BG_SET[phase]);
      }
    }
    this.phase = phase;
    this.syncFill();
  }

  /**
   * GPU box for sprite layout. Optional host box picks landscape vs portrait
   * from the window (frozen Windows GPU aspect must not lock the JPEG).
   */
  resize(w: number, h: number, host?: { w: number; h: number }): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    if (host) {
      this.hostW = Math.max(1, host.w);
      this.hostH = Math.max(1, host.h);
    } else {
      this.hostW = this.w;
      this.hostH = this.h;
    }
    this.refitAllPhotos();
  }

  /**
   * Update the window/host box without touching the GPU size. Swaps the JPEG
   * as soon as width vs height crosses (desktop drag included).
   */
  setHostBox(hostW: number, hostH: number): void {
    this.hostW = Math.max(1, hostW);
    this.hostH = Math.max(1, hostH);
    this.refitAllPhotos();
  }

  /**
   * Cover-fit the visible photo (and deferred/inactive twin) using current w/h
   * and the matching portrait vs landscape JPEG for each phase.
   */
  refitAllPhotos(): void {
    // Mid-hop HUD changes (skip dial, scare beat) fire ResizeObserver → here.
    // Pin the outgoing photo to deferred.from so a phase update cannot retarget
    // the fading-out sprite to the destination (that collapsed the dissolve into
    // a cheap snap after the rotate/re-cover fix).
    if (this.deferred) {
      const fromSet = PHASE_BG_SET[this.deferred.from];
      const toSet = PHASE_BG_SET[this.deferred.phase];
      const fromTex = this.textureFor(fromSet);
      const toTex = this.textureFor(toSet);
      if (fromTex) this.coverFit(this.deferred.front, fromTex, fromSet);
      if (toTex) this.coverFit(this.deferred.back, toTex, toSet);
      this.syncFill();
      return;
    }

    const front = this.frontIsA ? this.spriteA : this.spriteB;
    const back = this.frontIsA ? this.spriteB : this.spriteA;
    const set = PHASE_BG_SET[this.phase];
    const frontTex = this.textureFor(set);
    if (frontTex) {
      this.coverFit(front, frontTex, set);
      // Keep the hidden buffer matched so same-set / quick hops cannot reveal a
      // portrait-sized sprite on a landscape stage (or the reverse).
      this.coverFit(back, frontTex, set);
    }
    this.syncFill();
  }

  currentPhotoUrl(): string {
    const set = this.deferred ? PHASE_BG_SET[this.deferred.phase] : PHASE_BG_SET[this.phase];
    return bgUrl(set, this.orient());
  }

  currentObjectPosition(): string {
    const set = this.deferred ? PHASE_BG_SET[this.deferred.phase] : PHASE_BG_SET[this.phase];
    return cssObjectPosition(this.pivotFor(set));
  }

  /**
   * Test helper: visible photo must cover the stage (no black half after rotate),
   * with no giant phase numeral or translucent bench on top of the JPEG.
   */
  testCoverage(): {
    stageW: number;
    stageH: number;
    hostW: number;
    hostH: number;
    orient: PhotoOrient;
    src: string;
    spriteW: number;
    spriteH: number;
    covers: boolean;
    set: number;
    pivotX: number;
    pivotY: number;
    objectPosition: string;
    phaseNumeral: boolean;
    benchOverlay: boolean;
  } {
    const front = this.frontIsA ? this.spriteA : this.spriteB;
    const spriteW = Math.abs(front.width);
    const spriteH = Math.abs(front.height);
    const left = front.x - spriteW * front.anchor.x;
    const top = front.y - spriteH * front.anchor.y;
    const covers =
      front.alpha > 0.5 &&
      spriteW >= this.w - 2 &&
      spriteH >= this.h - 2 &&
      left <= 1 &&
      top <= 1 &&
      left + spriteW >= this.w - 1 &&
      top + spriteH >= this.h - 1;
    const overlays = this.overlayFlags();
    const set = PHASE_BG_SET[this.phase];
    const pivot = this.pivotFor(set);
    return {
      stageW: this.w,
      stageH: this.h,
      hostW: this.hostW,
      hostH: this.hostH,
      orient: this.orient(),
      src: this.currentPhotoUrl(),
      spriteW,
      spriteH,
      covers,
      set,
      pivotX: pivot.x,
      pivotY: pivot.y,
      objectPosition: cssObjectPosition(pivot),
      phaseNumeral: overlays.phaseNumeral,
      benchOverlay: overlays.benchOverlay,
    };
  }

  tick(_time: number): void {
    // Reveal is driven by PhaseTransition via setRevealProgress.
  }

  /**
   * Walk the backdrop graph for the old giant phase Text + Graphics bench.
   * Photo sprites are ignored; any other Text matching the phase, or any
   * Graphics under this.root, is an overlay regression.
   */
  private overlayFlags(): { phaseNumeral: boolean; benchOverlay: boolean } {
    const numeral = this.phase >= 1000 ? this.phase.toLocaleString() : String(this.phase);
    let phaseNumeral = false;
    let benchOverlay = false;
    const walk = (node: Container): void => {
      for (const child of node.children) {
        if (child instanceof Text && child.visible && child.alpha > 0.01) {
          const raw = String(child.text).replace(/,/g, "");
          if (raw === String(this.phase) || String(child.text) === numeral) {
            phaseNumeral = true;
          }
        }
        if (child instanceof Graphics && child.visible && child.alpha > 0.01) {
          benchOverlay = true;
        }
        if (child instanceof Container && !(child instanceof Sprite) && !(child instanceof Text)) {
          walk(child);
        }
      }
    };
    walk(this.root);
    return { phaseNumeral, benchOverlay };
  }

  private async commitPhase(phase: Phase, crossfade: boolean): Promise<void> {
    this.deferred = null;
    const prevSet = PHASE_BG_SET[this.phase];
    this.phase = phase;
    const nextSet = PHASE_BG_SET[phase];
    await this.applyPhoto(nextSet, crossfade && prevSet !== nextSet);
    this.syncFill();
  }

  /** Window / host CSS box — not the frozen GPU buffer, not screen.orientation. */
  private orient(): PhotoOrient {
    return photoOrientForHost({ w: this.hostW, h: this.hostH });
  }

  private pivotFor(set: number): CoverPivot {
    return pivotForPhaseSet(set, this.orient());
  }

  private async ensureLoaded(set: number): Promise<void> {
    const urls = [bgUrl(set, "portrait"), bgUrl(set, "landscape")];
    await Promise.all(
      urls.map(async (url) => {
        if (this.loaded.has(url)) return;
        try {
          const tex = await loadPhotoTexture(url);
          this.loaded.set(url, tex);
        } catch (err) {
          console.warn("Background failed to load", url, err);
        }
      }),
    );
  }

  private textureFor(set: number): Texture | null {
    const url = bgUrl(set, this.orient());
    return this.loaded.get(url) ?? null;
  }

  private coverFit(sprite: Sprite, tex: Texture, set: number): void {
    if (sprite.texture !== tex) sprite.texture = tex;
    const pivot = this.pivotFor(set);
    const fit = hostCoverInGpuSpace(
      this.w,
      this.h,
      this.hostW,
      this.hostH,
      tex.width,
      tex.height,
      pivot,
    );
    sprite.anchor.set(fit.anchorX, fit.anchorY);
    sprite.scale.set(fit.scale);
    sprite.position.set(fit.x, fit.y);
  }

  private syncFill(): void {
    const el = this.fillEl;
    if (!el) return;
    const url = this.currentPhotoUrl();
    const pos = this.currentObjectPosition();
    // getAttribute: resolved .src is absolute; relative BASE_URL (./art/...) must compare as set.
    if (el.getAttribute("src") !== url) el.src = url;
    el.style.objectFit = "cover";
    el.style.objectPosition = pos;
  }

  private async applyPhoto(set: number, crossfade: boolean): Promise<void> {
    await this.ensureLoaded(set);
    const tex = this.textureFor(set);
    if (!tex) return;

    const front = this.frontIsA ? this.spriteA : this.spriteB;
    const back = this.frontIsA ? this.spriteB : this.spriteA;

    if (!front.texture || front.texture === Texture.EMPTY || !crossfade) {
      this.coverFit(front, tex, set);
      this.coverFit(back, tex, set);
      front.alpha = 1;
      back.alpha = 0;
      return;
    }

    if (front.texture === tex) {
      this.coverFit(front, tex, set);
      this.coverFit(back, tex, set);
      return;
    }

    // Quick self-managed crossfade for non-cinematic paths.
    this.coverFit(back, tex, set);
    back.alpha = 1;
    front.alpha = 0;
    this.frontIsA = !this.frontIsA;
    // Keep the new inactive buffer cover-fitted for the next hop/rotate.
    this.coverFit(front, tex, set);
  }
}
