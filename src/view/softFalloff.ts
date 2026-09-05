import { Sprite, Texture } from "pixi.js";
import { hardenTextureOnce } from "./textures";

/**
 * Shared CSS-like radial falloff textures (one bake each, never per-frame).
 * Ground shadows / pad blobs / phase-hop glow all stretch the same discs —
 * bilinear scale makes an ellipse, alpha eases like box-shadow blur.
 */

function bakeRadial(stops: readonly (readonly [number, string])[], size: number): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("soft falloff needs a 2D canvas");
  const mid = size * 0.5;
  const grd = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);
  for (const [offset, color] of stops) grd.addColorStop(offset, color);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  const tex = Texture.from(canvas);
  hardenTextureOnce(tex);
  tex.source.scaleMode = "linear";
  return tex;
}

let shadowTex: Texture | null = null;
let glowTex: Texture | null = null;
let vignetteTex: Texture | null = null;
let moteTex: Texture | null = null;
let eyeTex: Texture | null = null;

/**
 * White radial disc — tint the sprite to a friend / button color.
 * A black bake cannot tint (0 * color = 0), which is why every pool read gray.
 */
export function softShadowTexture(): Texture {
  if (!shadowTex) {
    // Hold opacity through the mid disc so the rim that peeks past a chip
    // still reads ~CSS box-shadow, then ease the last third to 0.
    shadowTex = bakeRadial(
      [
        [0, "rgba(255,255,255,1)"],
        [0.42, "rgba(255,255,255,0.78)"],
        [0.68, "rgba(255,255,255,0.32)"],
        [0.88, "rgba(255,255,255,0.08)"],
        [1, "rgba(255,255,255,0)"],
      ],
      128,
    );
  }
  return shadowTex;
}

/** Soft white bloom → 0 at the edge; tint per hop. Center stays translucent
 * so additive GPU bloom never collapses into one hard opaque disc. */
export function softGlowTexture(): Texture {
  if (!glowTex) {
    glowTex = bakeRadial(
      [
        [0, "rgba(255,255,255,0.55)"],
        [0.3, "rgba(255,255,255,0.28)"],
        [0.58, "rgba(255,255,255,0.1)"],
        [0.82, "rgba(255,255,255,0.03)"],
        [1, "rgba(255,255,255,0)"],
      ],
      256,
    );
  }
  return glowTex;
}

export function makeSoftFalloffSprite(
  texture: Texture,
  x: number,
  y: number,
  rx: number,
  ry: number,
): Sprite {
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.eventMode = "none";
  sprite.roundPixels = false;
  placeSoftFalloff(sprite, x, y, rx, ry);
  return sprite;
}

export function makeSoftShadowSprite(x: number, y: number, rx: number, ry: number): Sprite {
  return makeSoftFalloffSprite(softShadowTexture(), x, y, rx, ry);
}

export function makeSoftGlowSprite(x = 0, y = 0, rx = 1, ry = 1): Sprite {
  const sprite = makeSoftFalloffSprite(softGlowTexture(), x, y, rx, ry);
  sprite.alpha = 0;
  return sprite;
}

/** Transparent core → dark rim. Stretch to the stage for an organic vignette. */
export function softVignetteTexture(): Texture {
  if (!vignetteTex) {
    vignetteTex = bakeRadial(
      [
        [0, "rgba(0,0,0,0)"],
        [0.38, "rgba(0,0,0,0)"],
        [0.62, "rgba(0,0,0,0.18)"],
        [0.82, "rgba(0,0,0,0.48)"],
        [1, "rgba(0,0,0,0.78)"],
      ],
      256,
    );
  }
  return vignetteTex;
}

/**
 * Pollen / ash disc for ParticleContainer motes. Denser core than a 64px
 * whisper so a 22–40px sprite still reads on a bright Phase 1 meadow photo.
 */
export function softMoteTexture(): Texture {
  if (!moteTex) {
    moteTex = bakeRadial(
      [
        [0, "rgba(255,255,255,0.95)"],
        [0.16, "rgba(255,255,255,0.72)"],
        [0.38, "rgba(255,255,255,0.32)"],
        [0.62, "rgba(255,255,255,0.1)"],
        [0.84, "rgba(255,255,255,0.03)"],
        [1, "rgba(255,255,255,0)"],
      ],
      128,
    );
  }
  return moteTex;
}

/**
 * High-res horror eye (256px). Oval sclera + pupil + highlight + soft glow.
 * Tint yellow / red per hop. Linear filtering so scaled copies stay smooth
 * on WebGL — never a 6–14px Graphics dot.
 */
export function softEyeTexture(): Texture {
  if (!eyeTex) {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("eye texture needs a 2D canvas");
    const mid = size * 0.5;

    const glow = ctx.createRadialGradient(mid, mid, size * 0.16, mid, mid, size * 0.5);
    glow.addColorStop(0, "rgba(255,255,255,0.42)");
    glow.addColorStop(0.55, "rgba(255,255,255,0.1)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    ctx.save();
    ctx.translate(mid, mid);
    ctx.scale(1.08, 0.78);
    const sclera = ctx.createRadialGradient(0, 0, size * 0.06, 0, 0, size * 0.3);
    sclera.addColorStop(0, "rgba(255,255,255,1)");
    sclera.addColorStop(0.62, "rgba(255,255,255,0.92)");
    sclera.addColorStop(0.88, "rgba(255,255,255,0.35)");
    sclera.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sclera;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.3, 0, Math.PI * 2);
    ctx.fill();

    const iris = ctx.createRadialGradient(-size * 0.03, -size * 0.02, 0, 0, 0, size * 0.15);
    iris.addColorStop(0, "rgba(255,255,255,0.9)");
    iris.addColorStop(0.45, "rgba(210,210,210,0.95)");
    iris.addColorStop(1, "rgba(36,28,32,0.92)");
    ctx.fillStyle = iris;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "rgba(10, 6, 8, 0.96)";
    ctx.beginPath();
    ctx.ellipse(mid, mid + size * 0.01, size * 0.072, size * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.ellipse(mid - size * 0.038, mid - size * 0.042, size * 0.03, size * 0.022, -0.45, 0, Math.PI * 2);
    ctx.fill();

    const tex = Texture.from(canvas);
    hardenTextureOnce(tex);
    tex.source.scaleMode = "linear";
    eyeTex = tex;
  }
  return eyeTex;
}

export function makeSoftEyeSprite(x = 0, y = 0, rx = 1, ry = 1): Sprite {
  const sprite = makeSoftFalloffSprite(softEyeTexture(), x, y, rx, ry);
  sprite.alpha = 0;
  return sprite;
}

export function makeSoftVignetteSprite(): Sprite {
  const sprite = makeSoftFalloffSprite(softVignetteTexture(), 0, 0, 1, 1);
  sprite.alpha = 0;
  return sprite;
}

export function placeSoftFalloff(sprite: Sprite, x: number, y: number, rx: number, ry: number): void {
  sprite.position.set(x, y);
  sprite.width = Math.max(1, rx * 2);
  sprite.height = Math.max(1, ry * 2);
}
