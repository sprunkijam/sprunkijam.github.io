import { PERFORMER_STEMS, SLOT_IDS, type SlotId, type StemId } from "../types";

/** Device-local high score. Survives reload; no accounts. */
export const SECRET_HIGH_SCORE_KEY = "sprunki-jam-secret-high-score";

export const SECRET_LIVES = 3;

/** Never light every pad — one dark tile is always a trap. */
export const SECRET_MAX_TARGETS = 4;

export type SecretStatus = "idle" | "playing" | "over";

/**
 * hit — correct pad, set still open.
 * clear — last remaining pad of a 2+ set (flourish).
 * miss — wrong pad, decoy, or timeout with leftovers.
 * ignore — no prompt, already-cleared pad in this set, or not playing.
 */
export type SecretTapResult = "hit" | "clear" | "miss" | "ignore";

export interface SecretPrompt {
  /** Original lit set (1–4 pads). */
  targets: SlotId[];
  /** Still need a tap. */
  remaining: SlotId[];
  /** Brief fake pulse — tapping it is a miss. Never used on a 4-pad set. */
  decoy: SlotId | null;
  decoyUntil: number;
  spawnedAt: number;
  windowMs: number;
  expiresAt: number;
  /** Unique friend per pad in this prompt (targets + decoy). */
  faces: Partial<Record<SlotId, StemId>>;
}

export interface SecretFx {
  slot: SlotId;
  until: number;
  kind: "hit" | "miss";
}

export interface SecretDifficulty {
  windowMs: number;
  /** Extra milliseconds per pad beyond the first, shared across the set. */
  padSlackMs: number;
  gapMs: number;
  decoyChance: number;
  targetCount: number;
}

