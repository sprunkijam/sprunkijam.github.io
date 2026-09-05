import { Assets, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import type { Phase, StemId } from "../types";
import { canMerge, groupLabel, isDeepHorror, isHorror, mergeLabel, PAD_STEM_CAP, STEM_LABEL } from "../types";
import { makeSoftShadowSprite } from "./softFalloff";
import { TEXT_HALO } from "./textHalo";
import {
  DEEP_HORROR_PORTRAIT_URLS,
  HORROR_PORTRAIT_URLS,
  PORTRAIT_URLS,
} from "./artUrls";
import { hardenTextureOnce } from "./textures";

export {
  DEEP_HORROR_PORTRAIT_URLS,
  HORROR_PORTRAIT_URLS,
  JEVIN_SCYTHE_URL,
  PORTRAIT_URLS,
} from "./artUrls";

export interface CharacterView {
  root: Container;
  id: StemId;
  /** All stems on this pad (1–3). Length 2 with fuse art when canMerge. */
  stems: StemId[];
  setMood(phase: Phase): void;
  tick(time: number, pulse: number): void;
  /** Soft pad-drop settle (shadow + squash ease). No-op if already seated. */
  land(): void;
  /** Live idle-rock radians (one per visible friend; empty while not rocking). */
  rockAngles(): number[];
  /** Friend-colored ground halo alpha (seated glow). */
  glowAlpha(): number;
}

/** Same home-row sway the tray rocker uses — reuse for seated friends. */
export const IDLE_ROCK_SPEED = 2;
export const IDLE_ROCK_AMP = 0.04;

export function idleRockSeed(id: string): number {
  return id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
}

export function idleRockAngle(time: number, id: string): number {
  return Math.sin(time * IDLE_ROCK_SPEED + idleRockSeed(id)) * IDLE_ROCK_AMP;
}

/** Resting seated halo — a bit more opaque than the tray plate pool. */
export const SEATED_GLOW_STRENGTH = 0.96;
/** Tray / home-row plate shadow (shared helper, left as-is). */
export const TRAY_GLOW_STRENGTH = 0.78;

/** Tray chip with a separate art plate so labels stay upright while art rocks. */
export interface TrayIconView {
  root: Container;
  view: CharacterView;
  /** Rotate this (art + plate), not `root` — keeps the name label readable/crisp. */
  rocker: Container;
  setMood(phase: Phase): void;
}

type PortraitFrame = { scale: number; offsetX: number; offsetY: number };

/**
 * Per-stem cover framing inside the round-rect chip (Phase 1 / default).
 * scale > 1 zooms in (cover-fit).
 * offsetY > 0 shifts art down so more of the top of the JPEG sits in the chip
 * (hats / crowns) — the bottom of the art is what gets clipped.
 */
export const PORTRAIT_FRAME: Partial<Record<StemId, PortraitFrame>> = {
  // Full-body meadow / horror squares — face + torso fill the chip.
  oren: { scale: 0.96, offsetX: 0, offsetY: 0.02 },
  pinki: { scale: 0.96, offsetX: 0, offsetY: 0.02 },
  vineria: { scale: 0.92, offsetX: 0, offsetY: 0.0 },
  jevin: { scale: 0.92, offsetX: 0, offsetY: 0.0 },
  black: { scale: 0.9, offsetX: 0, offsetY: 0.02 },
  // Rainbow Friends meadow + horror JPEGs — same cover framing as Sprunki chips.
  red: { scale: 0.94, offsetX: 0, offsetY: 0.02 },
  purple: { scale: 0.96, offsetX: 0, offsetY: 0.0 },
  green: { scale: 0.96, offsetX: 0, offsetY: 0.0 },
  orange: { scale: 0.94, offsetX: 0, offsetY: 0.02 },
  // Phase 1 Blue wears a small on-head crown — keep the snug meadow crop.
  blue: { scale: 0.98, offsetX: 0, offsetY: 0.02 },
};

/**
 * Optional Phase 2 / 3 frame overrides when horror art needs a different crop.
 * Blue's floating yellow crown sits above the head — zoom out + shift down.
 */
export const HORROR_PORTRAIT_FRAME: Partial<Record<StemId, PortraitFrame>> = {
  blue: { scale: 0.8, offsetX: 0, offsetY: 0.1 },
};

/**
 * Optional Phase 10+ frame overrides for deep-horror art.
 * Green hangs upside-down — box-head/face sits low in the JPEG; shift up + zoom out.
 */
export const DEEP_HORROR_PORTRAIT_FRAME: Partial<Record<StemId, PortraitFrame>> = {
  green: { scale: 0.74, offsetX: 0, offsetY: -0.14 },
};

/**
 * Resolved cover frame for tray/stage chips (tests / tooling).
 * Pass `true` for Phase 2 horror crop, or a Phase number for phase-aware framing.
 */
export function portraitFrameFor(
  id: StemId,
  horrorOrPhase: boolean | Phase = false,
): PortraitFrame {
  if (typeof horrorOrPhase === "number") {
    if (isDeepHorror(horrorOrPhase)) {
      const deep = DEEP_HORROR_PORTRAIT_FRAME[id];
      if (deep) return deep;
    }
    if (isHorror(horrorOrPhase)) {
      const horrorFrame = HORROR_PORTRAIT_FRAME[id];
      if (horrorFrame) return horrorFrame;
    }
    return PORTRAIT_FRAME[id] ?? { scale: 1, offsetX: 0, offsetY: 0 };
  }
  if (horrorOrPhase) {
    const horrorFrame = HORROR_PORTRAIT_FRAME[id];
    if (horrorFrame) return horrorFrame;
  }
  return PORTRAIT_FRAME[id] ?? { scale: 1, offsetX: 0, offsetY: 0 };
}

/** Friend fill colors — also the tint for each chip / tray-plate shadow pool. */
export const STEM_COLOR: Record<StemId, number> = {
  oren: 0xf08a2a,
  pinki: 0xff7eb3,
  vineria: 0x6edb9a,
  black: 0x16141c,
  jevin: 0x1a2a9a,
  red: 0xe23a2a,
  purple: 0x9b4dff,
  green: 0x3dcc6a,
  orange: 0xff8a2a,
  blue: 0x2a4cff,
};

function mixStemColors(...ids: StemId[]): number {
  if (ids.length === 0) return 0xffffff;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const id of ids) {
    const c = STEM_COLOR[id];
    r += (c >> 16) & 255;
    g += (c >> 8) & 255;
    b += c & 255;
  }
  const n = ids.length;
  return ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n));
}



