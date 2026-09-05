/**
 * Title-screen art warmup: Phase 1 first, then every other stage/portrait JPEG.
 * Progress is for the TAP TO JAM button. Warmup uses fetch (no bitmap decode);
 * Pixi / HTML <img> decode later and hit HTTP cache.
 */

import { artUrl } from "../publicUrl";
import {
  DEEP_HORROR_PORTRAIT_URLS,
  HORROR_PORTRAIT_URLS,
  JEVIN_SCYTHE_URL,
  PORTRAIT_URLS,
} from "./artUrls";

export type WarmupProgress = {
  done: number;
  total: number;
  /** 0–100 integer */
  percent: number;
  complete: boolean;
};

type Listener = (p: WarmupProgress) => void;

function phaseBgUrls(set: number): string[] {
  return [artUrl(`bg-phase${set}-landscape.jpeg`), artUrl(`bg-phase${set}-portrait.jpeg`)];
}

/** Unique art URLs the jam needs before a blank-free start. */
export function jamArtUrls(): { first: string[]; rest: string[] } {
  const first = [...phaseBgUrls(1)];
  const rest = new Set<string>();
  for (let set = 2; set <= 7; set++) {
    for (const u of phaseBgUrls(set)) rest.add(u);
  }
  for (const map of [PORTRAIT_URLS, HORROR_PORTRAIT_URLS, DEEP_HORROR_PORTRAIT_URLS]) {
    for (const u of Object.values(map)) {
      if (u) rest.add(u);
    }
  }
  rest.add(JEVIN_SCYTHE_URL);
  // Title heroes use ~4000px title JPEGs (not the 6000px masters).
  for (const u of [
    artUrl("intro-ring-landscape-title.jpeg"),
    artUrl("intro-ring-portrait-title.jpeg"),
    artUrl("intro-black-vineria-landscape-title.jpeg"),
    artUrl("intro-black-vineria-portrait-title.jpeg"),
  ]) {
    rest.add(u);
  }
  // Drop anything already in first.
  for (const u of first) rest.delete(u);
  return { first, rest: [...rest].sort() };
}

/**
 * Warm the HTTP / SW cache only — do not decode into an Image bitmap.
 * Decoding Phase 1 / intro masters (24MP) on the title used to pin multi-hundred
 * MB before TAP TO JAM; Pixi loads later and Windows already caps GPU upload.
 */
function loadOne(url: string): Promise<void> {
  return fetch(url, { credentials: "same-origin", cache: "force-cache" })
    .then((res) => {
      // Drain the body so the response is fully cached; ignore bytes.
      if (res.body) return res.arrayBuffer().then(() => undefined);
      return undefined;
    })
    .catch(() => undefined); // missing art must not block start forever
}

let started = false;
let done = 0;
let total = 0;
let complete = false;
let waiters: Array<() => void> = [];
const listeners = new Set<Listener>();

function snapshot(): WarmupProgress {
  const percent = total <= 0 ? 100 : Math.min(100, Math.round((done / total) * 100));
  return { done, total, percent: complete ? 100 : percent, complete };
}

function emit(): void {
  const p = snapshot();
  for (const fn of listeners) fn(p);
  if (p.complete) {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  }
}

export function getWarmupProgress(): WarmupProgress {
  return snapshot();
}

export function onWarmupProgress(fn: Listener): () => void {
  listeners.add(fn);
  fn(snapshot());
  return () => {
    listeners.delete(fn);
  };
}

export function whenWarmupComplete(): Promise<void> {
  if (complete) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/**
 * Kick title warmup. Safe to call once. Loads Phase 1 backgrounds first, then
 * every other jam JPEG. Does not touch WebGL / Pixi.
 */
export function startTitleWarmup(): void {
  if (started) return;
  started = true;
  const { first, rest } = jamArtUrls();
  const all = [...first, ...rest];
  total = all.length;
  done = 0;
  complete = total === 0;
  emit();

  void (async () => {
    for (const url of first) {
      await loadOne(url);
      done += 1;
      emit();
    }
    // Parallel batch for the rest — keep the main thread responsive.
    const concurrency = 4;
    let i = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (i < rest.length) {
          const idx = i;
          i += 1;
          await loadOne(rest[idx]!);
          done += 1;
          emit();
        }
      }),
    );
    complete = true;
    emit();
  })();
}
