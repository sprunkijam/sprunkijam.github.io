export type StemId =
  | "oren"
  | "pinki"
  | "vineria"
  | "black"
  | "jevin"
  | "red"
  | "purple"
  | "green"
  | "orange"
  | "blue";

/** Five glowing DROP pads. Mr. Black sits on these like everyone else. */
export const SLOT_IDS = ["tl", "tr", "left", "mid", "right"] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export type Phase = 1 | 2 | 3 | 10 | 100 | 1000 | 100000;

/** Friends that sit on the five stage pads (including Mr. Black). */
export const PERFORMER_STEMS: StemId[] = [
  "oren",
  "pinki",
  "vineria",
  "jevin",
  "black",
  "red",
  "purple",
  "green",
  "orange",
  "blue",
];

/**
 * Tray order for layout:
 * Upper row — Sprunki trio + Jevin + Mr. Black.
 * Lower row — Red, Purple, Green, Orange, Blue Rainbow Friends.
 */
export const TRAY_UPPER: StemId[] = ["oren", "pinki", "vineria", "jevin", "black"];
export const TRAY_LOWER: StemId[] = ["red", "purple", "green", "orange", "blue"];
export const TRAY_STEMS: StemId[] = [...TRAY_UPPER, ...TRAY_LOWER];

export const SKIP_PHASES: Phase[] = [2, 10, 100, 1000, 100000];

/** Kid-friendly name labels. Spell Pinki (not Pinky). */
export const STEM_LABEL: Record<StemId, string> = {
  oren: "Oren",
  pinki: "Pinki",
  vineria: "Vineria",
  black: "Mr. Black",
  jevin: "Jevin",
  red: "Red",
  purple: "Purple",
  green: "Green",
  orange: "Orange",
  blue: "Blue",
};

/** A stage pad can hold this many distinct friends at once. */
export const PAD_STEM_CAP = 3;

/** Stable pair key for named merges (order-independent). */
export function mergeKey(a: StemId, b: StemId): string {
  return a < b ? `${a}+${b}` : `${b}+${a}`;
}

/**
 * Fun kid labels for a few favorite fusions. Generic fallback is "A+B".
 * Mr. Black never merges — callers must skip black.
 */
const NAMED_MERGES: Record<string, string> = {
  "oren+pinki": "Oren+Pinki",
  "oren+vineria": "Oren+Vineria",
  "pinki+vineria": "Pinki+Vineria",
  "jevin+oren": "Jevin+Oren",
  "jevin+pinki": "Jevin+Pinki",
  "jevin+vineria": "Jevin+Vineria",
  "purple+red": "Red+Purple",
  "orange+red": "Red+Orange",
  "blue+red": "Red+Blue",
  "green+red": "Red+Green",
  "blue+purple": "Purple+Blue",
  "orange+purple": "Purple+Orange",
  "green+purple": "Purple+Green",
  "green+orange": "Green+Orange",
  "blue+green": "Green+Blue",
  "blue+orange": "Orange+Blue",
};

export function mergeLabel(a: StemId, b: StemId): string {
  const key = mergeKey(a, b);
  return NAMED_MERGES[key] ?? `${STEM_LABEL[a]}+${STEM_LABEL[b]}`;
}

/** Pad chip label for a seated group (named fuse for two, `A+B+C` for a trio). */
export function groupLabel(stems: readonly StemId[]): string {
  if (stems.length === 2) return mergeLabel(stems[0]!, stems[1]!);
  return stems.map((id) => STEM_LABEL[id]).join("+");
}

/**
 * Two-friend fuse art (never Mr. Black, never the same stem).
 * A non-mergeable second friend can still *stack* on the pad without fuse art.
 * Mr. Black never shares a pad — drop replaces / sits alone.
 */
export function canMerge(a: StemId, b: StemId): boolean {
  return a !== b && a !== "black" && b !== "black";
}

export function bpmForPhase(phase: Phase): number {
  switch (phase) {
    case 1:
      return 110;
    case 2:
      return 90;
    case 3:
      return 80;
    case 10:
      return 86;
    case 100:
      return 76;
    case 1000:
      return 70;
    case 100000:
      return 64;
  }
}

export function mutationForPhase(phase: Phase): number {
  switch (phase) {
    case 1:
      return 0;
    case 2:
      return 0.28;
    case 3:
      return 0.48;
    case 10:
      return 0.58;
    case 100:
      return 0.72;
    case 1000:
      return 0.86;
    case 100000:
      return 1;
  }
}

export function isHorror(phase: Phase): boolean {
  return phase !== 1;
}

/** Skip-dial / high chaos phases — Green (and future stems) may use a third portrait tier. */
export function isDeepHorror(phase: Phase): boolean {
  return phase === 10 || phase === 100 || phase === 1000 || phase === 100000;
}