function portraitUrlForPhase(id: StemId, phase: Phase): string | undefined {
  if (phase === 1) return PORTRAIT_URLS[id];
  if (isDeepHorror(phase) && DEEP_HORROR_PORTRAIT_URLS[id]) {
    return DEEP_HORROR_PORTRAIT_URLS[id];
  }
  return HORROR_PORTRAIT_URLS[id] ?? PORTRAIT_URLS[id];
}

/**
 * Configured portrait path for tests / tooling (does not require Assets cache).
 * Pass `true` for Phase 2 horror JPEG, or a Phase number for phase-aware paths
 * (Green Phase 10+ → green-portrait-phase10.jpeg).
 */
export function portraitUrlFor(
  id: StemId,
  horrorOrPhase: boolean | Phase = false,
): string | undefined {
  if (typeof horrorOrPhase === "number") return portraitUrlForPhase(id, horrorOrPhase);
  if (horrorOrPhase) return HORROR_PORTRAIT_URLS[id] ?? PORTRAIT_URLS[id];
  return PORTRAIT_URLS[id];
}

/** True when a dedicated Phase 2 / 3 horror JPEG is wired for this stem. */
export function hasHorrorPortraitConfigured(id: StemId): boolean {
  return Boolean(HORROR_PORTRAIT_URLS[id]);
}

/** True when a dedicated Phase 10+ deep-horror JPEG is wired for this stem. */
export function hasDeepHorrorPortraitConfigured(id: StemId): boolean {
  return Boolean(DEEP_HORROR_PORTRAIT_URLS[id]);
}

export async function preloadPortraits(): Promise<void> {
  const urls = [
    ...Object.values(PORTRAIT_URLS),
    ...Object.values(HORROR_PORTRAIT_URLS),
    ...Object.values(DEEP_HORROR_PORTRAIT_URLS),
  ].filter((u): u is string => Boolean(u));
  // Load individually so one missing JPEG does not blank the whole tray.
  await Promise.all(
    urls.map(async (url) => {
      try {
        const tex = await Assets.load<Texture>(url);
        hardenTextureOnce(tex);
      } catch (err) {
        console.warn("Portrait failed to load", url, err);
      }
    }),
  );
}

function cachedTexture(url: string | undefined): Texture | null {
  if (!url) return null;
  try {
    if (!Assets.cache.has(url)) return null;
    const tex = Assets.get<Texture>(url);
    if (tex) return tex;
  } catch {
    /* missing */
  }
  return null;
}

/** Phase-aware portrait texture with deep → horror → Phase 1 fallbacks. */
function portraitTexture(id: StemId, phase: Phase = 1): Texture | null {
  const primary = portraitUrlForPhase(id, phase);
  const candidates: (string | undefined)[] = [primary];
  if (isDeepHorror(phase)) candidates.push(HORROR_PORTRAIT_URLS[id]);
  if (isHorror(phase)) candidates.push(PORTRAIT_URLS[id]);
  for (const candidate of candidates) {
    const tex = cachedTexture(candidate);
    if (tex) return tex;
  }
  return null;
}

function hasHorrorPortrait(id: StemId): boolean {
  return Boolean(cachedTexture(HORROR_PORTRAIT_URLS[id]));
}

function hasDeepHorrorPortrait(id: StemId): boolean {
  return Boolean(cachedTexture(DEEP_HORROR_PORTRAIT_URLS[id]));
}

/** True when this phase should show dedicated non–Phase-1 art (skip cool-tint wash). */
function usesDedicatedHorrorArt(id: StemId, phase: Phase): boolean {
  if (!isHorror(phase)) return false;
  if (isDeepHorror(phase) && hasDeepHorrorPortrait(id)) return true;
  return hasHorrorPortrait(id);
}

function applyPortraitFrame(
  sprite: Sprite,
  portrait: Texture,
  diameter: number,
  id: StemId,
  phase: Phase = 1,
): void {
  const frame = portraitFrameFor(id, phase);
  const cover =
    Math.max(diameter / portrait.width, diameter / textureHeight(portrait)) * frame.scale;
  sprite.scale.set(cover);
  sprite.position.set(frame.offsetX * diameter, frame.offsetY * diameter);
}

