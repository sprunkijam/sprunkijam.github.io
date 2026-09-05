/** Shared first-gesture unlock for iOS Edge / Safari WebKit autoplay rules. */

import { detectPlatform } from "../ui/platformGuide";

type WebkitWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

type AudioSessionLike = {
  state?: string;
  addEventListener?: (type: string, listener: () => void) => void;
};

export function createAudioContext(): AudioContext {
  const W = window as WebkitWindow;
  const Ctor = W.AudioContext || W.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio is unavailable in this browser");
  return new Ctor({ latencyHint: "interactive" });
}

/** Tiny silent WAV — unlocks HTMLMediaElement + helps some WebKit audio paths. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

let htmlUnlocked = false;
let keepAliveEl: HTMLAudioElement | null = null;

/**
 * Looping silent HTMLAudio is an iOS / Android WebKit session keep-alive.
 * Windows Edge/Chrome diagnosis proved silent HTMLAudio alone drives a multi-GB
 * CPU/RAM spiral on desktop — never arm it there. Desktop unlock is Web Audio only.
 */
export function shouldUseHtmlAudioKeepAlive(
  ua = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
  const family = detectPlatform(ua).family;
  return family === "ios" || family === "android";
}

/**
 * Kick HTMLAudio.play() in this turn. Do not await before ctx.resume() —
 * a microtask yields the iOS WebKit user-gesture.
 * Pass force=true on later stage taps so a failed first play can retry.
 * On iOS/Android: keep a looping silent element playing — pausing it can let
 * WebKit drop the audio session after ~60s while Web Audio still thinks it is running.
 * On Windows/Mac/desktop: no-op (Web Audio ctx.resume is enough).
 */
export function kickUnlockHtmlAudio(force = false): void {
  if (!shouldUseHtmlAudioKeepAlive()) {
    htmlUnlocked = true;
    return;
  }
  if (htmlUnlocked && !force && keepAliveEl && !keepAliveEl.paused) return;
  try {
    if (!keepAliveEl) {
      keepAliveEl = new Audio(SILENT_WAV);
      keepAliveEl.setAttribute("playsinline", "true");
      keepAliveEl.setAttribute("webkit-playsinline", "true");
      keepAliveEl.loop = true;
      keepAliveEl.volume = 0.01;
    }
    const play = keepAliveEl.play();
    if (play && typeof play.then === "function") {
      void play
        .then(() => {
          htmlUnlocked = true;
        })
        .catch(() => {
          htmlUnlocked = false;
        });
    } else {
      htmlUnlocked = true;
    }
  } catch {
    htmlUnlocked = false;
  }
}

export function isKeepAlivePlaying(): boolean {
  return Boolean(keepAliveEl && !keepAliveEl.paused);
}

/** Playwright: simulate iOS pausing the silent keep-alive while ctx stays "running". */
export function pauseKeepAliveForTest(): void {
  try {
    keepAliveEl?.pause();
  } catch {
    /* ignore */
  }
}

function keepAliveNeedsKick(): boolean {
  // Desktop never arms keep-alive — do not treat "missing" as dead and re-kick forever.
  if (!shouldUseHtmlAudioKeepAlive()) return false;
  return !keepAliveEl || keepAliveEl.paused;
}

function ctxNeedsKick(ctx: AudioContext): boolean {
  const state = ctx.state as string;
  return state !== "running" && state !== "closed";
}

/**
 * Call ctx.resume() and start a silent buffer in this user-gesture turn.
 * Do not await resume() first — awaiting drops the iOS gesture.
 * Always try resume() — a no-op when already running, required when WebKit
 * flipped to interrupted/suspended.
 */
