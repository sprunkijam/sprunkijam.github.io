/**
 * PWA update helpers — testable without virtual:pwa-register.
 *
 * Family testers should pick up new deploys without a hard refresh. The
 * service worker script and HTML must revalidate; hashed /assets stay cached.
 * Reloads wait for the title/gate (or Reset, which already reloads) so a
 * phase-hop scare is not cut off.
 */

import { publicUrl } from "../publicUrl";

/** Ask the browser for a fresh `sw.js` this often once a worker is registered. */
export const SW_UPDATE_INTERVAL_MS = 60 * 1000;

/** Collapse focus / pageshow / visibilitychange into one check. */
export const SW_UPDATE_DEBOUNCE_MS = 250;

/** Brief "Updating…" paint before we actually reload. */
export const UPDATE_FLASH_MS = 140;

const BUILD_RELOAD_KEY = "jam-build-reload";

export type UpdateCheckFns = {
  intervalMs?: number;
  debounceMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => number;
  clearIntervalFn?: (id: number) => void;
  setTimeoutFn?: (handler: () => void, ms: number) => number;
  clearTimeoutFn?: (id: number) => void;
  addEventListenerFn?: (
    target: EventTarget,
    type: string,
    listener: EventListener,
  ) => void;
  removeEventListenerFn?: (
    target: EventTarget,
    type: string,
    listener: EventListener,
  ) => void;
  target?: EventTarget;
  doc?: Document;
};

export type UpdateCheckHandle = {
  dispose: () => void;
  checkNow: () => void;
};

export type SafeReloadController = {
  request: () => void;
  onSafeMoment: () => void;
  isPending: () => boolean;
};

/**
 * Title/gate is showing, or Reset already cleared `data-ready` and is about
 * to reload. Mid-jam (`data-ready=1`) is not a safe reload moment.
 */
export function isTitleGateShowing(doc: Document = document): boolean {
  if (doc.body.dataset.ready === "1") return false;
  const gate = doc.getElementById("gate");
  if (!gate) return true;
  return !gate.classList.contains("gone");
}

export function isScareOverlayShowing(doc: Document = document): boolean {
  const scare = doc.getElementById("scare");
  return Boolean(scare && !scare.hidden);
}

export function isSafeToReload(
  doc: Document = document,
  extras?: { hopBusy?: boolean },
): boolean {
  if (extras?.hopBusy) return false;
  if (isScareOverlayShowing(doc)) return false;
  return isTitleGateShowing(doc);
}

export function versionChanged(local: string, remote: string | null): boolean {
  return Boolean(local && remote && local !== remote);
}

export async function fetchBuildVersion(
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetcher(`${publicUrl("version.json")}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { v?: unknown };
    return typeof data.v === "string" && data.v.length > 0 ? data.v : null;
  } catch {
    return null;
  }
}

/** Remember we already tried a version.json reload this tab so a stuck SW cannot loop. */
export function shouldAttemptVersionReload(
  remote: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultSessionStorage(),
): boolean {
  if (!remote) return false;
  if (!storage) return true;
  try {
    if (storage.getItem(BUILD_RELOAD_KEY) === remote) return false;
    storage.setItem(BUILD_RELOAD_KEY, remote);
    return true;
  } catch {
    return true;
  }
}

function defaultSessionStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Call `check` immediately, on an interval, and when the tab becomes visible
 * again (visibilitychange, focus, pageshow).
 */
export function bindUpdateChecks(
  check: () => void,
  options: UpdateCheckFns = {},
): UpdateCheckHandle {
  const intervalMs = options.intervalMs ?? SW_UPDATE_INTERVAL_MS;
  const debounceMs = options.debounceMs ?? SW_UPDATE_DEBOUNCE_MS;
  const setInt = options.setIntervalFn ?? ((h, ms) => window.setInterval(h, ms));
  const clearInt = options.clearIntervalFn ?? ((id) => window.clearInterval(id));
  const setTo = options.setTimeoutFn ?? ((h, ms) => window.setTimeout(h, ms));
  const clearTo = options.clearTimeoutFn ?? ((id) => window.clearTimeout(id));
  const add =
    options.addEventListenerFn ??
    ((target, type, listener) => target.addEventListener(type, listener));
  const remove =
    options.removeEventListenerFn ??
    ((target, type, listener) => target.removeEventListener(type, listener));
  const target = options.target ?? window;
  const doc = options.doc ?? document;

  let debounceId: number | null = null;

  const run = (): void => {
    check();
  };

  const schedule = (): void => {
    if (debounceId != null) clearTo(debounceId);
    debounceId = setTo(() => {
      debounceId = null;
      run();
    }, debounceMs);
  };

  const onVisible = (): void => {
    if (doc.visibilityState === "hidden") return;
    schedule();
  };

  add(target, "focus", onVisible);
  add(target, "pageshow", onVisible);
  add(doc, "visibilitychange", onVisible);

  const intervalId = setInt(() => {
    if (doc.visibilityState === "hidden") return;
    run();
  }, intervalMs);

  run();

  return {
    checkNow: run,
    dispose: () => {
      clearInt(intervalId);
      if (debounceId != null) clearTo(debounceId);
      remove(target, "focus", onVisible);
      remove(target, "pageshow", onVisible);
      remove(doc, "visibilitychange", onVisible);
    },
  };
}

export function createSafeReload(options: {
  isSafe: () => boolean;
  reload: () => void;
  showFlash?: () => void;
  flashMs?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => number;
}): SafeReloadController {
  let pending = false;
  let inFlight = false;
  const flashMs = options.flashMs ?? UPDATE_FLASH_MS;
  const setTo = options.setTimeoutFn ?? ((h, ms) => window.setTimeout(h, ms));

  const go = (): void => {
    if (inFlight) return;
    inFlight = true;
    pending = false;
    options.showFlash?.();
    setTo(() => options.reload(), flashMs);
  };

  return {
    request: () => {
      if (inFlight) return;
      if (options.isSafe()) go();
      else pending = true;
    },
    onSafeMoment: () => {
      if (inFlight || !pending) return;
      if (options.isSafe()) go();
    },
    isPending: () => pending,
  };
}

/**
 * vite-plugin-pwa `autoUpdate` reloads from workbox-window's `activated`
 * listener via `location.reload()`. Gate in-jam reloads; let title + Reset
 * through (Reset clears `data-ready` before it reloads).
 */
export function installInJamReloadGate(onInJamReload: () => void): {
  hooked: boolean;
  nativeReload: () => void;
} {
  const nativeReload = window.location.reload.bind(window.location);
  let hooked = false;
  const gated = function (this: Location): void {
    if (document.body.dataset.ready === "1") {
      onInJamReload();
      return;
    }
    nativeReload();
  };
  try {
    window.location.reload = gated as typeof window.location.reload;
    hooked = window.location.reload !== nativeReload;
  } catch {
    hooked = false;
  }
  return { hooked, nativeReload };
}
