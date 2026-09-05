import { playDarkHatChime, playJamStartCymbal, playRingChime } from "./audio/chime";
import { bindSoundGuide, currentSoundGuideMode } from "./audio/soundGuide";
import { isKeepAlivePlaying, pauseKeepAliveForTest } from "./audio/unlock";
import { isTitleBedPlaying, startTitleBed, stopTitleBed, suspendTitleBedForTest } from "./audio/titleBed";
import { haptic } from "./input/haptics";
import { kickFullscreen, shouldKickFullscreen } from "./input/fullscreen";
import { bindToVisualViewport, pinToVisualViewport } from "./input/viewport";
import type { Phase, SlotId, StemId } from "./types";
import { bootPwa, pwaTestHooks, registerPwaAfterStart } from "./pwa/register";
import { applyPlatformGuides } from "./ui/platformGuide";
import { kickUnlockHtmlAudio } from "./audio/unlock";
import { WEBGL_UNAVAILABLE_MESSAGE } from "./view/gpuBudget";
import {
  getWarmupProgress,
  onWarmupProgress,
  startTitleWarmup,
  whenWarmupComplete,
} from "./view/assetWarmup";
import {
  applyWindowOrientAttr,
  bindWindowAspect,
  TITLE_ART_SIZE,
  titleArtFallback,
  titleArtUrl,
  type PhotoOrient,
  type TitleArtKind,
} from "./view/windowAspect";
import "./style.css";

import type { SprunkiJam } from "./game/jam";

/** Soft kid-friendly hero loop: ~5s per image + CSS crossfade. */
const HERO_DWELL_MS = 5000;


const hostEl = document.getElementById("stage-root");
const gateEl = document.getElementById("gate");
const jamBtnEl = document.getElementById("jam-btn");
const ringHotspot = document.getElementById("ring-hotspot");
const hatHotspot = document.getElementById("hat-hotspot");
const introMoment = document.getElementById("intro-moment");
const gateErrorEl = document.getElementById("gate-error");
const heroRingEl = document.getElementById("hero-ring");
const heroDarkEl = document.getElementById("hero-dark");
const introMomentImg = document.getElementById("intro-moment-img") as HTMLImageElement | null;
const introMomentCredit = document.getElementById("intro-moment-credit");
const soundGuideEl = document.getElementById("sound-guide");
const playGuideEl = document.getElementById("play-guide");
const gateHelpEl = document.getElementById("gate-help");
const welcomeMarqueeEl = document.getElementById("welcome-marquee");

if (
  !hostEl ||
  !gateEl ||
  !jamBtnEl ||
  !ringHotspot ||
  !hatHotspot ||
  !introMoment ||
  !gateErrorEl ||
  !heroRingEl ||
  !heroDarkEl ||
  !introMomentImg ||
  !introMomentCredit ||
  !soundGuideEl ||
  !playGuideEl ||
  !gateHelpEl ||
  !welcomeMarqueeEl
) {
  throw new Error("Sprunki and Rainbow Friends Jam markup is missing");
}

const host = hostEl;
const gate = gateEl;
const jamBtn = jamBtnEl;
const ringBtn = ringHotspot;
const hatBtn = hatHotspot;
const momentEl = introMoment;
const gateError = gateErrorEl;
const heroRing = heroRingEl;
const heroDark = heroDarkEl;

/** Active title hero — declared early so orient sync can unload the other. */
let heroKind: "ring" | "dark" = "ring";
const momentImg = introMomentImg;
const momentCredit = introMomentCredit;

/**
 * Reset survival (Windows hang escape): capture-phase navigation that does not
 * wait on jam whoosh timers or Pixi. If the main thread is wedged mid-resize,
 * this still schedules a title reload as soon as the click is delivered.
 */
document.getElementById("reset-btn")?.addEventListener(
  "pointerdown",
  (e) => {
    e.preventDefault();
    const dest = `${window.location.pathname}${window.location.search}`;
    try {
      window.location.href = dest;
    } catch {
      try {
        window.location.reload();
      } catch {
        /* ignore */
      }
    }
  },
  { capture: true },
);

