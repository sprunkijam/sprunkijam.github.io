import { registerSW } from "virtual:pwa-register";
import {
  bindUpdateChecks,
  createSafeReload,
  fetchBuildVersion,
  installInJamReloadGate,
  isSafeToReload,
  shouldAttemptVersionReload,
  versionChanged,
  type UpdateCheckFns,
  type UpdateCheckHandle,
} from "./updates";

export type PwaHopBusy = () => boolean;

let hopBusy: PwaHopBusy = () => false;
let pwaRegistered = false;
let updateLoop: UpdateCheckHandle | null = null;
let swRegistration: ServiceWorkerRegistration | null = null;
let hadController = false;

const nativeReloadHolder = {
  fn: (): void => {
    window.location.reload();
  },
};

function showUpdatingFlash(): void {
  const el = document.getElementById("update-flash");
  if (!el) return;
  el.hidden = false;
}

const pwaReload = createSafeReload({
  isSafe: () => isSafeToReload(document, { hopBusy: hopBusy() }),
  reload: () => nativeReloadHolder.fn(),
  showFlash: showUpdatingFlash,
});

const reloadGate = installInJamReloadGate(() => pwaReload.request());
nativeReloadHolder.fn = () => reloadGate.nativeReload();

function checkForUpdates(): void {
  const safe = isSafeToReload(document, { hopBusy: hopBusy() });
  // If we cannot intercept autoUpdate's location.reload, only fetch a new
  // worker when a reload would be safe (title / Reset).
  if (swRegistration && (safe || reloadGate.hooked)) {
    void swRegistration.update();
  }
  void pollBuildVersion();
  pwaReload.onSafeMoment();
}

async function pollBuildVersion(): Promise<void> {
  const remote = await fetchBuildVersion();
  if (!versionChanged(__JAM_BUILD_VERSION__, remote) || !remote) return;
  if (!shouldAttemptVersionReload(remote)) return;
  pwaReload.request();
}

function startUpdateLoop(): void {
  if (updateLoop) return;
  updateLoop = bindUpdateChecks(checkForUpdates);
}

function onControllerChange(): void {
  if (!hadController) {
    hadController = true;
    return;
  }
  pwaReload.request();
}

function bindControllerChange(): void {
  if (!("serviceWorker" in navigator)) return;
  hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
}

function registerPwa(): void {
  if (pwaRegistered) return;
  pwaRegistered = true;
  startUpdateLoop();
  try {
    const updateSW = registerSW({
      immediate: true,
      // autoUpdate SW already skipWaiting + clientsClaim. If this still fires
      // (waiting worker), apply it — do not leave the update stuck.
      onNeedRefresh() {
        void updateSW(false);
        pwaReload.request();
      },
      onOfflineReady() {
        /* precache ready; no toast */
      },
      onRegisteredSW(_url, registration) {
        if (registration) swRegistration = registration;
      },
    });
  } catch (err) {
    console.error(err);
  }
}

/**
 * First visit: do not register a SW until after TAP TO JAM so a cold iPhone
 * load cannot have the worker hijack hashed `/assets` mid-fetch.
 *
 * Return visit (Home Screen / already installed): after `load`, the SW is
 * already controlling — attach workbox-window on the title so a new deploy
 * can reload before the jam starts.
 */
export function bootPwa(isHopBusy: PwaHopBusy): void {
  hopBusy = isHopBusy;
  bindControllerChange();

  const afterLoad = (): void => {
    startUpdateLoop();
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistration().then((existing) => {
      if (!existing) return;
      swRegistration = existing;
      registerPwa();
    });
  };

  if (document.readyState === "complete") afterLoad();
  else window.addEventListener("load", afterLoad, { once: true });
}

/** Call only after TAP TO JAM has entered the jam (iPhone cold-load safety). */
export function registerPwaAfterStart(): void {
  registerPwa();
}

/** Playwright hooks — keep names off the title UI. */
export function pwaTestHooks(isHopBusy: PwaHopBusy): {
  safeToReload: () => boolean;
  reloadPending: () => boolean;
  requestReload: () => void;
  bindUpdateChecks: (check: () => void, options?: UpdateCheckFns) => UpdateCheckHandle;
  buildVersion: () => string;
  versionChanged: (local: string, remote: string | null) => boolean;
} {
  return {
    safeToReload: () => isSafeToReload(document, { hopBusy: isHopBusy() }),
    reloadPending: () => pwaReload.isPending(),
    requestReload: () => pwaReload.request(),
    bindUpdateChecks,
    buildVersion: () => __JAM_BUILD_VERSION__,
    versionChanged,
  };
}