export function createCharacter(
  id: StemId,
  size: number,
  opts: { idleRock?: boolean; seatedGlow?: boolean } = {},
): CharacterView {
  const idleRock = opts.idleRock !== false;
  const seatedGlow = opts.seatedGlow === true;
  const root = new Container();
  const body = new Container();
  const gfx = new Graphics();
  const moodFx = new Graphics();

  const portrait = portraitTexture(id, 1);
  const usePortrait = Boolean(portrait);

  let sprite: Sprite | null = null;
  let mask: Graphics | null = null;
  const diameter = size * 0.97;
  const radius = diameter / 2;
  const traySoft = size <= 100;
  const bobAmp = size * (traySoft ? 0.014 : 0.03);
  const ground = makeGroundShadow(
    usePortrait ? radius : size * 0.42,
    bobAmp,
    STEM_COLOR[id],
    seatedGlow ? SEATED_GLOW_STRENGTH : TRAY_GLOW_STRENGTH,
  );

  if (usePortrait && portrait) {
    // Nearly fill the size box so seated chips cover almost the whole DROP pad.
    sprite = new Sprite(portrait);
    sprite.anchor.set(0.5);
    sprite.roundPixels = false;
    applyPortraitFrame(sprite, portrait, diameter, id, 1);

    mask = new Graphics();
    // Soft-rounded plate that reads as a tray/stage face chip.
    mask.roundRect(-radius, -radius, diameter, diameter, diameter * 0.28);
    mask.fill(0xffffff);
    sprite.mask = mask;

    body.addChild(sprite, mask, moodFx);
  } else {
    body.addChild(gfx, moodFx);
  }

  root.addChild(ground.gfx, body);

  let phase: Phase = 1;

  const draw = (): void => {
    const horror = isHorror(phase);
    if (usePortrait && sprite) {
      const useHorrorArt = usesDedicatedHorrorArt(id, phase);
      const next = portraitTexture(id, phase);
      if (next) {
        if (sprite.texture !== next) sprite.texture = next;
        // Re-apply every mood swap — Blue crown / Green phase10 frames differ by phase.
        applyPortraitFrame(sprite, next, diameter, id, phase);
      }
      applyPortraitMood(sprite, moodFx, size, horror, id, useHorrorArt);
      return;
    }
    gfx.clear();
    moodFx.clear();
    const s = size * 0.42;
    if (id === "oren") drawOren(gfx, s, horror, phase);
    else if (id === "pinki") drawPinki(gfx, s, horror, phase);
    else if (id === "vineria") drawVineria(gfx, s, horror, phase);
    else if (id === "black") drawBlack(gfx, s, horror, phase);
    else drawExtra(gfx, id, s, horror);
  };

  draw();

  return {
    root,
    id,
    stems: [id],
    setMood(next) {
      phase = next;
      draw();
    },
    land() {
      ground.land();
    },
    rockAngles() {
      return idleRock ? [body.rotation] : [];
    },
    glowAlpha() {
      return ground.alpha();
    },
    tick(time, pulse) {
      const bob =
        Math.sin(time * (id === "vineria" && isHorror(phase) ? 18 : 5) + hash(id)) * bobAmp;
      const landEase = ground.tick(time, bob);
      const squash = 1 + pulse * (traySoft ? 0.03 : id === "oren" ? 0.1 : 0.05);
      body.y = bob;
      body.rotation = idleRock ? idleRockAngle(time, id) : 0;
      const dropSquash = 1 - (1 - landEase) * 0.08;
      const dropWiden = 1 + (1 - landEase) * 0.06;
      body.scale.set(
        dropWiden + (id === "black" && isHorror(phase) && !traySoft ? 0.04 : 0),
        squash * dropSquash,
      );
    },
  };
}

/**
 * Kid-friendly hybrid of two Sprunkies: side-by-side portrait/procedural blend,
 * soft glow, "A+B" label. Never redraws portrait faces — only composites existing art.
 */
