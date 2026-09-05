import { Assets, Texture } from "pixi.js";
import { detectPlatform } from "../ui/platformGuide";
import { WINDOWS_MAX_BACKING_PIXELS } from "./gpuBudget";

const hardened = new WeakSet<object>();
const photoCache = new Map<string, Promise<Texture>>();

/**
 * LINEAR filtering + mipmaps (once per GPU source) on mobile / Mac.
 * Windows skips mipmap generation — autoGenerateMipmaps re-uploads mip chains
 * and contributes to ANGLE/D3D RAM climb on Chrome/Edge.
 */
export function hardenTextureOnce(tex: Texture): void {
  const src = tex.source;
  if (!src || hardened.has(src)) return;
  hardened.add(src);
  src.scaleMode = "linear";
  const family = detectPlatform().family;
  src.autoGenerateMipmaps = family !== "windows";
}

/**
 * Runtime GPU-upload size for a decoded JPEG. Files in public/art/ stay the
 * original bytes (6000×4000 landscapes stay 6000×4000 on disk). Frozen Windows
 * only: a 6000×4000 RGBA upload is ~72MB and blows the desktop backing budget,
 * so drawImage into a budget canvas first. Phones / Mac / Linux upload the
 * full bitmap.
 */
export function windowsPhotoUploadSize(
  srcW: number,
  srcH: number,
  maxPixels = WINDOWS_MAX_BACKING_PIXELS,
): { w: number; h: number; scaled: boolean } {
  const w = Math.max(1, Math.round(srcW));
  const h = Math.max(1, Math.round(srcH));
  const area = w * h;
  if (area <= maxPixels) return { w, h, scaled: false };
  const k = Math.sqrt(maxPixels / area);
  let outW = Math.max(1, Math.round(w * k));
  let outH = Math.max(1, Math.round(h * k));
  // Rounding can nudge a hair over the pixel budget — shrink the longer edge.
  while (outW * outH > maxPixels && (outW > 1 || outH > 1)) {
    if (outW >= outH && outW > 1) outW -= 1;
    else if (outH > 1) outH -= 1;
    else break;
  }
  return { w: outW, h: outH, scaled: true };
}

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`photo failed to load: ${url}`));
    img.src = url;
  });
}

function canvasFromImage(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable for Windows photo downsample");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

/**
 * Load a stage/title JPEG as a Pixi texture.
 * Windows: cap the GPU upload to the desktop backing budget (files unchanged).
 * Everywhere else: full decoded bitmap via Assets.
 */
export function loadPhotoTexture(url: string): Promise<Texture> {
  const hit = photoCache.get(url);
  if (hit) return hit;
  const pending = (async () => {
    const family = detectPlatform().family;
    if (family !== "windows") {
      const tex = await Assets.load<Texture>(url);
      hardenTextureOnce(tex);
      return tex;
    }
    const img = await loadHtmlImage(url);
    const want = windowsPhotoUploadSize(img.naturalWidth, img.naturalHeight);
    const source = want.scaled ? canvasFromImage(img, want.w, want.h) : img;
    const tex = Texture.from(source);
    hardenTextureOnce(tex);
    return tex;
  })();
  photoCache.set(url, pending);
  pending.catch(() => {
    photoCache.delete(url);
  });
  return pending;
}