function applyTitleArtSrc(
  img: HTMLElement,
  kind: TitleArtKind,
  orient: PhotoOrient,
  active: boolean,
): void {
  if (!(img instanceof HTMLImageElement)) return;
  const url = titleArtUrl(kind, orient);
  const size = TITLE_ART_SIZE[orient];
  if (img.width !== size.w) img.width = size.w;
  if (img.height !== size.h) img.height = size.h;
  img.dataset.orient = orient;
  if (!img.dataset.fallbackBound) {
    img.dataset.fallbackBound = "1";
    img.addEventListener("error", () => {
      const failed = img.getAttribute("src") || "";
      img.dataset.failedSrc = `${img.dataset.failedSrc || ""}|${failed}`;
      const fallback = titleArtFallback(kind);
      if (failed !== fallback) img.src = fallback;
    });
  }
  // Inactive hero: drop src so Edge only keeps one ~4000px decode alive.
  if (!active) {
    if (img.getAttribute("src")) {
      img.removeAttribute("src");
      img.removeAttribute("srcset");
    }
    return;
  }
  if ((img.dataset.failedSrc || "").includes(url)) {
    const fallback = titleArtFallback(kind);
    if (img.getAttribute("src") !== fallback) img.src = fallback;
    return;
  }
  if (img.getAttribute("src") !== url) img.src = url;
}

function syncTitleHeroArt(orient: PhotoOrient = applyWindowOrientAttr()): PhotoOrient {
  applyWindowOrientAttr(orient, document.documentElement);
  applyWindowOrientAttr(orient, gate);
  const active: TitleArtKind = heroKind === "dark" ? "dark" : "ring";
  applyTitleArtSrc(heroRing, "ring", orient, active === "ring");
  applyTitleArtSrc(heroDark, "dark", orient, active === "dark");
  return orient;
}

/** Pin the title gate to the visible viewport so TAP TO JAM is never under Safari/Edge chrome. */
const unbindGateViewport = bindToVisualViewport(gate);
/** Swap landscape/portrait display JPEGs only when the window box flips — not every resize tick. */
const unbindTitleAspect = bindWindowAspect((orient) => {
  syncTitleHeroArt(orient);
});

/** Stage must have a non-zero size before Pixi WebGL init — pin immediately, not after init. */
pinToVisualViewport(host);

/**
 * Kill rubber-band / pull-to-refresh that fights drag-and-drop in iOS Edge.
 * Allow touch scrolling inside help disclosures. Welcome marquee drag is
 * JS-driven (transform), so document touchmove can stay blocked there —
 * except reduced-motion, which uses native overflow scroll.
 */