export function createMergedCharacter(a: StemId, b: StemId, size: number): CharacterView {
  const root = new Container();
  const body = new Container();
  const glow = new Graphics();
  const label = new Text({
    text: mergeLabel(a, b),
    style: {
      fill: 0xfff6e0,
      fontSize: Math.max(11, size * 0.11),
      fontWeight: "900",
      fontFamily: "ui-rounded, system-ui",
      align: "center",
      dropShadow: TEXT_HALO,
    },
  });
  label.anchor.set(0.5);
  // Light on-chip merge tag — do not steal pad space below the portrait.
  label.y = size * 0.34;

  const diameter = size * 0.97;
  const radius = diameter / 2;
  const half = diameter / 2;

  const shadow = makeGroundShadow(radius, size * 0.025, mixStemColors(a, b), SEATED_GLOW_STRENGTH);
  const faces = new Container();
  const mask = new Graphics();
  mask.roundRect(-radius, -radius, diameter, diameter, diameter * 0.28);
  mask.fill(0xffffff);

  const left = makeHalfFace(a, size * 0.72, -half * 0.28);
  const right = makeHalfFace(b, size * 0.72, half * 0.28);
  faces.addChild(left, right);
  faces.mask = mask;

  // Soft seam glow between the two halves.
  const seam = new Graphics();
  seam.rect(-3, -radius * 0.85, 6, diameter * 0.85);
  seam.fill({ color: 0xffe566, alpha: 0.35 });

  glow.circle(0, 0, radius * 1.08);
  glow.stroke({ width: 5, color: 0x9b7cff, alpha: 0.55 });
  glow.circle(0, 0, radius * 1.18);
  glow.stroke({ width: 3, color: 0xffe566, alpha: 0.35 });

  body.addChild(faces, mask, seam, glow);
  root.addChild(shadow.gfx, body, label);

  let phase: Phase = 1;
  const moodFx = new Graphics();
  body.addChild(moodFx);

  const applyHalves = (): void => {
    setHalfMood(left, a, phase);
    setHalfMood(right, b, phase);
  };

  const drawMood = (): void => {
    moodFx.clear();
    const horror = isHorror(phase);
    // Real horror art on either half → skip the old cool-tint wash frame.
    const realArt = usesDedicatedHorrorArt(a, phase) || usesDedicatedHorrorArt(b, phase);
    if (!horror || realArt) return;
    moodFx.roundRect(-radius, -radius, diameter, diameter, diameter * 0.28);
    moodFx.fill({ color: 0x140820, alpha: 0.12 });
    moodFx.roundRect(-radius, -radius, diameter, diameter, diameter * 0.28);
    moodFx.stroke({ width: Math.max(3, size * 0.03), color: 0x5a2048, alpha: 0.7 });
  };
  applyHalves();
  drawMood();

  return {
    root,
    id: a,
    stems: [a, b],
    setMood(next) {
      phase = next;
      applyHalves();
      drawMood();
    },
    land() {
      shadow.land();
    },
    rockAngles() {
      return [body.rotation];
    },
    glowAlpha() {
      return shadow.alpha();
    },
    tick(time, pulse) {
      const bob = Math.sin(time * 5.5 + hash(a) + hash(b)) * (size * 0.025);
      const landEase = shadow.tick(time, bob);
      body.y = bob;
      body.rotation = idleRockAngle(time, a);
      const dropSquash = 1 - (1 - landEase) * 0.08;
      body.scale.set(1 + (1 - landEase) * 0.05, (1 + pulse * 0.06) * dropSquash);
      // Pulse alpha on the prebuilt glow — never clear/rebuild Graphics every tick.
      glow.alpha = (0.7 + pulse * 0.3) * (0.55 + 0.45 * landEase);
      label.alpha = 0.95;
    },
  };
}

/**
 * Fan/offset stack so 2 (non-fuse) or 3 friends all read as distinct portraits.
 * `createMergedCharacter` is 2-only — a trio must not look like a 2-half fuse.
 */
export function createStackedCharacters(stems: StemId[], size: number): CharacterView {
  const ids = stems.slice(0, PAD_STEM_CAP);
  const n = Math.max(1, ids.length);
  const root = new Container();
  const body = new Container();
  const glow = new Graphics();
  const label = new Text({
    text: groupLabel(ids),
    style: {
      fill: 0xfff6e0,
      fontSize: Math.max(10, size * (n >= 3 ? 0.085 : 0.11)),
      fontWeight: "900",
      fontFamily: "ui-rounded, system-ui",
      align: "center",
      dropShadow: TEXT_HALO,
    },
  });
  label.anchor.set(0.5);
  label.y = size * (n >= 3 ? 0.4 : 0.34);

  const diameter = size * 0.97;
  const radius = diameter / 2;
  const shadow = makeGroundShadow(radius, size * 0.025, mixStemColors(...ids), SEATED_GLOW_STRENGTH);

  const childSize = size * (n >= 3 ? 0.56 : 0.7);
  const spread = size * (n >= 3 ? 0.32 : 0.26);
  const poses: { x: number; y: number }[] =
    n >= 3
      ? [
          { x: -spread, y: -spread * 0.2 },
          { x: spread, y: -spread * 0.14 },
          { x: 0, y: spread * 0.26 },
        ]
      : [
          { x: -spread, y: spread * 0.04 },
          { x: spread, y: -spread * 0.04 },
        ];

  const faces: CharacterView[] = [];
  for (let i = 0; i < n; i++) {
    const face = createCharacter(ids[i]!, childSize, { idleRock: true, seatedGlow: true });
    face.root.eventMode = "none";
    const pose = poses[i] ?? { x: 0, y: 0 };
    face.root.position.set(pose.x, pose.y);
    body.addChild(face.root);
    faces.push(face);
  }

  glow.circle(0, 0, radius * 1.12);
  glow.stroke({ width: 4, color: 0x9b7cff, alpha: 0.4 });
  glow.circle(0, 0, radius * 1.22);
  glow.stroke({ width: 3, color: 0xffe566, alpha: 0.28 });
  body.addChild(glow);
  root.addChild(shadow.gfx, body, label);

  return {
    root,
    id: ids[0]!,
    stems: [...ids],
    setMood(next) {
      for (const face of faces) face.setMood(next);
    },
    land() {
      shadow.land();
      for (const face of faces) face.land();
    },
    rockAngles() {
      return faces.flatMap((face) => face.rockAngles());
    },
    glowAlpha() {
      return shadow.alpha();
    },
    tick(time, pulse) {
      const landEase = shadow.tick(time, 0);
      const dropSquash = 1 - (1 - landEase) * 0.08;
      body.scale.set(1 + (1 - landEase) * 0.05, dropSquash);
      glow.alpha = (0.65 + pulse * 0.35) * (0.55 + 0.45 * landEase);
      label.alpha = 0.95;
      // Each friend bobs and rocks on their own clock so a trio does not read as one sprite.
      for (const face of faces) face.tick(time, pulse);
    },
  };
}

