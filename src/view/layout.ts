import type { SlotId, StemId } from "../types";
import { SLOT_IDS, TRAY_LOWER, TRAY_UPPER } from "../types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  w: number;
  h: number;
  portrait: boolean;
  safe: { t: number; r: number; b: number; l: number };
  slots: Record<SlotId, Rect>;
  /** Parallel to TRAY_STEMS order (upper then lower). */
  tray: Rect[];
  stageTop: number;
  stageBottom: number;
}

export function computeLayout(w: number, h: number): Layout {
  const portrait = h >= w * 0.95;
  const safe = {
    t: Math.max(52, Math.round(h * 0.08)),
    r: 10,
    b: Math.max(10, Math.round(h * 0.015)),
    l: 10,
  };
  // Extra tray height so under-plate name labels clear the next row / bottom safe area.
  const trayH = portrait
    ? Math.min(278, Math.max(200, h * 0.3))
    : Math.min(188, Math.max(136, Math.round(h * 0.37)));
  // Landscape needs extra top inset so five-across pads clear the hint/HUD.
  const stageTop = safe.t + (portrait ? 28 : 32);
  const stageBottom = h - trayH - safe.b - 2;
  const stageH = Math.max(120, stageBottom - stageTop);
  const slots = emptySlots();
  layoutPads(slots, w, stageTop, stageH, portrait);

  const tray = layoutTray(w, h, trayH, safe, portrait);
  return { w, h, portrait, safe, slots, tray, stageTop, stageBottom };
}

function emptySlots(): Record<SlotId, Rect> {
  const slots = {} as Record<SlotId, Rect>;
  for (const id of SLOT_IDS) slots[id] = { x: 0, y: 0, w: 0, h: 0 };
  return slots;
}

/** Kid-finger minimum so landscape can fall back from 5-across to 3+2. */
const MIN_PAD = 72;

/**
 * Portrait: 2 on top (tl/tr) + 3 on bottom (left/mid/right) so pads stay fat.
 * Landscape: 5 across when each pad stays tappable; otherwise the same 2+3 stack.
 */
function layoutPads(
  slots: Record<SlotId, Rect>,
  w: number,
  stageTop: number,
  stageH: number,
  portrait: boolean,
): void {
  if (portrait) {
    placeTwoPlusThree(slots, w, stageTop, stageH);
    return;
  }
  const gap = Math.max(8, w * 0.012);
  const size5 = Math.min((w - 24 - gap * 4) / 5, stageH * 0.9);
  if (size5 >= MIN_PAD) {
    // Bottom-align so the tip/HUD stay above the row on short landscape heights.
    const oy = stageTop + Math.max(0, stageH - size5);
    placeCenteredRow(slots, ["tl", "left", "mid", "right", "tr"], oy, size5, gap, w);
    return;
  }
  placeTwoPlusThree(slots, w, stageTop, stageH);
}

function placeTwoPlusThree(
  slots: Record<SlotId, Rect>,
  w: number,
  stageTop: number,
  stageH: number,
): void {
  const gap = 10;
  const size = Math.min((w - 24 - gap * 2) / 3, (stageH - gap) / 2);
  const blockH = size * 2 + gap;
  const oy = stageTop + Math.max(0, (stageH - blockH) / 2);
  placeCenteredRow(slots, ["tl", "tr"], oy, size, gap, w);
  placeCenteredRow(slots, ["left", "mid", "right"], oy + size + gap, size, gap, w);
}

function placeCenteredRow(
  slots: Record<SlotId, Rect>,
  ids: readonly SlotId[],
  y: number,
  size: number,
  gap: number,
  stageW: number,
): void {
  const span = size * ids.length + gap * Math.max(0, ids.length - 1);
  const ox = (stageW - span) / 2;
  ids.forEach((id, i) => {
    slots[id] = { x: ox + i * (size + gap), y, w: size, h: size };
  });
}

/**
 * Upper row: Oren, Pinki, Vineria, Jevin, Mr. Black.
 * Lower row: Red, Purple, Green, Orange, Blue Rainbow Friends.
 *
 * Each tray rect is a cell: `w` is the holder-plate size; `h` includes a
 * under-label gutter so names below the squares do not collide or clip.
 * `placeTray` parks the plate in the upper part of the cell (`y + w/2`).
 */
function layoutTray(
  w: number,
  h: number,
  trayH: number,
  safe: Layout["safe"],
  portrait: boolean,
): Rect[] {
  const pad = portrait ? 8 : 6;
  const upper = TRAY_UPPER.length;
  const lower = TRAY_LOWER.length;
  const trayTop = h - trayH - safe.b;
  const innerW = w - safe.l - safe.r;
  // Vertical room under each plate for STEM_LABEL (scales with plate size in placeTray).
  const labelRoom = portrait ? 22 : 18;

  if (portrait) {
    const rowGap = pad + 4;
    const usableH = trayH - pad * 2 - rowGap;
    const upperBudget = usableH * 0.44;
    const lowerBudget = usableH * 0.56;
    const lowerPlate = Math.min((innerW - pad * (lower - 1)) / lower, lowerBudget - labelRoom);
    const upperPlate = Math.min(
      (innerW - pad * (upper - 1)) / Math.max(upper, 3),
      upperBudget - labelRoom,
      lowerPlate * 1.05,
    );

    const lowerSpan = lowerPlate * lower + pad * (lower - 1);
    const upperSpan = upperPlate * upper + pad * (upper - 1);
    const lowerOx = (w - lowerSpan) / 2;
    const upperOx = (w - upperSpan) / 2;
    const upperCellH = upperPlate + labelRoom;
    const lowerCellH = lowerPlate + labelRoom;
    const upperOy = trayTop + pad + (upperBudget - upperCellH) / 2;
    const lowerOy = trayTop + pad + upperBudget + rowGap + (lowerBudget - lowerCellH) / 2;

    const rects: Rect[] = [];
    for (let i = 0; i < upper; i++) {
      rects.push({
        x: upperOx + i * (upperPlate + pad),
        y: upperOy,
        w: upperPlate,
        h: upperCellH,
      });
    }
    for (let i = 0; i < lower; i++) {
      rects.push({
        x: lowerOx + i * (lowerPlate + pad),
        y: lowerOy,
        w: lowerPlate,
        h: lowerCellH,
      });
    }
    return rects;
  }

  // Landscape: one row — Sprunki trio, Jevin, Black, then five Rainbow Friends.
  const count = upper + lower;
  const plate = Math.min((innerW - pad * (count - 1)) / count, trayH - 12 - labelRoom);
  const cellH = plate + labelRoom;
  const span = plate * count + pad * (count - 1);
  const ox = (w - span) / 2;
  const oy = trayTop + (trayH - cellH) / 2;
  const rects: Rect[] = [];
  for (let i = 0; i < count; i++) {
    rects.push({ x: ox + i * (plate + pad), y: oy, w: plate, h: cellH });
  }
  return rects;
}

/** Stem order matching `layout.tray` indices. */
export function trayStemAt(index: number): StemId | null {
  const all = [...TRAY_UPPER, ...TRAY_LOWER];
  return all[index] ?? null;
}

export function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}
