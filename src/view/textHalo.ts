/**
 * Subtle Pixi Text drop-shadow — baked into the glyph texture, not a Filter.
 * Omnidirectional-ish (tiny distance + blur) so HUD labels read without a black slab.
 */
export const TEXT_HALO = {
  alpha: 0.48,
  angle: Math.PI / 2,
  blur: 5,
  color: 0x140810,
  distance: 1.2,
} as const;