/** Seat/ghost view: 1 portrait, 2-friend fuse art, or a fan of up to 3. */
export function createPadCharacter(stems: StemId[], size: number): CharacterView {
  if (stems.length <= 1) return createCharacter(stems[0]!, size, { idleRock: true, seatedGlow: true });
  if (stems.length === 2 && canMerge(stems[0]!, stems[1]!)) {
    return createMergedCharacter(stems[0]!, stems[1]!, size);
  }
  return createStackedCharacters(stems, size);
}

function makeHalfFace(id: StemId, size: number, x: number): Container {
  const wrap = new Container();
  wrap.x = x;
  const tex = portraitTexture(id, 1);
  if (tex) {
    const spr = new Sprite(tex);
    spr.anchor.set(0.5);
    spr.roundPixels = false;
    const diameter = size * 0.95;
    applyPortraitFrame(spr, tex, diameter, id, 1);
    // Stash diameter for mood swaps.
    (wrap as Container & { __diameter?: number }).__diameter = diameter;
    wrap.addChild(spr);
  } else {
    const mini = createCharacter(id, size);
    mini.root.scale.set(0.85);
    wrap.addChild(mini.root);
  }
  return wrap;
}

function setHalfMood(wrap: Container, id: StemId, phase: Phase): void {
  const horror = isHorror(phase);
  const useHorrorArt = usesDedicatedHorrorArt(id, phase);
  const diameter =
    (wrap as Container & { __diameter?: number }).__diameter ?? 64;
  for (const child of wrap.children) {
    if (child instanceof Sprite) {
      const next = portraitTexture(id, phase);
      if (next) {
        if (child.texture !== next) child.texture = next;
        applyPortraitFrame(child, next, diameter, id, phase);
      }
      if (useHorrorArt || !horror) {
        child.tint = 0xffffff;
        child.alpha = 1;
      } else {
        child.tint =
          id === "pinki" ? 0xc9b0d8 : id === "vineria" ? 0xb8c8c0 : id === "black" ? 0xa8b0c8 : 0xb8c0d0;
        child.alpha = 0.94;
      }
    }
  }
}

function textureHeight(tex: Texture): number {
  return tex.height || tex.frame?.height || 1;
}

/**
 * Soften faces for horror when no dedicated horror JPEG exists —
 * cooler/darker tint + a simple frame/vignette overlay.
 * When real horror art is swapped in, skip the tint wash.
 */
function applyPortraitMood(
  sprite: Sprite,
  moodFx: Graphics,
  size: number,
  horror: boolean,
  id: StemId,
  usingHorrorArt: boolean,
): void {
  moodFx.clear();
  const r = size * 0.485;
  if (!horror || usingHorrorArt) {
    sprite.tint = 0xffffff;
    sprite.alpha = 1;
    // Very subtle frame on real horror art so chips still read as "scary phase".
    if (horror && usingHorrorArt) {
      moodFx.roundRect(-r, -r, r * 2, r * 2, r * 0.56);
      moodFx.stroke({ width: Math.max(2, size * 0.02), color: 0x5a2048, alpha: 0.35 });
    }
    return;
  }
  // Cooler / dusk tint — stand-in when a horror JPEG failed to preload.
  const tint =
    id === "pinki"
      ? 0xc9b0d8
      : id === "vineria"
        ? 0xb8c8c0
        : id === "black" || id === "jevin"
          ? 0xa8b0c8
          : 0xb8c0d0;
  sprite.tint = tint;
  sprite.alpha = id === "black" ? 0.9 : 0.94;
  moodFx.roundRect(-r, -r, r * 2, r * 2, r * 0.56);
  moodFx.fill({ color: 0x140820, alpha: id === "black" ? 0.1 : 0.14 });
  moodFx.roundRect(-r, -r, r * 2, r * 2, r * 0.56);
  moodFx.stroke({ width: Math.max(3, size * 0.03), color: 0x5a2048, alpha: 0.75 });
  moodFx.circle(0, 0, r * 0.98);
  moodFx.stroke({ width: Math.max(2, size * 0.018), color: 0x180814, alpha: 0.4 });
}

function hash(id: string): number {
  return id.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 0.17;
}

/**
 * Ground shadow that stays put while the body bobs, with smoothstep land
 * and exponential lift easing (no per-frame Graphics rebuild). One radial
 * falloff sprite — omnidirectional so it peeks past every chip edge, with a
 * slight oval/ground bias (not a thin under-ellipse).
 */
function makeGroundShadow(
  chipR: number,
  bobAmp: number,
  tint: number,
  strength = TRAY_GLOW_STRENGTH,
): { gfx: Container; land: () => void; tick: (time: number, bodyY: number) => number; alpha: () => number } {
  const gfx = new Container();
  gfx.eventMode = "none";
  gfx.alpha = strength;
  gfx.scale.set(1, 1);
  // White bake + friend tint (black bake cannot tint). Peek past every chip edge.
  const pool = makeSoftShadowSprite(0, chipR * 0.2, chipR * 1.62, chipR * 1.38);
  pool.tint = tint;
  gfx.addChild(pool);
  let liftS = 0;
  let landT = 1;
  let lastT = 0;
  return {
    gfx,
    land() {
      landT = 0;
    },
    alpha() {
      return gfx.alpha;
    },
    tick(time, bodyY) {
      const dt = lastT ? Math.min(0.05, Math.max(0.001, time - lastT)) : 0.016;
      lastT = time;
      if (landT < 1) landT = Math.min(1, landT + dt / 0.38);
      const landEase = landT * landT * (3 - 2 * landT);
      const lift = Math.max(0, Math.min(1, -bodyY / Math.max(1, bobAmp)));
      liftS += (lift - liftS) * (1 - Math.exp(-dt * 8));
      // Soft halo — strength is rest opacity (seated reads more than tray).
      gfx.alpha = (0.42 + 0.58 * (1 - liftS)) * (0.22 + 0.78 * landEase) * strength;
      gfx.scale.set(1.08 - liftS * 0.1, 1.02 - liftS * 0.12);
      return landEase;
    },
  };
}