const blockOverscroll = (e: Event): void => {
  const t = e.target;
  if (t instanceof Element) {
    if (
      t.closest("#gate-help, #sound-guide-other, #play-guide-other, .gate-help-body")
    ) {
      return;
    }
    if (
      t.closest("#welcome-marquee") &&
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
  }
  e.preventDefault();
};
document.addEventListener("touchmove", blockOverscroll, { passive: false });
document.addEventListener(
  "gesturestart",
  (e) => {
    e.preventDefault();
  },
  { passive: false },
);

/**
 * Title stays free of Pixi: no `import "./game/jam"` until TAP TO JAM (and a
 * quiet prefetch after the first title gesture). Warmup also waits for start so
 * we do not pull Phase 1 6000px masters into memory while the window is resized.
 */
let game: SprunkiJam | null = null;
let jamModPromise: Promise<typeof import("./game/jam")> | null = null;

function prefetchJamModule(): void {
  if (!jamModPromise) jamModPromise = import("./game/jam");
}

async function ensureGame(): Promise<SprunkiJam> {
  prefetchJamModule();
  const mod = await jamModPromise!;
  if (!game) game = new mod.SprunkiJam();
  return game;
}

function requireGame(): SprunkiJam {
  if (!game) throw new Error("jam not started");
  return game;
}

let starting = false;
let momentTimer: number | null = null;
let lastGestureAt = 0;
let loadingHintTimer: number | null = null;
let heroTimer: number | null = null;

function hideGateError(): void {
  gateError.hidden = true;
  gateError.textContent = "";
}

function showGateError(message: string): void {
  gateError.hidden = false;
  gateError.textContent = message;
}

function isAlreadyInGame(): boolean {
  return gate.classList.contains("gone") || document.body.dataset.ready === "1";
}

/** Match sound / Home Screen tips to the current browser before binding taps. */
const detectedPlatform = applyPlatformGuides();

const soundGuide = bindSoundGuide(() => !isAlreadyInGame() && !starting);

/**
 * Title-gate chrome (welcome crawl, help disclosure, guides) must never claim
 * the TAP TO JAM start gesture — but MUST unlock the soft title bed on first tap.
 */
function bindStopJamStart(el: HTMLElement): void {
  const onGuideGesture = (e: Event): void => {
    // No await — iOS unlock (HTMLAudio + ctx.resume) must stay in this turn.
    if (!isAlreadyInGame() && !starting) {
      startTitleBed();
      soundGuide.onTitleBedGesture();
    }
    e.stopPropagation();
  };
  el.addEventListener("pointerdown", onGuideGesture);
  el.addEventListener("touchstart", onGuideGesture, { passive: true });
  el.addEventListener("click", onGuideGesture);
}
bindStopJamStart(gateHelpEl);
bindStopJamStart(playGuideEl);
bindStopJamStart(welcomeMarqueeEl);

/**
 * Hybrid welcome crawl: gentle auto-advance + finger-drag scrubbing.
 * Release always resumes after a short delay — never freeze until another gesture.
 * prefers-reduced-motion: CSS keeps it static + freely scrollable (no auto crawl).
 */
function bindWelcomeMarqueeCrawl(el: HTMLElement): void {
  const viewport = el.querySelector<HTMLElement>(".welcome-marquee-viewport");
  const track = el.querySelector<HTMLElement>(".welcome-marquee-track");
  if (!viewport || !track) return;

  const reduceMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    return;
  }

  const CRAWL_MS = 55_000;
  const START_DELAY_MS = 3_000;
  const RESUME_DELAY_MS = 750;
  /** Ignore tiny pointer jitter so a light tap does not scrub the crawl. */
  const DRAG_THRESHOLD_PX = 8;

  el.classList.add("is-js-crawl");

  let offsetPx = 0;
  let loopPx = 0;
  let pointerDown = false;
  let dragging = false;
  let lastPointerY = 0;
  let originY = 0;
  let lastTs = 0;
  let startedAt = performance.now() + START_DELAY_MS;
  let resumeAt = 0;

  const measure = (): void => {
    // Duplicate copy — loop distance matches former translateY(-50%).
    loopPx = track.scrollHeight / 2;
  };

  const wrap = (): void => {
    if (loopPx <= 0) return;
    offsetPx = ((offsetPx % loopPx) + loopPx) % loopPx;
  };

  const apply = (): void => {
    wrap();
    track.style.transform = `translate3d(0, ${-offsetPx}px, 0)`;
  };

  const tick = (ts: number): void => {
    if (isAlreadyInGame()) return;
    if (!dragging && ts >= startedAt && ts >= resumeAt && loopPx > 0) {
      const dt = lastTs > 0 ? Math.min(64, ts - lastTs) : 0;
      offsetPx += (loopPx / CRAWL_MS) * dt;
    }
    lastTs = ts;
    apply();
    window.requestAnimationFrame(tick);
  };

  const scheduleResume = (): void => {
    resumeAt = performance.now() + RESUME_DELAY_MS;
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointerDown = true;
    dragging = false;
    originY = e.clientY;
    lastPointerY = e.clientY;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!pointerDown) return;
    if (!dragging) {
      if (Math.abs(e.clientY - originY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      el.classList.add("is-dragging");
      lastPointerY = e.clientY;
      // Pause auto-crawl only once a real drag starts.
      resumeAt = Number.POSITIVE_INFINITY;
    }
    const dy = e.clientY - lastPointerY;
    lastPointerY = e.clientY;
    // Drag up → later copy (like native scroll); drag down → earlier copy.
    offsetPx -= dy;
    apply();
  };

  const endDrag = (e: PointerEvent): void => {
    if (!pointerDown) return;
    const wasDragging = dragging;
    pointerDown = false;
    dragging = false;
    el.classList.remove("is-dragging");
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Light taps must not delay the crawl; only real drags arm the resume pause.
    if (wasDragging) scheduleResume();
  };

  const onWheel = (e: WheelEvent): void => {
    offsetPx += e.deltaY;
    apply();
    scheduleResume();
  };

  measure();
  apply();
  window.requestAnimationFrame(tick);

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("resize", () => {
    const ratio = loopPx > 0 ? offsetPx / loopPx : 0;
    measure();
    offsetPx = ratio * loopPx;
    apply();
  });
}
bindWelcomeMarqueeCrawl(welcomeMarqueeEl);

function clearLoadingHint(): void {
  if (loadingHintTimer != null) {
    window.clearTimeout(loadingHintTimer);
    loadingHintTimer = null;
  }
}

function armLoadingHint(): void {
  clearLoadingHint();
  loadingHintTimer = window.setTimeout(() => {
    loadingHintTimer = null;
    if (starting && !isAlreadyInGame()) {
      jamBtn.textContent = "STILL LOADING…";
    }
  }, 12000);
}

/**
 * First start event wins (pointerdown / touchstart / click). preventDefault so
 * iOS does not synthesize a second start from the same tap.
 */
function claimStartGesture(e: Event): boolean {
  e.preventDefault();
  e.stopPropagation();
  if (isAlreadyInGame()) return false;
  if (starting) return false;
  const now = performance.now();
  if (now - lastGestureAt < 700) return false;
  lastGestureAt = now;
  return true;
}

let heroUnloadTimer: number | null = null;

function setHero(kind: "ring" | "dark"): void {
  heroKind = kind;
  gate.dataset.hero = kind;
  const orient = applyWindowOrientAttr();
  // Load the incoming hero before fading so the crossfade has pixels.
  applyTitleArtSrc(heroRing, "ring", orient, true);
  applyTitleArtSrc(heroDark, "dark", orient, true);
  heroRing.classList.toggle("is-active", kind === "ring");
  heroDark.classList.toggle("is-active", kind === "dark");
  if (heroUnloadTimer != null) window.clearTimeout(heroUnloadTimer);
  // After the CSS opacity transition, drop the hidden hero src (one decode only).
  heroUnloadTimer = window.setTimeout(() => {
    heroUnloadTimer = null;
    if (isAlreadyInGame()) return;
    syncTitleHeroArt();
  }, 1800);
}

function startHeroCrossfade(): void {
  if (heroTimer != null) window.clearInterval(heroTimer);
  setHero("ring");
  heroTimer = window.setInterval(() => {
    if (isAlreadyInGame()) {
      if (heroTimer != null) window.clearInterval(heroTimer);
      heroTimer = null;
      return;
    }
    setHero(heroKind === "ring" ? "dark" : "ring");
  }, HERO_DWELL_MS);
}

type MomentKind = "ring" | "hat";

async function showIntroMoment(kind: MomentKind, e?: Event): Promise<void> {
  e?.preventDefault();
  e?.stopPropagation();
  // Hotspots are a user gesture — unlock + start the soft title bed.
  startTitleBed();
  momentEl.dataset.kind = kind;
  const orient = applyWindowOrientAttr();
  if (kind === "hat") {
    applyTitleArtSrc(momentImg, "dark", orient, true);
    momentImg.alt = "Mr. Black and Vineria in a sunny field";
    momentCredit.textContent = "Tall hat";
    void playDarkHatChime();
    haptic([30, 40, 60]);
  } else {
    applyTitleArtSrc(momentImg, "ring", orient, true);
    momentImg.alt = "Pinki and Oren with a diamond ring";
    momentCredit.textContent = "Diamond ring";
    void playRingChime();
  }
  momentEl.hidden = false;
  if (momentTimer != null) window.clearTimeout(momentTimer);
  momentTimer = window.setTimeout(() => {
    momentEl.hidden = true;
    momentTimer = null;
  }, kind === "hat" ? 2600 : 2200);
}

momentEl.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  momentEl.hidden = true;
  if (momentTimer != null) window.clearTimeout(momentTimer);
});

