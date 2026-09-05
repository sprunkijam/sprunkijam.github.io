/**
 * Title-gate sound help for iPhone Edge / Safari (primary), plus a compact
 * Other-devices disclosure for Android / Windows / Mac.
 *
 * Always-visible calm iPhone guide (Silent OFF via side switch or setting +
 * Volume UP). A stronger nudge only uses real signals: AudioContext
 * suspended/interrupted after a gesture unlock attempt, title bed not
 * playing, or navigator.audioSession interrupted.
 *
 * There is NO public API for the hardware Ring/Silent switch or Silent
 * Mode setting. This module never claims we detected Silent. It does not
 * try to bypass Silent.
 */

import {
  isTitleBedPlaying,
  startTitleBed,
  titleBedAttempted,
  titleBedContextState,
} from "./titleBed";

export type SoundGuideMode = "calm" | "nudge" | "blocked";

type AudioSessionLike = {
  type?: string;
  state?: string;
};

type IdleFn = () => boolean;

let idle: IdleFn = () => true;
let checked = false;
let checkTimers: number[] = [];
let nudgeFadeTimer: number | null = null;

export function currentSoundGuideMode(): SoundGuideMode {
  const el = document.getElementById("sound-guide");
  const mode = el?.dataset.mode;
  if (mode === "blocked" || mode === "nudge") return mode;
  return "calm";
}

/**
 * Wire the title guide: taps never start the jam; they DO unlock the soft
 * title bed in the same gesture turn (iOS Edge / Safari need a user gesture).
 * Later gate gestures may upgrade the copy using best-effort audio signals.
 */
export function bindSoundGuide(isIdle: IdleFn): { onTitleBedGesture: () => void } {
  idle = isIdle;
  const guide = document.getElementById("sound-guide");
  if (guide) {
    const onGuideGesture = (e: Event): void => {
      // Kick bed before stopPropagation so guide taps never feel silent.
      // No await — unlock must stay in this user-gesture turn.
      startTitleBed();
      scheduleSoundGuideCheck();
      e.stopPropagation();
    };
    guide.addEventListener("pointerdown", onGuideGesture);
    guide.addEventListener("touchstart", onGuideGesture, { passive: true });
    guide.addEventListener("click", onGuideGesture);
  }
  setMode("calm", "");
  return { onTitleBedGesture: scheduleSoundGuideCheck };
}

function scheduleSoundGuideCheck(): void {
  if (checked) {
    // Extra gestures: re-probe in case a late resume flipped the context.
    queueChecks();
    return;
  }
  checked = true;
  queueChecks();
}

function queueChecks(): void {
  for (const id of checkTimers) window.clearTimeout(id);
  checkTimers = [];
  // resume() is async; a second pass catches a late unlock.
  checkTimers.push(window.setTimeout(() => applySoundGuideSignal(), 480));
  checkTimers.push(window.setTimeout(() => applySoundGuideSignal(), 1300));
}

function applySoundGuideSignal(): void {
  if (!idle()) return;
  if (hasBlockedAudioSignal()) {
    setMode(
      "blocked",
      "Hmm, the music didn't start yet. Turn Silent OFF (side switch, Action button, or Control Center), then Volume UP, and tap again!",
    );
    return;
  }
  // No definite “audio is blocked” signal — never claim we detected Silent.
  // After the first title-bed gesture, briefly emphasize the same guide.
  setMode(
    "nudge",
    "Still quiet? Turn Silent OFF — side switch, Action button, or Control Center.",
  );
  if (nudgeFadeTimer != null) window.clearTimeout(nudgeFadeTimer);
  nudgeFadeTimer = window.setTimeout(() => {
    nudgeFadeTimer = null;
    if (!idle()) return;
    if (currentSoundGuideMode() !== "nudge") return;
    setMode("calm", "");
  }, 7000);
}

/**
 * Real signals only. Hardware Silent / Silent Mode cannot be read; do not
 * treat a running (but inaudible) context as Silent.
 */
function hasBlockedAudioSignal(): boolean {
  if (!titleBedAttempted()) return false;
  const state = titleBedContextState();
  if (state === "suspended" || state === "interrupted") return true;
  if (!isTitleBedPlaying()) return true;
  const session = readAudioSession();
  if (session?.state === "interrupted") return true;
  // session.type is optional and not a mute detector — ignore it.
  return false;
}

function readAudioSession(): AudioSessionLike | null {
  const n = navigator as Navigator & { audioSession?: AudioSessionLike };
  return n.audioSession ?? null;
}

function setMode(mode: SoundGuideMode, nudgeText: string): void {
  const guide = document.getElementById("sound-guide");
  const nudge = document.getElementById("sound-guide-nudge");
  if (!guide) return;
  guide.dataset.mode = mode;
  guide.classList.toggle("is-nudge", mode === "nudge");
  guide.classList.toggle("is-blocked", mode === "blocked");
  if (nudge) {
    if (nudgeText) {
      nudge.hidden = false;
      nudge.textContent = nudgeText;
    } else {
      nudge.hidden = true;
      nudge.textContent = "";
    }
  }
}