function blob(g: Graphics, x: number, y: number, r: number, color: number): void {
  g.circle(x, y, r);
  g.fill(color);
}

function eye(g: Graphics, x: number, y: number, r: number, laid: boolean, horror: boolean, glow = 0xffe566): void {
  if (horror) {
    g.ellipse(x, y, r * 1.15, r * 0.72);
    g.fill(0x140810);
    g.circle(x, y, r * 0.38);
    g.fill(glow);
    return;
  }
  g.ellipse(x, y, r, laid ? r * 0.62 : r);
  g.fill(0xfff8ee);
  g.circle(x + r * 0.12, y, r * 0.42);
  g.fill(0x2a1a12);
  g.circle(x + r * 0.22, y - r * 0.16, r * 0.14);
  g.fill(0xffffff);
}

function drawOren(g: Graphics, s: number, horror: boolean, phase: Phase): void {
  const skin = horror ? 0xc45a1c : 0xf08a2a;
  const dark = horror ? 0x8a2e10 : 0xd36a16;

  for (const side of [-1, 1]) {
    g.moveTo(side * s * 0.22, -s * 0.72);
    g.bezierCurveTo(side * s * 0.3, -s * 1.05, side * s * 0.08, -s * 1.18, side * s * 0.18, -s * 1.32);
    g.stroke({ width: s * 0.08, color: horror ? 0x5a2010 : 0xe07a22 });
    blob(g, side * s * 0.18, -s * 1.34, s * 0.1, horror ? 0xff3344 : 0xffc36a);
  }

  blob(g, 0, 0, s, skin);
  g.ellipse(0, s * 0.18, s * 0.78, s * 0.62);
  g.fill({ color: dark, alpha: 0.22 });

  g.roundRect(-s * 1.05, -s * 0.42, s * 2.1, s * 0.42, s * 0.2);
  g.fill(horror ? 0x1a1210 : 0x2c3a44);
  g.roundRect(-s * 0.86, -s * 0.5, s * 0.38, s * 0.58, s * 0.12);
  g.fill(horror ? 0x3a2018 : 0xe8d2a8);
  g.roundRect(s * 0.48, -s * 0.5, s * 0.38, s * 0.58, s * 0.12);
  g.fill(horror ? 0x3a2018 : 0xe8d2a8);
  g.ellipse(0, -s * 0.48, s * 0.55, s * 0.12);
  g.fill(horror ? 0x2a1814 : 0x1c2a32);

  eye(g, -s * 0.28, -s * 0.06, s * 0.16, true, horror, 0xff3344);
  eye(g, s * 0.3, -s * 0.06, s * 0.16, true, horror, 0xff3344);

  if (horror) {
    g.moveTo(-s * 0.34, s * 0.22);
    g.bezierCurveTo(-s * 0.1, s * 0.55, s * 0.18, s * 0.55, s * 0.38, s * 0.2);
    g.stroke({ width: s * 0.06, color: 0x2a0608 });
    g.moveTo(-s * 0.26, s * 0.3);
    g.lineTo(-s * 0.18, s * 0.42);
    g.moveTo(0, s * 0.42);
    g.lineTo(s * 0.05, s * 0.54);
    g.moveTo(s * 0.22, s * 0.32);
    g.lineTo(s * 0.3, s * 0.44);
    g.stroke({ width: s * 0.035, color: 0x2a0608 });

    g.poly([
      -s * 0.28,
      s * 0.02,
      -s * 0.42,
      s * 0.4,
      -s * 0.18,
      s * 0.82,
      s * 0.2,
      s * 0.78,
      s * 0.4,
      s * 0.34,
      s * 0.14,
      s * 0.04,
    ]);
    g.fill(0x3a060c);
    g.ellipse(0, s * 0.42, s * 0.22, s * 0.26);
    g.fill(phase >= 1000 ? 0xff2244 : 0xd4152c);
    g.ellipse(-s * 0.05, s * 0.36, s * 0.08, s * 0.1);
    g.fill(0xff6a7a);
    g.ellipse(s * 0.55, -s * 0.35, s * 0.14, s * 0.08);
    g.fill({ color: 0x8a1020, alpha: 0.55 });
  } else {
    g.ellipse(0, s * 0.28, s * 0.22, s * 0.1);
    g.stroke({ width: s * 0.04, color: 0xa84a10 });
  }
}