ringBtn.addEventListener("pointerdown", (e) => {
  void showIntroMoment("ring", e);
});
hatBtn.addEventListener("pointerdown", (e) => {
  void showIntroMoment("hat", e);
});

/**
 * Best-effort fullscreen in the same user-gesture turn as TAP TO JAM.
 * Skipped on every desktop/laptop — invasive, and the jump is a maximize freeze.
 * Kept for phones/tablets. iOS often rejects Fullscreen API — never block start.
 * Add-to-Home-Screen standalone is the reliable "full screen" path on iPhone.
 */
function requestJamFullscreen(): boolean {
  return kickFullscreen();
}

function showSilentTipOnce(): void {
  const tip = document.getElementById("silent-tip");
  if (!tip || tip.dataset.shown === "1") return;
  tip.dataset.shown = "1";
  tip.hidden = false;
  const dismiss = (): void => {
    tip.classList.add("gone");
    window.setTimeout(() => {
      tip.hidden = true;
    }, 400);
  };
  tip.addEventListener(
    "pointerdown",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    },
    { once: true },
  );
  // Auto-fade so it never blocks the jam.
  window.setTimeout(dismiss, 9000);
}

function enterGame(): void {
  clearLoadingHint();
  if (heroTimer != null) {
    window.clearInterval(heroTimer);
    heroTimer = null;
  }
  // Ensure title bed is gone so stage stems are not fighting it.
  stopTitleBed();
  gate.classList.add("gone");
  document.body.dataset.ready = "1";
  jamBtn.textContent = "JAMMING";
  // Kid-friendly reminder only — iOS WebKit cannot ignore Silent (switch or setting).
  showSilentTipOnce();
  window.setTimeout(() => {
    unbindGateViewport();
    unbindTitleAspect();
    gate.remove();
  }, 750);
  registerPwaAfterStart();
}