export interface SecretSnapshot {
  status: SecretStatus;
  score: number;
  lives: number;
  streak: number;
  highScore: number;
  /** First remaining target (compat with single-pad tests). */
  target: SlotId | null;
  /** Remaining lit pads that still need a tap. */
  targets: SlotId[];
  decoy: SlotId | null;
  /** Friend shown on each active / decoy / losing pad. */
  faces: Partial<Record<SlotId, StemId>>;
  /** Pads flashing red after a miss or timeout. */
  loseSlots: SlotId[];
  windowMs: number;
  elapsedMs: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

/**
 * Typical concurrent count at a given run time.
 * 0–16s: 1 pad. Then 2, then 3, then 4. Never 5.
 */
export function secretTargetCount(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000;
  if (t < 16) return 1;
  if (t < 40) return 2;
  if (t < 70) return 3;
  return SECRET_MAX_TARGETS;
}

/**
 * Faster than the shipped single-pad curve.
 * Early: ~1.26s. Quadratic over ~130s down to ~140ms base.
 * Extra pads get a shrinking slack so 4-wide late game is a blink.
 */
export function secretDifficulty(elapsedMs: number): SecretDifficulty {
  const t = Math.max(0, elapsedMs) / 1000;
  const u = Math.min(1, t / 130);
  const steep = u * u;
  return {
    windowMs: Math.round(lerp(1260, 140, steep)),
    padSlackMs: Math.round(lerp(140, 32, steep)),
    gapMs: Math.round(lerp(380, 0, Math.min(1, t / 95))),
    decoyChance: t < 48 ? 0 : lerp(0.12, 0.42, Math.min(1, (t - 48) / 70)),
    targetCount: secretTargetCount(elapsedMs),
  };
}

export function secretWindowForCount(elapsedMs: number, count: number): number {
  const diff = secretDifficulty(elapsedMs);
  const n = Math.max(1, Math.min(SECRET_MAX_TARGETS, count));
  return diff.windowMs + (n - 1) * diff.padSlackMs;
}

export function loadSecretHighScore(
  storage: Pick<Storage, "getItem"> | null = defaultLocalStorage(),
): number {
  if (!storage) return 0;
  try {
    const raw = storage.getItem(SECRET_HIGH_SCORE_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function saveSecretHighScore(
  score: number,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultLocalStorage(),
): number {
  const n = Number.isFinite(score) ? Math.max(0, Math.floor(score)) : 0;
  const next = Math.max(n, loadSecretHighScore(storage));
  if (!storage) return next;
  try {
    storage.setItem(SECRET_HIGH_SCORE_KEY, String(next));
  } catch {
    /* private mode / quota */
  }
  return next;
}

function defaultLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function shuffleSlots(rng: () => number): SlotId[] {
  const out = [...SLOT_IDS];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a && b) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

function setKey(slots: readonly SlotId[]): string {
  return [...slots].sort().join(",");
}

function pickTargets(count: number, avoid: readonly SlotId[], rng: () => number): SlotId[] {
  const n = Math.max(1, Math.min(SECRET_MAX_TARGETS, count));
  const avoidKey = setKey(avoid);
  let picked = shuffleSlots(rng).slice(0, n);
  if (setKey(picked) === avoidKey) {
    picked = shuffleSlots(rng).slice(0, n);
  }
  return picked;
}

function pickFaces(slots: readonly SlotId[], rng: () => number): Partial<Record<SlotId, StemId>> {
  const pool = [...PERFORMER_STEMS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    const a = pool[i];
    const b = pool[j];
    if (a && b) {
      pool[i] = b;
      pool[j] = a;
    }
  }
  const faces: Partial<Record<SlotId, StemId>> = {};
  for (let i = 0; i < slots.length; i++) {
    const id = slots[i];
    const stem = pool[i];
    if (id && stem) faces[id] = stem;
  }
  return faces;
}

function asSlotList(slots: SlotId | readonly SlotId[]): SlotId[] {
  const raw = typeof slots === "string" ? [slots] : [...slots];
  const uniq: SlotId[] = [];
  for (const id of raw) {
    if ((SLOT_IDS as readonly string[]).includes(id) && !uniq.includes(id)) uniq.push(id);
  }
  return uniq.slice(0, SECRET_MAX_TARGETS);
}

export class SecretRun {
  status: SecretStatus = "idle";
  score = 0;
  lives = SECRET_LIVES;
  streak = 0;
  startedAt = 0;
  nextAt = 0;
  prompt: SecretPrompt | null = null;
  fx: SecretFx | null = null;
  highScore = 0;
  lastTargets: SlotId[] = [];
  /** Last fully cleared 2+ set — jam uses this for the flourish chord. */
  lastCleared: SlotId[] = [];
  loseSlots: SlotId[] = [];
  loseFaces: Partial<Record<SlotId, StemId>> = {};
  loseUntil = 0;
  private rng: () => number = Math.random;

  get active(): boolean {
    return this.status === "playing" || this.status === "over";
  }

  snapshot(now = performance.now()): SecretSnapshot {
    const remaining = this.prompt?.remaining ?? [];
    return {
      status: this.status,
      score: this.score,
      lives: this.lives,
      streak: this.streak,
      highScore: this.highScore,
      target: remaining[0] ?? null,
      targets: [...remaining],
      decoy: this.decoyLive(now) ? this.prompt?.decoy ?? null : null,
      faces: this.liveFaces(now),
      loseSlots: this.loseLive(now) ? [...this.loseSlots] : [],
      windowMs: this.prompt?.windowMs ?? secretDifficulty(this.elapsedMs(now)).windowMs,
      elapsedMs: this.elapsedMs(now),
    };
  }

  elapsedMs(now = performance.now()): number {
    if (this.status === "idle") return 0;
    return Math.max(0, now - this.startedAt);
  }

  decoyLive(now = performance.now()): boolean {
    const p = this.prompt;
    return Boolean(p?.decoy && now < p.decoyUntil);
  }

  loseLive(now = performance.now()): boolean {
    return this.loseSlots.length > 0 && now < this.loseUntil;
  }

  liveFaces(now = performance.now()): Partial<Record<SlotId, StemId>> {
    if (this.prompt) return { ...this.prompt.faces };
    if (this.loseLive(now)) return { ...this.loseFaces };
    return {};
  }

  start(now = performance.now()): void {
    this.status = "playing";
    this.score = 0;
    this.lives = SECRET_LIVES;
    this.streak = 0;
    this.startedAt = now;
    this.prompt = null;
    this.fx = null;
    this.lastTargets = [];
    this.lastCleared = [];
    this.loseSlots = [];
    this.loseFaces = {};
    this.loseUntil = 0;
    this.highScore = loadSecretHighScore();
    this.nextAt = now + 420;
  }

  /** Leave without writing a new high score (BACK TO JAM mid-run). */
  abort(): void {
    this.status = "idle";
    this.prompt = null;
    this.fx = null;
    this.nextAt = 0;
    this.streak = 0;
    this.lastCleared = [];
    this.loseSlots = [];
    this.loseFaces = {};
    this.loseUntil = 0;
  }

  endRun(now = performance.now()): void {
    this.status = "over";
    this.prompt = null;
    this.nextAt = 0;
    this.highScore = saveSecretHighScore(this.score);
    this.fx = null;
    void now;
  }

  /**
   * Advance timers. Returns whether the HUD/pads need a redraw.
   */
  tick(now: number): { dirty: boolean; timedOut: boolean; spawned: boolean } {
    let dirty = false;
    let timedOut = false;
    let spawned = false;
    if (this.fx && now >= this.fx.until) {
      this.fx = null;
      dirty = true;
    }
    if (this.loseSlots.length && now >= this.loseUntil) {
      this.loseSlots = [];
      this.loseFaces = {};
      dirty = true;
    }
    if (this.status !== "playing") return { dirty, timedOut, spawned };

    const p = this.prompt;
    if (p && now >= p.expiresAt) {
      this.registerMiss(now, "timeout");
      timedOut = true;
      dirty = true;
      if (this.status !== "playing") return { dirty, timedOut, spawned };
    }

    if (!this.prompt && now >= this.nextAt) {
      this.spawn(now);
      spawned = true;
      dirty = true;
    } else if (p && p.decoy && now >= p.decoyUntil && now < p.decoyUntil + 32) {
      dirty = true;
    }
    return { dirty, timedOut, spawned };
  }

  tap(slot: SlotId, now = performance.now()): SecretTapResult {
    if (this.status !== "playing") return "ignore";
    const p = this.prompt;
    if (!p) return "ignore";

    if (p.remaining.includes(slot)) {
      return this.registerPadHit(slot, now);
    }
    // Already cleared in this set — fat-finger ignore, not a miss.
    if (p.targets.includes(slot)) return "ignore";
    this.registerMiss(now, slot);
    return "miss";
  }

  /**
   * Playwright: pin a long-lived set so taps can score without racing the timer.
   */
  forcePrompt(slots: SlotId | readonly SlotId[], windowMs = 10_000, now = performance.now()): void {
    if (this.status !== "playing") this.start(now);
    const targets = asSlotList(slots);
    const list = targets.length > 0 ? targets : (["mid"] as SlotId[]);
    this.prompt = {
      targets: [...list],
      remaining: [...list],
      decoy: null,
      decoyUntil: now,
      spawnedAt: now,
      windowMs,
      expiresAt: now + windowMs,
      faces: pickFaces(list, this.rng),
    };
    this.lastTargets = [...list];
    this.nextAt = now + windowMs + 50;
  }

  private registerPadHit(slot: SlotId, now: number): SecretTapResult {
    const p = this.prompt;
    if (!p) return "ignore";
    p.remaining = p.remaining.filter((id) => id !== slot);
    this.score += 1;
    this.streak += 1;
    this.fx = { slot, until: now + 140, kind: "hit" };
    if (p.remaining.length > 0) return "hit";

    const setSize = p.targets.length;
    this.lastCleared = setSize > 1 ? [...p.targets] : [];
    this.prompt = null;
    const gap = secretDifficulty(this.elapsedMs(now)).gapMs;
    this.nextAt = now + Math.max(40, gap);
    return setSize > 1 ? "clear" : "hit";
  }

  private registerMiss(now: number, slot: SlotId | "timeout"): void {
    const remaining = this.prompt?.remaining ?? [];
    const faces = this.prompt?.faces ?? {};
    if (slot === "timeout") {
      this.loseSlots = [...remaining];
      this.loseFaces = {};
      for (const id of remaining) {
        const stem = faces[id];
        if (stem) this.loseFaces[id] = stem;
      }
    } else {
      this.loseSlots = [slot];
      this.loseFaces = faces[slot] ? { [slot]: faces[slot] } : {};
    }
    // Long enough to read as a red flash (and for Playwright to sample glow).
    this.loseUntil = now + 900;
    this.lives -= 1;
    this.streak = 0;
    this.prompt = null;
    this.lastCleared = [];
    if (slot !== "timeout") {
      this.fx = { slot, until: now + 700, kind: "miss" };
    }
    if (this.lives <= 0) {
      this.endRun(now);
      return;
    }
    const gap = secretDifficulty(this.elapsedMs(now)).gapMs;
    this.nextAt = now + Math.max(180, gap + 120);
  }

  private spawn(now: number): void {
    const elapsed = this.elapsedMs(now);
    const diff = secretDifficulty(elapsed);
    const rng = this.rng;
    let count = diff.targetCount;
    if (count > 1 && rng() < 0.18) count -= 1;
    const targets = pickTargets(count, this.lastTargets, rng);
    const n = targets.length;
    const windowMs = diff.windowMs + (n - 1) * diff.padSlackMs;

    let decoy: SlotId | null = null;
    let decoyUntil = now;
    if (n < SECRET_MAX_TARGETS && rng() < diff.decoyChance) {
      const pool = SLOT_IDS.filter((id) => !targets.includes(id));
      decoy = pool[Math.floor(rng() * pool.length) % pool.length] ?? null;
      const decoyMs = Math.min(180, Math.max(80, windowMs * 0.22));
      decoyUntil = now + decoyMs;
    }

    this.prompt = {
      targets: [...targets],
      remaining: [...targets],
      decoy,
      decoyUntil,
      spawnedAt: now,
      windowMs,
      expiresAt: now + windowMs,
      faces: pickFaces(decoy ? [...targets, decoy] : targets, rng),
    };
    this.lastTargets = [...targets];
  }
}