function drawPinki(g: Graphics, s: number, horror: boolean, phase: Phase): void {
  const skin = horror ? 0xd45a88 : 0xff7eb3;
  const ear = horror ? 0x8a2048 : 0xff4f9a;

  for (const side of [-1, 1]) {
    g.ellipse(side * s * 0.42, -s * 1.05, s * 0.22, s * 0.55);
    g.fill(skin);
    g.ellipse(side * s * 0.42, -s * 1.05, s * 0.11, s * 0.38);
    g.fill(horror ? 0x4a1024 : 0xffc1e3);
  }

  g.roundRect(-s * 0.28, -s * 0.95, s * 0.56, s * 0.32, s * 0.1);
  g.fill(ear);
  g.circle(-s * 0.22, -s * 0.88, s * 0.14);
  g.fill(ear);
  g.circle(s * 0.22, -s * 0.88, s * 0.14);
  g.fill(ear);
  g.circle(0, -s * 0.7, s * 0.12);
  g.fill(0xfff1c2);

  blob(g, 0, 0, s, skin);
  g.ellipse(-s * 0.52, s * 0.1, s * 0.16, s * 0.12);
  g.fill({ color: 0xff4f88, alpha: 0.45 });
  g.ellipse(s * 0.52, s * 0.1, s * 0.16, s * 0.12);
  g.fill({ color: 0xff4f88, alpha: 0.45 });

  eye(g, -s * 0.28, -s * 0.12, s * 0.15, false, horror, 0xff66dd);
  eye(g, s * 0.3, -s * 0.12, s * 0.15, false, horror, 0xff66dd);

  if (horror) {
    g.moveTo(-s * 0.42, -s * 0.02);
    g.lineTo(s * 0.46, s * 0.08);
    g.moveTo(-s * 0.2, s * 0.36);
    g.lineTo(s * 0.3, s * 0.18);
    g.stroke({ width: s * 0.03, color: 0x3a0818 });
    for (const x of [-0.2, 0, 0.22]) {
      g.moveTo(s * x, -s * 0.02);
      g.lineTo(s * x - s * 0.05, s * 0.06);
      g.moveTo(s * x, -s * 0.02);
      g.lineTo(s * x + s * 0.05, s * 0.06);
    }
    g.stroke({ width: s * 0.025, color: 0x3a0818 });
    g.ellipse(0, s * 0.28, s * 0.38, s * 0.2);
    g.fill(0x1a0810);
    g.moveTo(-s * 0.28, s * 0.22);
    g.lineTo(-s * 0.18, s * 0.38);
    g.lineTo(-s * 0.06, s * 0.2);
    g.lineTo(s * 0.06, s * 0.4);
    g.lineTo(s * 0.16, s * 0.2);
    g.lineTo(s * 0.3, s * 0.36);
    g.stroke({ width: s * 0.03, color: 0xffe6f0 });
    if (phase >= 3) {
      g.circle(-s * 0.28, -s * 0.12, s * 0.06);
      g.fill(0xff2244);
    }
  } else {
    g.ellipse(0, s * 0.28, s * 0.28, s * 0.22);
    g.fill(0x6a2038);
    g.ellipse(0, s * 0.3, s * 0.16, s * 0.1);
    g.fill(0xff6a9a);
  }
}

function drawVineria(g: Graphics, s: number, horror: boolean, _phase: Phase): void {
  const skin = horror ? 0x4a6a3a : 0x6edb9a;
  const vine = horror ? 0x3a2a18 : 0x2e8b57;
  const leaf = horror ? 0x6a4a20 : 0xa8e66a;

  for (let i = 0; i < 6; i++) {
    const a = -Math.PI * 0.9 + i * 0.32;
    const x = Math.cos(a) * s * 0.95;
    const y = Math.sin(a) * s * 0.85 - s * 0.15;
    g.moveTo(0, -s * 0.2);
    g.quadraticCurveTo(x * 0.4, y - s * 0.35, x, y);
    g.stroke({ width: s * 0.07, color: vine });
    g.ellipse(x, y, s * 0.14, s * 0.08);
    g.fill(leaf);
  }

  blob(g, 0, 0, s, skin);
  g.ellipse(0, s * 0.2, s * 0.7, s * 0.5);
  g.fill({ color: 0x2f6a44, alpha: 0.18 });

  eye(g, -s * 0.26, -s * 0.08, s * 0.15, false, horror, 0x9cff6a);
  eye(g, s * 0.28, -s * 0.08, s * 0.15, false, horror, 0x9cff6a);
  g.ellipse(-s * 0.26, -s * 0.28, s * 0.16, s * 0.05);
  g.fill(leaf);
  g.ellipse(s * 0.28, -s * 0.28, s * 0.16, s * 0.05);
  g.fill(leaf);

  if (horror) {
    g.moveTo(-s * 0.16, s * 0.22);
    g.lineTo(s * 0.18, s * 0.3);
    g.stroke({ width: s * 0.04, color: 0x2a1808 });
    g.ellipse(s * 0.36, s * 0.18, s * 0.12, s * 0.18);
    g.fill({ color: 0x2a1808, alpha: 0.35 });
  } else {
    g.arc(0, s * 0.16, s * 0.28, 0.2, Math.PI - 0.2);
    g.stroke({ width: s * 0.045, color: 0x2a5a38 });
  }
}

