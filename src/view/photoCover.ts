import type { PhotoOrient } from "./windowAspect";

/** 0–1 point in the JPEG that should stay on-screen (CSS object-position / sprite pivot). */
export type CoverPivot = { x: number; y: number };

/**
 * Exact CSS/Pixi cover scale: the smallest uniform scale that fills the box.
 * No extra zoom factor — matching-orientation JPEGs keep this crop small.
 */
export function coverScale(boxW: number, boxH: number, texW: number, texH: number): number {
  const tw = Math.max(1, texW);
  const th = Math.max(1, texH);
  return Math.max(boxW / tw, boxH / th);
}

function clamp(n: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Place a cover-fitted sprite so `pivot` stays visible, without uncovering the box.
 * `position` is the pivot point in box space (use with `sprite.anchor = pivot`).
 */
export function coverPivotPosition(
  boxW: number,
  boxH: number,
  texW: number,
  texH: number,
  scale: number,
  pivot: CoverPivot = { x: 0.5, y: 0.5 },
): { x: number; y: number } {
  const spriteW = Math.max(1, texW) * scale;
  const spriteH = Math.max(1, texH) * scale;
  const fx = pivot.x;
  const fy = pivot.y;
  const loX = boxW - spriteW * (1 - fx);
  const hiX = spriteW * fx;
  const loY = boxH - spriteH * (1 - fy);
  const hiY = spriteH * fy;
  return {
    x: clamp(boxW * fx, loX, hiX),
    y: clamp(boxH * fy, loY, hiY),
  };
}

/**
 * Phase 1 meadow: smiling tree face lives on the right of the landscape
 * (~75% × 55%). Portrait keeps a right-center bias so cover cannot hide it.
 * Other phases stay centered — no extra zoom, just cover.
 */
export const PHASE1_TREE_PIVOT: Record<PhotoOrient, CoverPivot> = {
  // Landscape phones are width-limited cover (crop top/bottom only). Bias up so
  // the smiling sun stays on-screen on iPhone Air landscape; tree stays fully
  // in frame on X. Portrait still biases right for the trunk smile.
  landscape: { x: 0.72, y: 0.4 },
  portrait: { x: 0.7, y: 0.5 },
};

export const CENTER_PIVOT: CoverPivot = { x: 0.5, y: 0.5 };

export function pivotForPhaseSet(set: number, orient: PhotoOrient): CoverPivot {
  return set === 1 ? PHASE1_TREE_PIVOT[orient] : CENTER_PIVOT;
}

export function cssObjectPosition(pivot: CoverPivot): string {
  return `${Math.round(pivot.x * 1000) / 10}% ${Math.round(pivot.y * 1000) / 10}%`;
}

/**
 * Cover the host box, expressed in GPU pixels, when the frozen buffer is
 * letterboxed. The canvas is the centered crop of that host-cover; a CSS
 * sibling with the same JPEG + object-position fills the letterbox bars
 * so Windows / Mac / Linux never show empty stage color.
 */
export function hostCoverInGpuSpace(
  gpuW: number,
  gpuH: number,
  hostW: number,
  hostH: number,
  texW: number,
  texH: number,
  pivot: CoverPivot,
): { scale: number; x: number; y: number; anchorX: number; anchorY: number } {
  const gw = Math.max(1, gpuW);
  const gh = Math.max(1, gpuH);
  const hw = Math.max(1, hostW);
  const hh = Math.max(1, hostH);
  const present = Math.min(hw / gw, hh / gh);
  const hostInGpuW = hw / present;
  const hostInGpuH = hh / present;
  const scale = coverScale(hostInGpuW, hostInGpuH, texW, texH);
  const pos = coverPivotPosition(hostInGpuW, hostInGpuH, texW, texH, scale, pivot);
  const originX = (hostInGpuW - gw) / 2;
  const originY = (hostInGpuH - gh) / 2;
  return {
    scale,
    x: pos.x - originX,
    y: pos.y - originY,
    anchorX: pivot.x,
    anchorY: pivot.y,
  };
}