export function kickResumeContext(ctx: AudioContext): void {
  const state = ctx.state as string;
  if (state === "closed") return;
  try {
    void ctx.resume();
  } catch {
    /* retry on next gesture */
  }
  try {
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start();
    try {
      silent.stop(ctx.currentTime + 0.05);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

/** Full unlock kick used on TAP TO JAM and every later stage gesture. */
export function kickAudioUnlock(ctx: AudioContext | null): void {
  kickUnlockHtmlAudio(true);
  if (ctx) kickResumeContext(ctx);
}

export async function unlockHtmlAudio(): Promise<void> {
  kickUnlockHtmlAudio(true);
}

export async function resumeContext(ctx: AudioContext): Promise<void> {
  kickResumeContext(ctx);
  const state = ctx.state as string;
  if (state === "suspended" || state === "interrupted") {
    try {
      await ctx.resume();
    } catch {
      /* retry on next gesture */
    }
  }
}

export type AudioResumeHooks = {
  /** Called whenever the context becomes running (realign scheduler, etc.). */
  onRunning?: () => void;
  /**
   * After a hide/resume kick — restore mix duck, realign, title-bed arp.
   * Fires even when ctx.state still claims "running" (iOS zombie-running).
   */
  onResume?: () => void;
};

const watchedCtxs = new Set<AudioContext>();
const hooksFor = new WeakMap<AudioContext, AudioResumeHooks>();
let globalsBound = false;
/** After a hide / interrupt, the next capture-phase tap is the iOS-safe unlock. */
let pendingGestureKick = false;

function markBackgrounded(): void {
  pendingGestureKick = true;
}

function mergeHooks(ctx: AudioContext, hooks: AudioResumeHooks): AudioResumeHooks {
  const prev = hooksFor.get(ctx);
  const merged: AudioResumeHooks = {
    onRunning: hooks.onRunning ?? prev?.onRunning,
    onResume: hooks.onResume ?? prev?.onResume,
  };
  hooksFor.set(ctx, merged);
  return merged;
}

function kickWatched(reason: "visible" | "gesture" | "statechange"): void {
  if (reason !== "gesture" && document.visibilityState === "hidden") return;

  // iOS standalone often leaves AudioContext.state === "running" while the
  // silent HTMLAudio keep-alive is paused and the mix is dead. Always force
  // the keep-alive; treat paused keep-alive OR a non-running ctx as a kick.
  const keepDead = keepAliveNeedsKick();
  kickUnlockHtmlAudio(true);

  for (const ctx of watchedCtxs) {
    const state = ctx.state as string;
    if (state === "closed") continue;
    if (keepDead || ctxNeedsKick(ctx) || reason === "visible" || reason === "gesture") {
      kickResumeContext(ctx);
      const h = hooksFor.get(ctx);
      h?.onResume?.();
      if ((ctx.state as string) === "running") h?.onRunning?.();
    }
  }
}

function handleCtxState(ctx: AudioContext): void {
  const state = ctx.state as string;
  if (state === "running") {
    const h = hooksFor.get(ctx);
    h?.onRunning?.();
    h?.onResume?.();
    return;
  }
  if (state === "suspended" || state === "interrupted") {
    markBackgrounded();
    kickWatched("statechange");
  }
}

function onVisibleResume(): void {
  kickWatched("visible");
}

function onUserGesture(): void {
  if (!pendingGestureKick) return;
  pendingGestureKick = false;
  kickWatched("gesture");
}

function onVisibilitySignal(): void {
  if (document.visibilityState === "hidden") markBackgrounded();
  else onVisibleResume();
}

function bindResumeGlobals(): void {
  document.addEventListener("visibilitychange", onVisibilitySignal);
  document.addEventListener("webkitvisibilitychange", onVisibilitySignal);

  window.addEventListener("pageshow", (event) => {
    const persisted = "persisted" in event && Boolean((event as PageTransitionEvent).persisted);
    if (persisted) markBackgrounded();
    onVisibleResume();
  });
  window.addEventListener("pagehide", markBackgrounded);
  window.addEventListener("focus", onVisibleResume);

  document.addEventListener("fullscreenchange", onVisibleResume);
  document.addEventListener("webkitfullscreenchange", onVisibleResume);

  document.addEventListener("freeze", markBackgrounded);
  document.addEventListener("resume", onVisibleResume);

  // Capture only — do not preventDefault / stopPropagation so TAP TO JAM and
  // HUD (Reset, skip-dial) still receive the tap.
  const gestureOpts: AddEventListenerOptions = { capture: true, passive: true };
  document.addEventListener("pointerdown", onUserGesture, gestureOpts);
  document.addEventListener("touchstart", onUserGesture, gestureOpts);
  document.addEventListener("mousedown", onUserGesture, gestureOpts);
  document.addEventListener("click", onUserGesture, gestureOpts);

  const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
  session?.addEventListener?.("statechange", () => {
    if (session.state === "interrupted") {
      markBackgrounded();
      kickWatched("statechange");
    } else {
      onVisibleResume();
    }
  });
}

/**
 * Keep audio alive when Edge backgrounds the Home Screen web app, returns
 * from fullscreen, or WebKit flips the context to interrupted/suspended.
 *
 * Visibility is not a user gesture on iOS, so ctx.resume() from that
 * listener often fails. The next capture-phase tap retries the same path
 * without resetting the jam or starting TAP TO JAM.
 */
export function watchAudioResume(ctx: AudioContext, hooks: AudioResumeHooks = {}): void {
  mergeHooks(ctx, hooks);
  if (!watchedCtxs.has(ctx)) {
    watchedCtxs.add(ctx);
    ctx.addEventListener("statechange", () => handleCtxState(ctx));
  }
  if (!globalsBound) {
    globalsBound = true;
    bindResumeGlobals();
  }
  if ((ctx.state as string) === "running") hooks.onRunning?.();
}