function drawBlack(g: Graphics, s: number, horror: boolean, phase: Phase): void {
  const h = horror ? 1.22 : 1.08;
  const bodyCol = horror ? 0x0a0a0e : 0x16141c;

  g.roundRect(-s * 0.42, -s * 1.55, s * 0.84, s * 0.42, s * 0.08);
  g.fill(0x0b0b10);
  g.roundRect(-s * 0.7, -s * 1.2, s * 1.4, s * 0.12, s * 0.06);
  g.fill(0x0b0b10);
  g.roundRect(-s * 0.08, -s * 1.18, s * 0.1, s * 0.16, 3);
  g.fill(phase >= 2 ? 0xff2244 : 0xc9a24a);

  g.ellipse(0, s * 0.05, s * (horror ? 0.62 : 0.72), s * h);
  g.fill(bodyCol);
  if (horror) {
    g.ellipse(0, s * 0.15, s * 0.32, s * 0.7);
    g.fill(0x050508);
  }

  if (horror) {
    g.circle(0, -s * 0.15, s * 0.42);
    g.fill(0x000000);
    eye(g, -s * 0.16, -s * 0.18, s * 0.1, false, true, phase >= 1000 ? 0xff2244 : 0x7cff6a);
    eye(g, s * 0.16, -s * 0.18, s * 0.1, false, true, phase >= 1000 ? 0xff2244 : 0x7cff6a);
  } else {
    eye(g, -s * 0.18, -s * 0.22, s * 0.1, false, false);
    eye(g, s * 0.2, -s * 0.22, s * 0.1, false, false);
    g.ellipse(0, s * 0.12, s * 0.14, s * 0.05);
    g.stroke({ width: s * 0.03, color: 0xeee6d2 });
  }
}

function drawExtra(g: Graphics, id: StemId, s: number, horror: boolean): void {
  const color = horror ? shade(STEM_COLOR[id], 0.65) : STEM_COLOR[id];
  blob(g, 0, 0, s * 0.92, color);
  if (id === "red") {
    g.roundRect(-s * 0.7, -s * 0.08, s * 0.42, s * 0.28, 8);
    g.fill(0xfff1d8);
    g.roundRect(s * 0.28, -s * 0.08, s * 0.42, s * 0.28, 8);
    g.fill(0xfff1d8);
  } else if (id === "purple") {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      g.moveTo(0, 0);
      g.lineTo(Math.cos(a) * s * 0.85, Math.sin(a) * s * 0.85);
      g.stroke({ width: s * 0.08, color: 0xfff6c2 });
    }
    blob(g, 0, 0, s * 0.28, 0xfffbee);
  } else if (id === "blue") {
    g.ellipse(0, s * 0.12, s * 0.5, s * 0.38);
    g.fill(0x2a1850);
    g.circle(-s * 0.16, -s * 0.12, s * 0.1);
    g.fill(0xfff4d8);
    g.circle(s * 0.2, -s * 0.12, s * 0.1);
    g.fill(0xfff4d8);
  } else {
    g.ellipse(0, -s * 0.08, s * 0.38, s * 0.46);
    g.fill(0xffe08a);
    g.ellipse(0, s * 0.18, s * 0.22, s * 0.16);
    g.fill(0xd4a22a);
  }
  if (horror) {
    eye(g, -s * 0.2, -s * 0.08, s * 0.1, false, true);
    eye(g, s * 0.22, -s * 0.08, s * 0.1, false, true);
  } else {
    eye(g, -s * 0.2, -s * 0.1, s * 0.1, false, false);
    eye(g, s * 0.22, -s * 0.1, s * 0.1, false, false);
  }
}

function shade(color: number, f: number): number {
  const r = Math.floor(((color >> 16) & 255) * f);
  const g = Math.floor(((color >> 8) & 255) * f);
  const b = Math.floor((color & 255) * f);
  return (r << 16) | (g << 8) | b;
}

/**
 * Tray chip: rounded holder square for art only, name centered below the plate.
 * Origin is the plate center so layout can park the square in the upper cell
 * and leave a label gutter underneath. Label is non-interactive.
 * The rocker (plate + art) gently rotates; the label stays upright.
 */
export function createTrayIcon(id: StemId, size: number): TrayIconView {
  const root = new Container();
  const rocker = new Container();
  const plate = new Graphics();
  plate.roundRect(-size / 2, -size / 2, size, size, size * 0.22);
  plate.fill({ color: 0x140810, alpha: 0.35 });
  plate.stroke({ width: 3, color: 0xfff1c8, alpha: 0.75 });
  const plateShadow = makeSoftShadowSprite(0, size * 0.1, size * 0.72, size * 0.64);
  plateShadow.tint = STEM_COLOR[id];
  plateShadow.alpha = 0.55;
  // Fill nearly the whole holder — diameter inside createCharacter is ~0.97 of size.
  const art = createCharacter(id, size, { idleRock: false, seatedGlow: false });
  const label = new Text({
    text: STEM_LABEL[id],
    style: {
      fill: 0xfff6e0,
      fontSize: Math.max(10, size * 0.145),
      fontWeight: "800",
      fontFamily: "ui-rounded, system-ui",
      dropShadow: TEXT_HALO,
    },
  });
  label.anchor.set(0.5);
  label.y = size / 2 + Math.max(11, size * 0.16);
  label.eventMode = "none";
  rocker.addChild(plateShadow, plate, art.root);
  root.addChild(rocker, label);
  // Plate only — names sit outside the tap target.
  root.hitArea = new Rectangle(-size / 2, -size / 2, size, size);
  root.eventMode = "static";
  root.cursor = "pointer";
  return {
    root,
    view: art,
    rocker,
    setMood(phase) {
      art.setMood(phase);
    },
  };
}