function paintWarmupProgress(): void {
  const p = getWarmupProgress();
  if (p.complete) {
    jamBtn.textContent = "STARTING…";
    return;
  }
  jamBtn.textContent = `LOADING ${p.percent}%`;
}

async function finishStart(): Promise<void> {
  try {
    // Art warmup + Pixi module load both start here — never on the idle title.
    startTitleWarmup();
    const g = await ensureGame();
    const mountP = g.mount(host);
    if (!getWarmupProgress().complete) {
      paintWarmupProgress();
      const stop = onWarmupProgress(() => {
        if (starting && !isAlreadyInGame()) paintWarmupProgress();
      });
      try {
        await whenWarmupComplete();
      } finally {
        stop();
      }
    }
    jamBtn.textContent = "STARTING…";
    await mountP;
    g.unlock();
    g.ensureAudio();
    enterGame();
  } catch (err) {
    starting = false;
    clearLoadingHint();
    jamBtn.classList.remove("starting");
    jamBtn.removeAttribute("disabled");
    jamBtn.textContent = "TAP TO JAM";
    const reason = err instanceof Error ? err.message : "";
    showGateError(
      reason === WEBGL_UNAVAILABLE_MESSAGE
        ? WEBGL_UNAVAILABLE_MESSAGE
        : "Couldn't start the jam. Graphics failed to load. Tap TAP TO JAM to try again.",
    );
    console.error(err);
  }
}

function startJam(e: Event): void {
  if (!claimStartGesture(e)) return;
  starting = true;
  jamBtn.classList.add("starting");
  jamBtn.setAttribute("disabled", "true");
  startTitleWarmup();
  jamBtn.textContent = getWarmupProgress().complete ? "STARTING…" : `LOADING ${getWarmupProgress().percent}%`;
  hideGateError();
  stopTitleBed();
  // Gesture-turn audio unlock without Pixi — jam AudioEngine unlocks after ensureGame.
  kickUnlockHtmlAudio();
  if (game) {
    game.unlock();
  }
  playJamStartCymbal();
  requestJamFullscreen();
  prefetchJamModule();
  window.requestAnimationFrame(() => {
    game?.ensureAudio();
    window.requestAnimationFrame(() => game?.ensureAudio());
  });
  armLoadingHint();
  void finishStart();
}

/**
 * First title-screen gesture unlocks Web Audio and starts the soft title bed.
 * Document capture so guides / disclosures / hotspots / hero / empty chrome all
 * count — even when a child calls stopPropagation. Must not await.
 * This is NOT entering the jam — only TAP TO JAM on #jam-btn starts the game.
 */
function onTitleScreenGesture(): void {
  if (isAlreadyInGame() || starting) return;
  // Gate removed after enterGame; ignore stray captures once it is gone.
  if (!document.body.contains(gate) || gate.classList.contains("gone")) return;
  startTitleBed();
  soundGuide.onTitleBedGesture();
  // Do not prefetch Pixi here — parsing the jam chunk on a title tap freezes
  // Edge/CI for seconds (sound-guide taps feel dead). Load starts on TAP TO JAM.
}

document.addEventListener("pointerdown", onTitleScreenGesture, { capture: true });
document.addEventListener("touchstart", onTitleScreenGesture, {
  capture: true,
  passive: true,
});
// Keep #gate capture too — covers taps that hit gate chrome before document
// retargeting quirks on some WebKit builds.
gate.addEventListener("pointerdown", onTitleScreenGesture, { capture: true });
gate.addEventListener("touchstart", onTitleScreenGesture, {
  capture: true,
  passive: true,
});

