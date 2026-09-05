/** Portrait / scythe paths — kept free of Pixi so the title can warm art without loading the renderer. */
import type { StemId } from "../types";
import { artUrl } from "../publicUrl";

export const PORTRAIT_URLS: Partial<Record<StemId, string>> = {
  oren: artUrl("oren-portrait.jpeg"),
  pinki: artUrl("pinki-portrait.jpeg"),
  vineria: artUrl("vineria-portrait.jpeg"),
  black: artUrl("black-portrait.jpeg"),
  jevin: artUrl("jevin-portrait.jpeg"),
  red: artUrl("red-portrait.jpeg"),
  purple: artUrl("purple-portrait.jpeg"),
  green: artUrl("green-portrait.jpeg"),
  orange: artUrl("orange-portrait.jpeg"),
  blue: artUrl("blue-portrait.jpeg"),
};

export const HORROR_PORTRAIT_URLS: Partial<Record<StemId, string>> = {
  oren: artUrl("oren-portrait-horror.jpeg"),
  pinki: artUrl("pinki-portrait-horror.jpeg"),
  vineria: artUrl("vineria-portrait-horror.jpeg"),
  black: artUrl("black-portrait-horror.jpeg"),
  jevin: artUrl("jevin-portrait-horror.jpeg"),
  red: artUrl("red-portrait-horror.jpeg"),
  purple: artUrl("purple-portrait-horror.jpeg"),
  green: artUrl("green-portrait-horror.jpeg"),
  orange: artUrl("orange-portrait-horror.jpeg"),
  blue: artUrl("blue-portrait-horror.jpeg"),
};

export const DEEP_HORROR_PORTRAIT_URLS: Partial<Record<StemId, string>> = {
  green: artUrl("green-portrait-phase10.jpeg"),
};

export const JEVIN_SCYTHE_URL = artUrl("jevin-scythe.png");
