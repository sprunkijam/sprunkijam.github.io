/** Best-effort haptics. Missing on most iOS browsers (including Edge). */
export function haptic(pattern: number | number[] = 16): void {
  try {
    const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    if (typeof nav.vibrate !== "function") return;
    nav.vibrate(pattern);
  } catch {
    /* Edge / iOS WebKit often omit or reject vibrate — ignore */
  }
}