// Only TAP TO JAM starts the jam. pointerdown is primary; touchstart + click cover Edge quirks.
jamBtn.addEventListener("pointerdown", startJam);
jamBtn.addEventListener("touchstart", startJam, { passive: false });
jamBtn.addEventListener("click", startJam);

startHeroCrossfade();
// Initial hero: only the active image has a src (see syncTitleHeroArt).
syncTitleHeroArt();


bootPwa(() => game?.testTransitionState().busy ?? false);
const pwaHooks = pwaTestHooks(() => game?.testTransitionState().busy ?? false);

/** Tiny title-gate build stamp (version only) so family testers can spot a stale SW. */
const buildVersionEl = document.getElementById("build-version");
function paintBuildStamp(): void {
  if (!buildVersionEl) return;
  buildVersionEl.textContent = pwaHooks.buildVersion();
}
paintBuildStamp();

/** Playwright / manual smoke: cold-load → TAP TO JAM → AudioContext running. */
let portraitHelpers: typeof import("./view/characters") | null = null;
async function portraitMod(): Promise<typeof import("./view/characters")> {
  if (!portraitHelpers) portraitHelpers = await import("./view/characters");
  return portraitHelpers;
}

window.__sprunkiJamTest = {
  audioState: () => game?.audio.ctx?.state ?? null,
  isReady: () => document.body.dataset.ready === "1",
  warmupProgress: () => getWarmupProgress(),
  placeStem: (stem, slot = "mid") => {
    requireGame().testPlace(stem as StemId, slot as SlotId);
  },
    slotStems: (slot) => requireGame().testSlotStems(slot as SlotId),
    occupantViewStems: (slot) => requireGame().testOccupantViewStems(slot as SlotId),
    occupantLook: (slot) => requireGame().testOccupantLook(slot as SlotId),
    isDragging: () => requireGame().testIsDragging(),
    trayInteractive: (stem) => requireGame().testTrayInteractive(stem as StemId),
    beginDragThenCancel: (stem) => {
      requireGame().testBeginDragThenCancel(stem as StemId);
    },
    dragSeatOffPad: (slot) => {
      requireGame().testDragSeatOffPad(slot as SlotId);
    },
  titleBedPlaying: () => isTitleBedPlaying(),
  portraitUrl: (stem, horrorOrPhase: boolean | number = false) => {
    // Sync tests call after jam start; warm the module on first use via void.
    void portraitMod();
    return portraitHelpers?.portraitUrlFor(stem as StemId, horrorOrPhase as boolean | Phase) ?? null;
  },
  portraitFrame: (stem, horrorOrPhase: boolean | number = false) => {
    void portraitMod();
    return (
      portraitHelpers?.portraitFrameFor(stem as StemId, horrorOrPhase as boolean | Phase) ?? {
        scale: 1,
        offsetX: 0,
        offsetY: 0,
      }
    );
  },
  hasHorrorPortrait: (stem) => {
    void portraitMod();
    return portraitHelpers?.hasHorrorPortraitConfigured(stem as StemId) ?? false;
  },
  hasDeepHorrorPortrait: (stem) => {
    void portraitMod();
    return portraitHelpers?.hasDeepHorrorPortraitConfigured(stem as StemId) ?? false;
  },
  detectedPlatform: () => detectedPlatform.id,
  slotIds: () => requireGame().testSlotIds(),
  padLabels: () => requireGame().testPadLabels(),
  soundGuideMode: () => currentSoundGuideMode(),
  mixGain: () => requireGame().testMixGain(),
  isAudible: (stem) => requireGame().testIsAudible(stem as StemId),
  slotCenter: (slot) => requireGame().testSlotCenter(slot as SlotId),
  silenceMix: (on) => requireGame().testSilenceMix(on),
  phaseTransitionCue: (kind) => requireGame().testPhaseTransitionCue(kind),
  setPhase: (phase) => requireGame().testSetPhase(phase as Phase),
  gotoPhase: async (phase) => {
    await requireGame().testGotoPhase(phase as Phase);
  },
  transitionState: () => requireGame().testTransitionState(),
  transitionFx: () => requireGame().testTransitionFx(),
  dustState: () => requireGame().testDustState(),
  freezeTransition: (u) => requireGame().testFreezeTransition(u),
  bgCoverage: () => requireGame().testBgCoverage(),
  titleArt: () => {
    const ring = heroRing instanceof HTMLImageElement ? heroRing : null;
    const dark = heroDark instanceof HTMLImageElement ? heroDark : null;
    return {
      orient: (document.documentElement.dataset.windowOrient ||
        gate.dataset.windowOrient ||
        "") as "portrait" | "landscape" | "",
      ringSrc: ring?.currentSrc || ring?.src || "",
      darkSrc: dark?.currentSrc || dark?.src || "",
      ringFit: ring ? getComputedStyle(ring).objectFit : "",
      darkFit: dark ? getComputedStyle(dark).objectFit : "",
      ringPos: ring ? getComputedStyle(ring).objectPosition : "",
      darkPos: dark ? getComputedStyle(dark).objectPosition : "",
      gateW: gate.getBoundingClientRect().width,
      gateH: gate.getBoundingClientRect().height,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
    };
  },
  forceStageSize: (w, h) => requireGame().testForceStageSize(w, h),
  forcePresentSnapshot: () => requireGame().testForcePresentSnapshot(),
  layoutProbe: () =>
    game?.testLayoutProbe() ?? {
      relayoutCount: 0,
      gpuResizeCount: 0,
      lastRelayoutMs: 0,
      maxRelayoutMs: 0,
      inRelayout: false,
      screenW: 0,
      screenH: 0,
      resolution: 0,
      antialias: false,
      backingPixels: 0,
      gpuFrozen: false,
      canvasCssW: 0,
      canvasCssH: 0,
      hostCssW: 0,
      hostCssH: 0,
      presentScale: 1,
      tickerPausedForResize: false,
      presentHiddenForResize: false,
      presentSnapshotForResize: false,
      canvasInDom: false,
      presentFreeze: false,
      devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      rendererName: "",
      presentMode: "webgl" as const,
      webglContext: false,
      dustLive: 0,
      dustCount: 0,
      dustDim: 1,
      dustPaused: false,
      dustPhase: 1,
      dustVisible: false,
      snapshotUrlCount: 0,
      filterResizeCount: 0,
      dustUpdates: 0,
    },
  shouldKickFullscreen: (hints) => shouldKickFullscreen(hints),
  kickFullscreen: () => kickFullscreen(),
  restoreMixGain: () => requireGame().audio.restoreMixGain(),
  sceneStats: () => requireGame().testSceneStats(),
  pumpDrawSlots: (times) => {
    requireGame().testPumpDrawSlots(times);
  },
  pumpRelayout: (times) => {
    requireGame().testPumpRelayout(times);
  },
  keepAlivePlaying: () => isKeepAlivePlaying(),
  pauseKeepAlive: () => pauseKeepAliveForTest(),
  suspendAudio: async () => {
    const ctx = requireGame().audio.ctx;
    if (!ctx || ctx.state === "closed") return;
    try {
      await ctx.suspend();
    } catch {
      /* ignore */
    }
  },
  suspendTitleBed: () => suspendTitleBedForTest(),
  secretState: () => requireGame().testSecretSnapshot(),
  startSecret: () => {
    requireGame().testStartSecret();
  },
  exitSecret: () => {
    requireGame().testExitSecret();
  },
  secretSpawn: (slots, windowMs = 10_000) => {
    const list = (Array.isArray(slots) ? slots : [slots]) as SlotId[];
    requireGame().testSecretSpawn(list, windowMs);
  },
  secretTap: (slot) => requireGame().testSecretTap(slot as SlotId),
  secretFaces: () => requireGame().testSecretFaces(),
  secretPadLook: () => requireGame().testSecretPadLook(),
  secretEnd: () => {
    requireGame().testSecretEnd();
  },
  secretCurve: (elapsedMs) => requireGame().testSecretCurve(elapsedMs),
  pwaSafeToReload: () => pwaHooks.safeToReload(),
  pwaReloadPending: () => pwaHooks.reloadPending(),
  pwaRequestReload: () => pwaHooks.requestReload(),
  bindPwaUpdateChecks: (check, options) => pwaHooks.bindUpdateChecks(check, options),
  pwaBuildVersion: () => pwaHooks.buildVersion(),
  pwaVersionChanged: (local, remote) => pwaHooks.versionChanged(local, remote),
};
