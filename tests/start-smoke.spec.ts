import { devices, expect, test, type Page } from "@playwright/test";

function overlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

async function assertSkipDialOneRow(page: Page): Promise<void> {
  const buttons = page.locator("#skip-dial button");
  await expect(buttons).toHaveCount(5);
  const boxes = await buttons.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom };
    }),
  );
  expect(boxes).toHaveLength(5);
  const topSpread = Math.max(...boxes.map((b) => b.top)) - Math.min(...boxes.map((b) => b.top));
  expect(topSpread, "2 / 10 / 100 / 1,000 / 100,000 must stay on one row").toBeLessThan(5);
  for (const b of boxes) {
    expect(b.w, "kid-sized tap width").toBeGreaterThanOrEqual(24);
    expect(b.h, "kid-sized tap height").toBeGreaterThanOrEqual(20);
  }

  const reset = await page.locator("#reset-btn").boundingBox();
  const badge = await page.locator("#phase-badge").boundingBox();
  const dial = await page.locator("#skip-dial").boundingBox();
  const hint = await page.locator("#hint").boundingBox();
  expect(reset && badge && dial && hint).toBeTruthy();
  expect(overlap(reset!, dial!), "skip dial must not cover Reset").toBe(false);
  expect(overlap(badge!, dial!), "skip dial must not cover PHASE").toBe(false);
  expect(dial!.y + dial!.height, "skip dial must sit above the hint").toBeLessThanOrEqual(hint!.y + 2);
}

function assertPhotoOnlyBg(
  cov: {
    covers?: boolean;
    phaseNumeral?: boolean;
    benchOverlay?: boolean;
    set?: number;
  } | null,
  expectedSet: number,
  label: string,
): void {
  expect(cov, label).toBeTruthy();
  expect(cov!.covers, `${label}: photo must cover the stage, got ${JSON.stringify(cov)}`).toBe(true);
  expect(cov!.phaseNumeral, `${label}: giant phase numeral must not overlay the photo`).toBe(false);
  expect(cov!.benchOverlay, `${label}: translucent bench must not overlay the photo`).toBe(false);
  expect(cov!.set, `${label}: background set`).toBe(expectedSet);
}

/** Simulate leaving a Home Screen web app and coming back (no real iPhone). */
async function simulateAppHideShow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const setVis = (state: "hidden" | "visible"): void => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => state === "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    setVis("hidden");
    window.dispatchEvent(new Event("pagehide"));
    setVis("visible");
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new Event("focus"));
  });
}

async function tapStageNotReset(page: Page): Promise<void> {
  const canvas = page.locator("#stage-root canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  await canvas.tap({
    position: { x: Math.floor((box?.width ?? 200) / 2), y: Math.floor((box?.height ?? 400) / 2) },
  });
}

async function stillInJam(page: Page): Promise<void> {
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#reset-btn")).toBeVisible();
  const gateGone = await page.evaluate(() => {
    const g = document.getElementById("gate");
    return !g || g.classList.contains("gone");
  });
  expect(gateGone, "must stay in the jam — resume must not dump to the title").toBe(true);
}

async function seatBlackAndShowDial(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("black", "mid");
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 10_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#skip-dial")).toBeVisible();
}

/**
 * Cold-load → TAP TO JAM → game ready + AudioContext running.
 * Targets the iPhone Edge / Safari start path (WebKit under the hood on device).
 *
 * Note: iOS Silent (side switch or Silent Mode setting) mutes Web Audio in
 * Safari/Edge — that is expected platform behavior, not a game bug. CI
 * Chromium has no Silent control. We never claim we detected Silent.
 */
test("cold load TAP TO JAM enters game with AudioContext running", async ({ page }) => {
  // Long title-guide assertions + Pixi boot on software WebGL CI.
  test.setTimeout(90_000);
  await page.goto("/", { waitUntil: "networkidle" });

  const jamBtn = page.locator("#jam-btn");
  await expect(page.locator("#jam-btn")).toBeVisible();
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  await expect(page.locator("#renderer-select")).toHaveCount(0);
  await expect(page.locator("#renderer-picker")).toHaveCount(0);
  await expect(page.locator("#build-version")).toBeVisible();
  await expect(page.locator("#secret-btn")).toBeHidden();
  await expect(page.locator("#gate-error")).toBeHidden();
  await expect(page).toHaveTitle(/Sprunki and Rainbow Friends Jam/i);
  await expect(page.getByRole("heading", { name: /SPRUNKI AND/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /RAINBOW FRIENDS/i })).toBeVisible();
  await expect(page.locator("#gate-nate")).toHaveCount(0);
  await expect(page.getByText(/Art and Game by Nate/i)).toHaveCount(0);
  await expect(page.getByText(/Art by Nate/i)).toHaveCount(0);
  await expect(page.getByText("FAMILY JAM")).toHaveCount(0);
  await expect(page.getByText(/fear-loving kid/i)).toHaveCount(0);
  await expect(page.locator("#welcome-marquee")).toBeVisible();
  await expect(page.locator("#welcome-marquee")).toContainText(
    /Welcome to Sprunki and Rainbow Friends Jam/i,
  );
  await expect(page.locator("#welcome-marquee")).toContainText(/just as Mr\. Black planned/i);
  await expect(page.locator("#welcome-marquee")).toContainText("💎");
  await expect(page.locator(".welcome-marquee-divider")).toHaveCount(2);
  await expect(page.getByText(/backyard concert/i)).toHaveCount(0);
  await expect(page.locator(".gate-credit")).toHaveCount(0);
  await expect(page.getByText(/No ads\. No accounts\. No tracking/i)).toHaveCount(0);
  await expect(page.locator("#ring-egg")).toHaveCount(0);
  await expect(page.locator("#ring-hotspot")).toBeVisible();

  // Sound + Home Screen help is collapsed so TAP TO JAM stays uncrowded.
  const gateHelp = page.locator("#gate-help");
  await expect(gateHelp).toBeVisible();
  await expect(page.locator("#gate-help-summary")).toHaveText(/Sound & full screen help/i);
  await expect(gateHelp).not.toHaveAttribute("open");
  await expect(page.locator("#sound-guide")).toBeHidden();
  await expect(page.locator("#play-guide")).toBeHidden();

  // Expand: teaching copy appears; expanding must not start the jam.
  await page.locator("#gate-help-summary").tap();
  await expect(gateHelp).toHaveJSProperty("open", true);
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(jamBtn).toHaveText("TAP TO JAM");

  const guide = page.locator("#sound-guide");
  await expect(guide).toBeVisible();
  await expect(guide).toContainText(/iPhone sound/i);
  await expect(guide).toContainText(/Silent OFF/i);
  await expect(guide).toContainText(/side switch/i);
  await expect(guide).toContainText(/Action/i);
  await expect(guide).toContainText(/Control Center/i);
  await expect(guide).toContainText(/Settings/i);
  await expect(guide).toContainText(/Volume up/i);
  await expect(guide).toContainText(/Tap anywhere on this screen to turn the music on/i);
  await expect(guide.locator('img[src*="icon-iphone-silent"]')).toBeVisible();
  await expect(guide.locator('img[src*="icon-iphone-sound"]')).toBeVisible();
  await expect(guide.locator('img[src*="icon-volume-up"]')).toBeVisible();
  // Expanding help unlocks the title bed, so mode may already be nudge/blocked.
  await expect(guide).not.toContainText(/detected silent/i);
  const guideMode = await guide.getAttribute("data-mode");
  expect(["calm", "nudge", "blocked"]).toContain(guideMode);

  const other = page.locator("#sound-guide-other");
  await expect(other.locator("summary")).toBeVisible();
  await expect(other.locator("summary")).toHaveText(/Other devices/i);
  await expect(other).not.toHaveAttribute("open");
  await other.locator("summary").tap();
  await expect(other).toHaveJSProperty("open", true);
  await expect(other).toContainText(/Android/i);
  await expect(other).toContainText(/Media/i);
  await expect(other).toContainText(/Windows/i);
  await expect(other).toContainText(/Volume Mixer/i);
  await expect(other).toContainText(/Mac/i);
  await expect(other).toContainText(/unmute the tab/i);

  // Playwright iPhone preset UA looks like Safari — Safari steps are primary;
  // Edge / Android / Windows / Mac sit under Other devices.
  const playGuide = page.locator("#play-guide");
  await expect(playGuide).toBeVisible();
  await expect(playGuide).toContainText(/Best played in full screen/i);
  await expect(playGuide.locator("#play-guide-primary")).toContainText(/Safari/i);
  await expect(playGuide.locator("#play-guide-primary")).toContainText(/Add to Home Screen/i);
  await expect(playGuide.locator("#play-guide-primary")).not.toContainText(/Edge/i);
  const playOther = page.locator("#play-guide-other");
  await expect(playOther.locator("summary")).toHaveText(/Other devices/i);
  await expect(playOther).not.toHaveAttribute("open");
  await playOther.locator("summary").tap();
  await expect(playOther).toHaveJSProperty("open", true);
  await expect(playOther).toContainText(/Edge/i);
  await expect(playOther).toContainText(/three dots/i);
  await expect(playOther).toContainText(/Android/i);
  await expect(playOther).toContainText(/Install\s+app/i);
  await expect(playOther).toContainText(/Windows/i);
  await expect(playOther).toContainText(/Install this site as an app/i);
  await expect(playOther).toContainText(/Mac/i);
  await expect(playOther).toContainText(/Add to Dock/i);

  // Still on the title after expanding help.
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(jamBtn).toHaveText("TAP TO JAM");

  // Touch tap — matches iPhone Edge / Safari gesture path better than mouse click.
  await jamBtn.tap();

  // Must not flash the old "timed out" failure while Pixi is still booting.
  await expect(page.getByText("Couldn't start the jam")).toHaveCount(0);

  await expect
    .poll(async () => page.locator("body").getAttribute("data-ready"), {
      timeout: 30_000,
      message: "game should set data-ready after TAP TO JAM without an 8s false failure",
    })
    .toBe("1");

  await expect(page.locator("#reset-btn")).toBeVisible();
  await expect(page.locator("#phase-num")).toHaveText("1");
  await expect(page.locator("#secret-btn")).toBeVisible();
  await expect(page.locator("#secret-btn")).toHaveText("Secret game 🤫");
  await expect(page.locator("#gate-error")).toHaveCount(0);

  const audioState = await page.evaluate(() => window.__sprunkiJamTest?.audioState() ?? null);
  expect(
    audioState,
    "AudioContext should be running after TAP TO JAM unlocks in the user-gesture turn",
  ).toBe("running");

  const probe = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(probe?.presentMode, "iPhone is WebGL only").toBe("webgl");
  expect(probe?.webglContext).toBe(true);
  expect(probe?.gpuFrozen, "iPhone still resizes the GPU for rotate/cover-fit").toBe(false);
  expect(probe?.presentSnapshotForResize, "iPhone must not tear down the canvas for a snapshot").toBe(
    false,
  );
  expect(probe?.canvasInDom, "iPhone live WebGL canvas stays in the DOM").toBe(true);
  expect(await page.locator("body").getAttribute("data-renderer")).toBe("webgl");
  expect(
    await page.locator("body").getAttribute("data-renderer-override"),
    "no ?renderer= on the default iPhone path",
  ).toBeNull();
  expect(probe?.dustLive, "meadow dust must be live on the first playable frame").toBeGreaterThan(0);
  expect(probe?.dustVisible).toBe(true);
  expect(probe?.dustPaused).toBe(false);
  expect(probe?.dustPhase).toBe(1);

  // Short post-start reminder — title guide already taught switch-or-settings.
  const tip = page.locator("#silent-tip");
  // Tip may auto-dismiss ("gone") before we get here on a slow boot — either
  // path is fine as long as it is not stuck covering the stage.
  if (await tip.isVisible()) {
    await expect(tip).toContainText(/Silent OFF/i);
    await expect(tip).toContainText(/switch or setting/i);
    await expect(tip).toContainText(/Home Screen/i);
    await tip.tap({ force: true });
  }
  await expect(tip).toBeHidden({ timeout: 2000 });
});

test("stage drag retries audio unlock path without gate error", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  // Canvas is the Pixi stage — a center tap exercises ensureAudio() retry
  // (corners sit under the RESET HUD hit target).
  const canvas = page.locator("#stage-root canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  await canvas.tap({
    position: { x: Math.floor((box?.width ?? 200) / 2), y: Math.floor((box?.height ?? 400) / 2) },
  });

  const audioState = await page.evaluate(() => window.__sprunkiJamTest?.audioState() ?? null);
  expect(audioState).toBe("running");
  await expect(page.getByText("Couldn't start the jam")).toHaveCount(0);
});

test("placing two different stems on one pad merges them", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("oren", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["oren"]);

  await expect
    .poll(async () => {
      const look = await page.evaluate(() => window.__sprunkiJamTest?.occupantLook?.("mid") ?? null);
      return Boolean(
        look &&
          look.rocks.length === 1 &&
          Math.abs(look.rocks[0]!) > 0.002 &&
          look.glow > 0.55,
      );
    }, { timeout: 3_000, message: "seated friend should idle-rock and glow more opaquely" })
    .toBe(true);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("pinki", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["oren", "pinki"]);
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.occupantViewStems?.("mid") ?? null),
  ).toEqual(["oren", "pinki"]);

  const audioState = await page.evaluate(() => window.__sprunkiJamTest?.audioState() ?? null);
  expect(audioState).toBe("running");
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("oren") ?? false)).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("pinki") ?? false)).toBe(true);
});

test("a pad can hold three friends; a fourth replaces the stack", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("oren", "mid");
    window.__sprunkiJamTest?.placeStem?.("pinki", "mid");
    window.__sprunkiJamTest?.placeStem?.("vineria", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["oren", "pinki", "vineria"]);

  const viewStems = await page.evaluate(() => window.__sprunkiJamTest?.occupantViewStems?.("mid") ?? null);
  expect(viewStems, "trio visual must list all three friends, not a 2-fuse").toEqual([
    "oren",
    "pinki",
    "vineria",
  ]);
  expect(viewStems).toHaveLength(3);

  await expect
    .poll(async () => {
      const look = await page.evaluate(() => window.__sprunkiJamTest?.occupantLook?.("mid") ?? null);
      return Boolean(
        look &&
          look.rocks.length === 3 &&
          look.rocks.some((a) => Math.abs(a) > 0.002) &&
          new Set(look.rocks.map((a) => a.toFixed(4))).size > 1 &&
          look.glow > 0.55,
      );
    }, { timeout: 3_000, message: "each friend in a 3-stack should idle-rock; seated glow stays readable" })
    .toBe(true);

  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("oren") ?? false)).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("pinki") ?? false)).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("vineria") ?? false)).toBe(
    true,
  );

  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("oren"))).toBe(false);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("pinki"))).toBe(false);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("vineria"))).toBe(false);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("jevin"))).toBe(true);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("red", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["red"]);

  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("red") ?? false)).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("oren") ?? true)).toBe(false);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("pinki") ?? true)).toBe(false);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("vineria") ?? true)).toBe(
    false,
  );
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("oren"))).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("pinki"))).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("vineria"))).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("red"))).toBe(false);
});

test("dragging a three-friend pad off stage returns all to the tray", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("oren", "mid");
    window.__sprunkiJamTest?.placeStem?.("pinki", "mid");
    window.__sprunkiJamTest?.placeStem?.("vineria", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["oren", "pinki", "vineria"]);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.dragSeatOffPad?.("mid");
  });

  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toBeNull();
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isDragging?.() ?? true)).toBe(false);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("oren") ?? true)).toBe(false);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("pinki") ?? true)).toBe(false);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("vineria") ?? true)).toBe(
    false,
  );
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("oren"))).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("pinki"))).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("vineria"))).toBe(true);
});

test("drag cancel clears stuck ghost and restores tray", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const before = await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("pinki"));
  expect(before).toBe(true);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.beginDragThenCancel?.("pinki");
  });

  const dragging = await page.evaluate(() => window.__sprunkiJamTest?.isDragging?.() ?? true);
  expect(dragging, "drag ghost must be cleared after pointercancel-style end").toBe(false);

  const trayOk = await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("pinki"));
  expect(trayOk, "tray icon must be interactive again — no stuck mid-drag").toBe(true);

  const seated = await page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null);
  expect(seated, "near-miss cancel must not force a pad drop").toBeNull();
});

test("gate gesture starts title bed; TAP TO JAM stops it", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  // Ring hotspot is a gesture that does NOT enter the game — starts the title bed only.
  const ring = page.locator("#ring-hotspot");
  await expect(ring).toBeVisible();
  await ring.tap();

  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.titleBedPlaying?.() ?? false), {
      timeout: 5000,
      message: "title bed should be playing after the first gate gesture",
    })
    .toBe(true);

  // After a title-bed gesture, emphasize the guide without claiming Silent detection.
  // Help stays collapsed by default — open it to read the nudge copy.
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.soundGuideMode?.() ?? "calm"), {
      timeout: 5000,
      message: "post-gesture guide should nudge (or blocked if audio really failed)",
    })
    .not.toBe("calm");
  await page.locator("#gate-help-summary").tap();
  const guide = page.locator("#sound-guide");
  await expect(guide).toBeVisible();
  await expect(guide).not.toContainText(/detected silent/i);
  const mode = await page.evaluate(() => window.__sprunkiJamTest?.soundGuideMode?.() ?? "calm");
  if (mode === "nudge") {
    await expect(page.locator("#sound-guide-nudge")).toContainText(/Still quiet/i);
  } else {
    await expect(page.locator("#sound-guide-nudge")).toContainText(/music didn't start/i);
  }

  // Intro moment auto-dismisses (~2.2s). Wait it out so TAP TO JAM is clear
  // (avoid racing isVisible→tap after the longer sound-guide poll).
  await expect(page.locator("#intro-moment")).toBeHidden({ timeout: 5000 });

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  // Title bed must fade/stop so it does not fight stage stems.
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.titleBedPlaying?.() ?? true), {
      timeout: 3000,
    })
    .toBe(false);
});

test("tapping gate hero art does not start the jam; TAP TO JAM does", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const jamBtn = page.locator("#jam-btn");
  await expect(jamBtn).toBeVisible();
  await expect(jamBtn).toHaveText("TAP TO JAM");

  const hero = page.locator("#gate-hero");
  await expect(hero).toBeVisible();
  const box = await hero.boundingBox();
  expect(box).toBeTruthy();
  // Top-right of hero art — away from TAP TO JAM and ring/hat hotspots.
  await hero.tap({
    position: {
      x: Math.floor((box?.width ?? 390) * 0.88),
      y: Math.floor((box?.height ?? 844) * 0.35),
    },
  });

  // Give a delayed start time to fail if the whole-gate listener is still wired.
  await page.waitForTimeout(1500);
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(page.locator("#gate")).toHaveCount(1);
  await expect(jamBtn).toBeVisible();
  await expect(jamBtn).toHaveText("TAP TO JAM");

  await jamBtn.tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect(page.locator("#reset-btn")).toBeVisible();
});

test("five stage pads: Black sits on mid; no portal tile", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const slotIds = await page.evaluate(() => window.__sprunkiJamTest?.slotIds?.() ?? []);
  expect(slotIds, "layout must be five DROP pads with no portal pad").toEqual([
    "tl",
    "tr",
    "left",
    "mid",
    "right",
  ]);
  expect(slotIds).toHaveLength(5);
  expect(slotIds).not.toContain("portal");

  const labels = await page.evaluate(() => window.__sprunkiJamTest?.padLabels?.() ?? []);
  expect(labels, "five empty pads").toHaveLength(5);
  expect(labels.every((t) => t === "DROP"), `empty pads must say DROP, got ${labels.join(",")}`).toBe(true);
  expect(labels, "no MR. BLACK portal tile label").not.toContain("MR. BLACK");

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("pinki", "left");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("left") ?? null))
    .toEqual(["pinki"]);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("black", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["black"]);
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 10_000 });
});

test("tapping a seated friend does not mute or solo them", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("oren", "left");
    window.__sprunkiJamTest?.placeStem?.("pinki", "right");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("left") ?? null))
    .toEqual(["oren"]);
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("right") ?? null))
    .toEqual(["pinki"]);

  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("oren") ?? false)).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("pinki") ?? false)).toBe(true);

  const center = await page.evaluate(() => window.__sprunkiJamTest?.slotCenter?.("left") ?? null);
  expect(center).toBeTruthy();
  const canvas = page.locator("#stage-root canvas");
  await canvas.tap({ position: { x: center!.x, y: center!.y } });
  // Second tap would have cycled mute → solo under the old behavior.
  await canvas.tap({ position: { x: center!.x, y: center!.y } });

  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("oren") ?? false)).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("pinki") ?? false)).toBe(true);
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("left") ?? null))
    .toEqual(["oren"]);
  await expect(page.locator("body")).toHaveAttribute("data-phase", "1");
});

test("Black on an occupied pad replaces rather than merges", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("oren", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["oren"]);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("black", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["black"]);

  const orenTray = await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("oren"));
  expect(orenTray, "Oren must return to the tray after Black replaces him").toBe(true);
});

test("Black replaces a three-friend pad and stays exclusive", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("pinki", "left");
    window.__sprunkiJamTest?.placeStem?.("vineria", "left");
    window.__sprunkiJamTest?.placeStem?.("jevin", "left");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("left") ?? null))
    .toEqual(["pinki", "vineria", "jevin"]);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("black", "left");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("left") ?? null))
    .toEqual(["black"]);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("pinki"))).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("vineria"))).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.trayInteractive?.("jevin"))).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("black") ?? false)).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isAudible?.("pinki") ?? true)).toBe(false);
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 10_000 });
});

test("RESET reloads the TAP TO JAM title screen", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect(page.locator("#reset-btn")).toBeVisible();

  await page.locator("#reset-btn").tap();

  await expect(page.locator("#jam-btn")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  await expect(page.locator("#gate")).toHaveCount(1);
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(page.getByRole("heading", { name: /SPRUNKI AND/i })).toBeVisible();
  await expect(page.locator("#gate-help")).toBeVisible();
  await expect(page.locator("#gate-help")).not.toHaveAttribute("open");
  await expect(page.locator("#gate-help-summary")).toHaveText(/Sound & full screen help/i);
  await expect(page.locator("#welcome-marquee")).toBeVisible();
  await expect(page.locator("#welcome-marquee")).toHaveClass(/is-js-crawl/);

  // RESET reloads the title and rebinds the JS crawl. Prior expects often eat
  // most of the 3s hold on slow CI — assert a near-rest sample, not a full hold.
  const readY = async (): Promise<number> =>
    page.locator(".welcome-marquee-track").evaluate((el) => {
      const t = getComputedStyle(el).transform;
      if (!t || t === "none") return 0;
      return new DOMMatrix(t).m42;
    });
  const y0 = Math.abs(await readY());
  expect(y0, "RESET title crawl should start near rest").toBeLessThan(2);
  await page.waitForTimeout(250);
  const y1 = Math.abs(await readY());
  // Either still holding, or early crawl inches forward slowly (~7px/s).
  expect(y1, "RESET title crawl must not jump after reload").toBeLessThan(y0 + 4);
});

test("expanding gate help does not start the jam", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const jamBtn = page.locator("#jam-btn");
  const gateHelp = page.locator("#gate-help");
  await expect(gateHelp).not.toHaveAttribute("open");
  await page.locator("#gate-help-summary").tap();
  await expect(gateHelp).toHaveJSProperty("open", true);

  await page.waitForTimeout(1500);
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(page.locator("#gate")).toHaveCount(1);
  await expect(jamBtn).toBeVisible();
  await expect(jamBtn).toHaveText("TAP TO JAM");

  const other = page.locator("#sound-guide-other");
  await other.locator("summary").tap();
  await expect(other).toHaveJSProperty("open", true);
  await expect(other).toContainText(/Android/i);
  await page.waitForTimeout(800);
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(jamBtn).toBeVisible();
  await expect(jamBtn).toHaveText("TAP TO JAM");

  await jamBtn.tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
});

test("Edge-on-iPhone UA shows Edge Home Screen steps as primary", async ({ browser }) => {
  const iphone = devices["iPhone 14"];
  const context = await browser.newContext({
    viewport: iphone.viewport,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/118.0.2088.68 Mobile/15E148 Safari/605.1.15",
  });
  const page = await context.newPage();
  try {
    await page.goto("/", { waitUntil: "networkidle" });

    await expect
      .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.detectedPlatform?.() ?? null))
      .toBe("ios-edge");
    await page.locator("#gate-help-summary").tap();
    await expect(page.locator("#gate-help")).toHaveJSProperty("open", true);
    await expect(page.locator("#sound-guide")).toHaveAttribute("data-platform", "ios-edge");
    await expect(page.locator("#play-guide")).toHaveAttribute("data-platform", "ios-edge");
    await expect(page.locator("#play-guide-primary")).toContainText(/Edge/i);
    await expect(page.locator("#play-guide-primary")).toContainText(/three dots/i);
    await expect(page.locator("#play-guide-primary")).toContainText(/Add to Home Screen/i);
    await expect(page.locator("#play-guide-primary")).not.toContainText(/Safari/i);
    await expect(page.locator("#sound-guide")).toContainText(
      /Tap anywhere on this screen to turn the music on/i,
    );

    const playOther = page.locator("#play-guide-other");
    await playOther.locator("summary").tap();
    await expect(playOther).toContainText(/Safari/i);
    await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  } finally {
    await context.close();
  }
});

test("tapping welcome marquee or gate help starts title bed without starting jam", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const jamBtn = page.locator("#jam-btn");
  await expect(jamBtn).toHaveText("TAP TO JAM");

  const marquee = page.locator("#welcome-marquee");
  const track = marquee.locator(".welcome-marquee-track");
  await expect(marquee).toHaveClass(/is-js-crawl/);
  const readY = async (): Promise<number> =>
    track.evaluate((el) => {
      const t = getComputedStyle(el).transform;
      if (!t || t === "none") return 0;
      return new DOMMatrix(t).m42;
    });
  await marquee.tap();
  await expect(marquee).not.toHaveClass(/is-paused/);
  await expect(marquee).not.toHaveClass(/is-manual/);
  await expect(marquee).not.toHaveClass(/is-dragging/);
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.titleBedPlaying?.() ?? false), {
      timeout: 5000,
      message: "title bed should start from #welcome-marquee on a cold gate",
    })
    .toBe(true);
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(jamBtn).toHaveText("TAP TO JAM");

  // Finger-tap must not freeze the crawl (no leftover pause classes).
  const overflowY = await marquee
    .locator(".welcome-marquee-viewport")
    .evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflowY, "welcome viewport stays overflow:hidden — drag uses transform").toBe("hidden");
  // After the ~3s hold (+ any short post-drag resume delay), crawl must keep advancing.
  await page.waitForTimeout(3500);
  const yAfterHold = await readY();
  await expect
    .poll(async () => readY(), {
      timeout: 4000,
      message: "welcome crawl transform should keep moving after tap (post 3s hold)",
    })
    .toBeLessThan(yAfterHold - 2);

  // Fresh cold load for the collapsed help disclosure.
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  await expect(page.locator("#gate-help")).not.toHaveAttribute("open");
  await page.locator("#gate-help-summary").tap();
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.titleBedPlaying?.() ?? false), {
      timeout: 5000,
      message: "title bed should start from #gate-help on a cold gate",
    })
    .toBe(true);
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  await expect(page.locator("#gate-help")).toHaveJSProperty("open", true);

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.titleBedPlaying?.() ?? true), {
      timeout: 3000,
    })
    .toBe(false);
});

test("Rainbow Friends use meadow Phase 1 and horror Phase 2+ portrait JPEGs", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const phase1Red = await page.evaluate(() => window.__sprunkiJamTest?.portraitUrl?.("red") ?? null);
  const phase1Purple = await page.evaluate(
    () => window.__sprunkiJamTest?.portraitUrl?.("purple") ?? null,
  );
  expect(phase1Red).toBe("/art/red-portrait.jpeg");
  expect(phase1Purple).toBe("/art/purple-portrait.jpeg");

  for (const stem of ["red", "purple", "green", "orange", "blue"] as const) {
    const happy = await page.evaluate(
      (id) => window.__sprunkiJamTest?.portraitUrl?.(id) ?? null,
      stem,
    );
    const horror = await page.evaluate(
      (id) => window.__sprunkiJamTest?.portraitUrl?.(id, true) ?? null,
      stem,
    );
    const hasHorror = await page.evaluate(
      (id) => window.__sprunkiJamTest?.hasHorrorPortrait?.(id) ?? false,
      stem,
    );
    expect(happy, `${stem} Phase 1 art`).toBe(`/art/${stem}-portrait.jpeg`);
    expect(horror, `${stem} Phase 2+ art`).toBe(`/art/${stem}-portrait-horror.jpeg`);
    expect(hasHorror, `${stem} must have a dedicated horror JPEG`).toBe(true);
  }

  // Sprunki friends stay on their own art paths.
  expect(await page.evaluate(() => window.__sprunkiJamTest?.portraitUrl?.("oren") ?? null)).toBe(
    "/art/oren-portrait.jpeg",
  );
  expect(await page.evaluate(() => window.__sprunkiJamTest?.portraitUrl?.("pinki") ?? null)).toBe(
    "/art/pinki-portrait.jpeg",
  );

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("red", "left");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("left") ?? null))
    .toEqual(["red"]);
  await expect(page.locator("body")).toHaveAttribute("data-phase", "1");

  // Seat Black → Phase 2 horror; RF chips must still report horror portrait paths.
  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("black", "mid");
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 10_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });

  const horrorRed = await page.evaluate(
    () => window.__sprunkiJamTest?.portraitUrl?.("red", true) ?? null,
  );
  expect(horrorRed).toBe("/art/red-portrait-horror.jpeg");
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.hasHorrorPortrait?.("red") ?? false),
  ).toBe(true);

  // Blue Phase 2+ floating crown needs a looser crop than snug Phase 1 Blue.
  const blueHappy = await page.evaluate(() => window.__sprunkiJamTest?.portraitFrame?.("blue"));
  const blueHorror = await page.evaluate(() => window.__sprunkiJamTest?.portraitFrame?.("blue", true));
  expect(blueHappy?.scale, "Phase 1 Blue stays snug").toBeGreaterThan(0.9);
  expect(blueHorror?.scale, "horror Blue zooms out for the crown").toBeLessThan(0.9);
  expect(blueHorror!.offsetY, "horror Blue shifts down so the crown stays in-chip").toBeGreaterThan(
    blueHappy!.offsetY,
  );

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("blue", "right");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("right") ?? null))
    .toEqual(["blue"]);

  // Green: Phase 2 keeps horror JPEG; Phase 10+ uses the third deep-horror tier.
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.portraitUrl?.("green", 2) ?? null),
  ).toBe("/art/green-portrait-horror.jpeg");
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.portraitUrl?.("green", 3) ?? null),
  ).toBe("/art/green-portrait-horror.jpeg");
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.hasDeepHorrorPortrait?.("green") ?? false),
  ).toBe(true);
  for (const phase of [10, 100, 1000, 100000] as const) {
    expect(
      await page.evaluate(
        (p) => window.__sprunkiJamTest?.portraitUrl?.("green", p) ?? null,
        phase,
      ),
      `Green phase ${phase} art`,
    ).toBe("/art/green-portrait-phase10.jpeg");
  }
  const greenDeepFrame = await page.evaluate(() =>
    window.__sprunkiJamTest?.portraitFrame?.("green", 10),
  );
  expect(greenDeepFrame?.scale, "Phase 10 Green zooms out for upside-down art").toBeLessThan(0.9);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("green", "tr");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("tr") ?? null))
    .toEqual(["green"]);
  await page.evaluate(() => window.__sprunkiJamTest?.setPhase?.(10));
  await expect(page.locator("body")).toHaveAttribute("data-phase", "10", { timeout: 10_000 });
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.portraitUrl?.("green", 10) ?? null),
  ).toBe("/art/green-portrait-phase10.jpeg");
});

test("mix duck restores after stacked phase cues, place, and Phase 1", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  // Mash skip-style hops: old code read duck.gain.value mid-ramp (Safari/iOS
  // can leave it stuck near 0, which also muted place chimes).
  await page.evaluate(() => {
    for (let i = 0; i < 8; i++) {
      window.__sprunkiJamTest?.phaseTransitionCue?.(i % 2 === 0 ? "cosmic-to-vortex" : "reverse-unwind");
    }
  });
  await page.waitForTimeout(1100);
  const afterHops = await page.evaluate(() => window.__sprunkiJamTest?.mixGain?.() ?? -1);
  expect(afterHops, `duck should be restored to 1 after stacked cues, got ${afterHops}`).toBeGreaterThan(0.95);

  await page.evaluate(() => window.__sprunkiJamTest?.silenceMix?.(true));
  await page.evaluate(() => window.__sprunkiJamTest?.placeStem?.("oren", "left"));
  const afterPlace = await page.evaluate(() => window.__sprunkiJamTest?.mixGain?.() ?? -1);
  expect(afterPlace, `place() must unduck, got ${afterPlace}`).toBeGreaterThan(0.95);

  await page.evaluate(() => window.__sprunkiJamTest?.silenceMix?.(true));
  await page.evaluate(() => window.__sprunkiJamTest?.setPhase?.(1));
  const afterPhase1 = await page.evaluate(() => window.__sprunkiJamTest?.mixGain?.() ?? -1);
  expect(afterPhase1, `setPhase(1) must restore mix gain, got ${afterPhase1}`).toBeGreaterThan(0.95);

  await page.evaluate(() => window.__sprunkiJamTest?.setPhase?.(1000));
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++) window.__sprunkiJamTest?.phaseTransitionCue?.("cosmic-to-vortex");
  });
  await page.evaluate(() => window.__sprunkiJamTest?.placeStem?.("pinki", "right"));
  const afterHighPhasePlace = await page.evaluate(() => window.__sprunkiJamTest?.mixGain?.() ?? -1);
  expect(afterHighPhasePlace, `place at phase 1000 must unduck, got ${afterHighPhasePlace}`).toBeGreaterThan(
    0.95,
  );

  await page.evaluate(() => window.__sprunkiJamTest?.silenceMix?.(true));
  await page.evaluate(() => window.__sprunkiJamTest?.restoreMixGain?.());
  const afterRestore = await page.evaluate(() => window.__sprunkiJamTest?.mixGain?.() ?? -1);
  expect(afterRestore, `restoreMixGain must snap duck to 1, got ${afterRestore}`).toBeGreaterThan(0.95);

  const audioState = await page.evaluate(() => window.__sprunkiJamTest?.audioState() ?? null);
  expect(audioState).toBe("running");
});

test("hide then stage tap resumes jam audio without Reset", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("pinki", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["pinki"]);

  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.audioState() ?? null))
    .toBe("running");

  // iOS zombie-running: keep-alive paused and/or ctx suspended, mix ducked.
  await page.evaluate(() => window.__sprunkiJamTest?.silenceMix?.(true));
  await page.evaluate(() => window.__sprunkiJamTest?.pauseKeepAlive?.());
  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.suspendAudio?.();
  });

  await simulateAppHideShow(page);
  await tapStageNotReset(page);

  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.audioState() ?? null), {
      timeout: 5000,
      message: "AudioContext must be running after hide + stage tap (not Reset)",
    })
    .toBe("running");

  const keepAlive = await page.evaluate(() => window.__sprunkiJamTest?.keepAlivePlaying?.() ?? null);
  if (keepAlive !== null) {
    expect(keepAlive, "silent HTMLAudio keep-alive should be playing after resume").toBe(true);
  }

  const mix = await page.evaluate(() => window.__sprunkiJamTest?.mixGain?.() ?? -1);
  expect(mix, `restoreMixGain must run on resume, got ${mix}`).toBeGreaterThan(0.95);

  await stillInJam(page);
});

test("hide/show on the title gate does not start the jam", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const jamBtn = page.locator("#jam-btn");
  await expect(jamBtn).toBeVisible();
  await expect(jamBtn).toHaveText("TAP TO JAM");

  // Cold gate: resume listeners must not start the jam.
  await simulateAppHideShow(page);
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(page.locator("#gate")).toHaveCount(1);
  await expect(jamBtn).toHaveText("TAP TO JAM");

  // Title bed is playing on the gate — hide/show + a non-TAP tap resumes it only.
  const hero = page.locator("#gate-hero");
  await expect(hero).toBeVisible();
  const box = await hero.boundingBox();
  expect(box).toBeTruthy();
  const heroTap = {
    position: {
      x: Math.floor((box?.width ?? 390) * 0.88),
      y: Math.floor((box?.height ?? 844) * 0.35),
    },
  };
  await hero.tap(heroTap);

  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.titleBedPlaying?.() ?? false), {
      timeout: 5000,
      message: "title bed should start from a gate gesture that is not TAP TO JAM",
    })
    .toBe(true);

  await page.evaluate(() => window.__sprunkiJamTest?.pauseKeepAlive?.());
  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.suspendTitleBed?.();
  });

  await simulateAppHideShow(page);
  await hero.tap(heroTap);

  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.titleBedPlaying?.() ?? false), {
      timeout: 5000,
      message: "title bed should resume after hide + gate tap without starting the jam",
    })
    .toBe(true);

  const keepAlive = await page.evaluate(() => window.__sprunkiJamTest?.keepAlivePlaying?.() ?? null);
  if (keepAlive !== null) {
    expect(keepAlive, "keep-alive should play again on the title gate").toBe(true);
  }

  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(page.locator("#gate")).toHaveCount(1);
  await expect(jamBtn).toBeVisible();
  await expect(jamBtn).toHaveText("TAP TO JAM");
});

test("horror phase dial: no SKIP label, one row, taps jump phase", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await expect(page.locator("#skip-dial")).toBeHidden();
  await expect(page.locator(".skip-label")).toHaveCount(0);
  await expect(page.locator("#hud")).not.toContainText(/skip/i);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("black", "mid");
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 10_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#skip-dial")).toBeVisible();

  const buttons = page.locator("#skip-dial button");
  await expect(buttons).toHaveCount(5);
  await expect(buttons.nth(0)).toHaveText("2");
  await expect(buttons.nth(1)).toHaveText("10");
  await expect(buttons.nth(2)).toHaveText("100");
  await expect(buttons.nth(3)).toHaveText("1,000");
  await expect(buttons.nth(4)).toHaveText("100,000");
  await expect(page.locator("#skip-dial")).not.toContainText(/skip/i);

  await assertSkipDialOneRow(page);

  // Leave phase 2, then tap 2 to prove the new dial button jumps back.
  await buttons.nth(1).tap();
  await expect(page.locator("body")).toHaveAttribute("data-phase", "10", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  await expect(buttons.nth(1)).toHaveClass(/active/);
  await expect(page.locator("#phase-num")).toHaveText("10");

  await buttons.nth(0).tap();
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  await expect(buttons.nth(0)).toHaveClass(/active/);
  await expect(page.locator("#phase-num")).toHaveText("2");

  await buttons.nth(4).tap();
  await expect(page.locator("body")).toHaveAttribute("data-phase", "100000", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  await expect(buttons.nth(4)).toHaveClass(/active/);
  await expect(page.locator("#phase-num")).toHaveText("100,000");

  // Button taps fire-and-forget gotoPhase — wait for reveal to finish before cover-fit assert.
  await expect
    .poll(
      async () => {
        const cov = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
        return cov?.set === 7 && cov?.covers === true;
      },
      {
        timeout: 10_000,
        message: "phase 100,000 must settle on bg set 7 covering the stage",
      },
    )
    .toBe(true);
});

test.describe("horror phase dial landscape", () => {
  // iPhone device emulation rejects page.setViewportSize; use a landscape viewport from the start.
  test.use({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });

  test("five buttons stay on one row", async ({ page }) => {
    await seatBlackAndShowDial(page);
    await expect(page.locator(".skip-label")).toHaveCount(0);
    await expect(page.locator("#hud")).not.toContainText(/skip/i);
    const buttons = page.locator("#skip-dial button");
    await expect(buttons).toHaveCount(5);
    await expect(buttons.nth(0)).toHaveText("2");
    await expect(buttons.nth(4)).toHaveText("100,000");
    await assertSkipDialOneRow(page);

    await buttons.nth(2).tap();
    await expect(page.locator("body")).toHaveAttribute("data-phase", "100", { timeout: 15_000 });
    await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
    await expect(buttons.nth(2)).toHaveClass(/active/);
  });
});

test.describe("welcome marquee landscape", () => {
  test.use({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });

  test("marquee is wide under the title, not a thin strip", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const marquee = page.locator("#welcome-marquee");
    await expect(marquee).toBeVisible();
    const box = await marquee.boundingBox();
    expect(box).toBeTruthy();
    // Portrait cap is 420px; landscape should use most of the usable width (~min(92vw, 720)).
    expect(box!.width, "landscape marquee should be much wider than the portrait 420px cap").toBeGreaterThan(
      500,
    );
    expect(box!.width).toBeLessThanOrEqual(844);

    const jam = await page.locator("#jam-btn").boundingBox();
    expect(jam).toBeTruthy();
    // Marquee must sit above TAP TO JAM, not cover it.
    expect(box!.y + box!.height, "marquee must stay above TAP TO JAM").toBeLessThanOrEqual(jam!.y + 2);
  });

  test("dark hero object-position raises faces above the welcome stack", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    const ringPos = await page.locator("#hero-ring").evaluate((el) => getComputedStyle(el).objectPosition);

    // Force the Black/Vineria hero so we assert the dark crop, not the ring dwell.
    await page.evaluate(() => {
      const gate = document.getElementById("gate");
      const ring = document.getElementById("hero-ring");
      const dark = document.getElementById("hero-dark");
      if (!gate || !ring || !dark) throw new Error("hero markup missing");
      gate.dataset.hero = "dark";
      ring.classList.remove("is-active");
      dark.classList.add("is-active");
    });

    const darkPos = await page.locator("#hero-dark").evaluate((el) => getComputedStyle(el).objectPosition);
    // Portrait/default dark is center 36%; landscape must raise faces above the welcome stack.
    const yMatch = /(\d+(?:\.\d+)?)%/.exec(darkPos.split(" ").pop() ?? "");
    expect(yMatch, `expected percent object-position, got ${darkPos}`).toBeTruthy();
    expect(Number(yMatch![1]), `landscape dark hero should be raised (got ${darkPos})`).toBeGreaterThanOrEqual(
      48,
    );
    // Stable framing: ring + dark share object-position so the crossfade is opacity-only (no zoom punch).
    expect(darkPos, "landscape heroes must share framing during crossfade").toBe(ringPos);

    const marqueeH = await page
      .locator(".welcome-marquee-viewport")
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(marqueeH, "landscape marquee viewport should be taller than the short-strip fallback").toBeGreaterThan(
      56,
    );

    await expect(page.locator("#jam-btn")).toBeVisible();
    await expect(page.locator("#gate-help-summary")).toBeVisible();
    await expect(page.locator("#welcome-marquee")).toBeVisible();
    await expect(page.locator("#welcome-marquee")).toContainText("💎");
    await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  });
});

test("TAP TO JAM still requests fullscreen on iPhone UA", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __fsCalls: number }).__fsCalls = 0;
    HTMLElement.prototype.requestFullscreen = function () {
      (window as unknown as { __fsCalls: number }).__fsCalls += 1;
      return Promise.resolve();
    };
  });

  await page.goto("/", { waitUntil: "networkidle" });
  expect(await page.evaluate(() => window.__sprunkiJamTest?.shouldKickFullscreen?.())).toBe(true);
  expect(
    await page.evaluate(() =>
      window.__sprunkiJamTest?.shouldKickFullscreen?.({
        uaDataMobile: false,
        pointerFine: true,
        hoverHover: true,
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      }),
    ),
  ).toBe(false);

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  const calls = await page.evaluate(() => (window as unknown as { __fsCalls: number }).__fsCalls);
  expect(calls, "iPhone TAP TO JAM should still attempt fullscreen").toBeGreaterThanOrEqual(1);
});

test("welcome marquee drag scrubs then resume auto-crawls", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const marquee = page.locator("#welcome-marquee");
  await expect(marquee).toHaveClass(/is-js-crawl/);
  const track = page.locator(".welcome-marquee-track");

  const readY = async (): Promise<number> =>
    track.evaluate((el) => {
      const t = getComputedStyle(el).transform;
      if (!t || t === "none") return 0;
      const m = new DOMMatrix(t);
      return m.m42;
    });

  // Still during the 3s hold — drag must scrub immediately.
  const beforeDrag = await readY();
  const box = await marquee.boundingBox();
  expect(box).toBeTruthy();
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height * 0.7;
  const y1 = box!.y + box!.height * 0.25;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y1, { steps: 8 });
  const midDrag = await readY();
  expect(midDrag, "drag-up should advance the crawl offset (more negative Y)").toBeLessThan(beforeDrag - 8);
  await page.mouse.up();

  // Must not stay frozen: after resume delay, auto-crawl continues from the scrubbed spot.
  const afterRelease = await readY();
  await page.waitForTimeout(1100);
  await expect
    .poll(async () => readY(), {
      timeout: 3000,
      message: "crawl must resume after pointerup (not stay paused forever)",
    })
    .toBeLessThan(afterRelease - 2);

  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
});

test("welcome marquee reduced-motion is static and scrollable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "networkidle" });

  const marquee = page.locator("#welcome-marquee");
  await expect(marquee).not.toHaveClass(/is-js-crawl/);
  const track = page.locator(".welcome-marquee-track");
  await expect(track).toHaveCSS("animation-name", "none");
  const overflow = await page
    .locator(".welcome-marquee-viewport")
    .evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflow === "auto" || overflow === "scroll").toBe(true);

  await marquee.tap();
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
});

/**
 * Repro: change phases → rotate to landscape → change phases again →
 * half the screen went black from a stale cover-fit / wrong orient asset.
 * iPhone device presets reject setViewportSize, so we drive the same
 * renderer + bg.resize path via forceStageSize.
 */
test("phase background stays full-bleed after rotate then phase change", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(2);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });

  let cov = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(cov?.covers, `portrait phase 2 must cover stage, got ${JSON.stringify(cov)}`).toBe(true);
  expect(cov?.orient).toBe("portrait");
  expect(cov?.phaseNumeral, "portrait phase 2 must not draw a giant phase numeral").toBe(false);
  expect(cov?.benchOverlay, "portrait phase 2 must not draw a translucent bench").toBe(false);

  // Rotate portrait → landscape mid-jam.
  await page.evaluate(() => window.__sprunkiJamTest?.forceStageSize?.(844, 390));
  const afterRotate = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(afterRotate?.presentSnapshotForResize, "iPhone rotate must not snapshot-teardown").toBe(
    false,
  );
  expect(afterRotate?.canvasInDom, "iPhone rotate must keep the live WebGL canvas").toBe(true);

  cov = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(cov?.orient, "after rotate stage should report landscape").toBe("landscape");
  expect(cov?.covers, `post-rotate phase 2 must still cover, got ${JSON.stringify(cov)}`).toBe(true);

  // Change phases again — old bug: black half from stale cover-fit.
  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(10);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "10", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });

  cov = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(cov?.orient).toBe("landscape");
  expect(cov?.covers, `landscape phase 10 after rotate must cover, got ${JSON.stringify(cov)}`).toBe(
    true,
  );

  // Cross-set hop 1000→100000 (sets 6→7) must keep cover-fit after rotate.
  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(1000);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "1000", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  const cov1000 = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(cov1000?.set, "phase 1000 uses bg set 6").toBe(6);

  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(100000);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "100000", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });

  cov = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(cov?.covers, `set 6→7 hop after rotate must cover, got ${JSON.stringify(cov)}`).toBe(true);
  expect(cov?.orient).toBe("landscape");
  expect(cov?.set, "phase 100,000 uses dedicated bg set 7").toBe(7);

  // Landscape → portrait, then another phase change.
  await page.evaluate(() => window.__sprunkiJamTest?.forceStageSize?.(390, 844));
  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(3);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "3", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });

  cov = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(cov?.orient).toBe("portrait");
  expect(
    cov?.covers,
    `portrait after landscape→portrait + phase change must cover, got ${JSON.stringify(cov)}`,
  ).toBe(true);
  expect(cov?.phaseNumeral, "after rotate + skip, no giant phase numeral").toBe(false);
  expect(cov?.benchOverlay, "after rotate + skip, no translucent bench").toBe(false);
});

test("phase photo backgrounds have no giant numeral or bench overlay", async ({ page }) => {
  // Many cinematic hops (portrait + landscape). Software WebGL CI needs headroom.
  test.setTimeout(120_000);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const expectedSet: Record<number, number> = {
    1: 1,
    2: 2,
    3: 3,
    10: 4,
    100: 5,
    1000: 6,
    100000: 7,
  };
  const phases = [1, 2, 3, 10, 100, 1000, 100000] as const;

  assertPhotoOnlyBg(
    await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null),
    1,
    "boot phase 1",
  );
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.transitionState?.() ?? null),
    "cinematic overlay must be gone on the idle title-to-jam stage",
  ).toEqual({ busy: false, visible: false });

  for (const phase of phases) {
    if (phase === 1) continue;
    await page.evaluate(async (p) => {
      await window.__sprunkiJamTest?.gotoPhase?.(p);
    }, phase);
    await expect(page.locator("body")).toHaveAttribute("data-phase", String(phase), { timeout: 15_000 });
    await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
    assertPhotoOnlyBg(
      await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null),
      expectedSet[phase],
      `portrait skip to ${phase}`,
    );
    expect(
      await page.evaluate(() => window.__sprunkiJamTest?.transitionState?.() ?? null),
      `cinematic overlay must clear after skip to ${phase}`,
    ).toEqual({ busy: false, visible: false });
  }

  await page.evaluate(() => window.__sprunkiJamTest?.forceStageSize?.(844, 390));
  assertPhotoOnlyBg(
    await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null),
    7,
    "landscape rotate on phase 100000",
  );

  for (const phase of [2, 3, 10, 100, 1000, 100000] as const) {
    await page.evaluate(async (p) => {
      await window.__sprunkiJamTest?.gotoPhase?.(p);
    }, phase);
    await expect(page.locator("body")).toHaveAttribute("data-phase", String(phase), { timeout: 15_000 });
    await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
    assertPhotoOnlyBg(
      await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null),
      expectedSet[phase],
      `landscape skip to ${phase}`,
    );
    expect(
      await page.evaluate(() => window.__sprunkiJamTest?.transitionState?.() ?? null),
      `cinematic overlay must clear after landscape skip to ${phase}`,
    ).toEqual({ busy: false, visible: false });
  }

  await page.evaluate(() => window.__sprunkiJamTest?.forceStageSize?.(390, 844));
  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(1);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "1", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  assertPhotoOnlyBg(
    await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null),
    1,
    "portrait after landscape→portrait skip to 1",
  );
});

test("phase hop plays a cinematic overlay then leaves only the photo", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  expect(await page.evaluate(() => window.__sprunkiJamTest?.transitionState?.() ?? null)).toEqual({
    busy: false,
    visible: false,
  });

  // Fire the hop without awaiting so we can see the one-shot overlay while it plays.
  const hop = page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(2);
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.transitionState?.()?.busy ?? false), {
      timeout: 5000,
      message: "1→2 must play the cinematic overlay (not a plain photo snap)",
    })
    .toBe(true);
  const midFx = await page.evaluate(() => window.__sprunkiJamTest?.transitionFx?.() ?? null);
  expect(midFx?.budget, "default iPhone hop uses WebGL bloom").toBe("webgl");
  expect(midFx?.bloom, "WebGL hops attach a reused bloom filter").toBe(true);
  expect(midFx?.paused).toBe(false);
  await hop;
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  expect(await page.evaluate(() => window.__sprunkiJamTest?.transitionState?.() ?? null)).toEqual({
    busy: false,
    visible: false,
  });
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.transitionFx?.()?.bloom ?? true),
    "bloom filter must detach after the hop",
  ).toBe(false);
  assertPhotoOnlyBg(
    await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null),
    2,
    "after 1→2 cinematic",
  );

  // Mid-hop rotate used to retarget the outgoing photo to the destination set,
  // collapsing the dissolve. Overlay must still play, then clear, photo covers.
  const hop10 = page.evaluate(async () => {
    const started = window.__sprunkiJamTest?.gotoPhase?.(10);
    window.__sprunkiJamTest?.forceStageSize?.(844, 390);
    await started;
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.transitionState?.()?.busy ?? false), {
      timeout: 5000,
      message: "skip to 10 must still run the cinematic while rotating",
    })
    .toBe(true);
  await hop10;
  await expect(page.locator("body")).toHaveAttribute("data-phase", "10", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  expect(await page.evaluate(() => window.__sprunkiJamTest?.transitionState?.() ?? null)).toEqual({
    busy: false,
    visible: false,
  });
  const cov = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  assertPhotoOnlyBg(cov, 4, "after cinematic + mid-hop rotate to phase 10");
  expect(cov?.orient).toBe("landscape");
  expect(cov?.covers).toBe(true);
});

test("title heroes pick portrait vs landscape from the window box, not screen.orientation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(screen, "orientation", {
      configurable: true,
      get: () => ({ type: "landscape-primary", angle: 0 }),
    });
    Object.defineProperty(screen, "availWidth", { configurable: true, get: () => 1920 });
    Object.defineProperty(screen, "availHeight", { configurable: true, get: () => 1080 });
  });

  const requested: string[] = [];
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/art/intro-")) requested.push(u);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#hero-ring")).toBeVisible();

  const tall = await page.evaluate(() => window.__sprunkiJamTest?.titleArt?.() ?? null);
  expect(tall?.orient, "default iPhone viewport is a tall window").toBe("portrait");
  expect(tall?.ringFit).toBe("cover");
  expect(tall?.darkFit).toBe("cover");
  expect(tall?.innerH ?? 0).toBeGreaterThan(tall?.innerW ?? 0);
  expect(requested.some((u) => u.includes("intro-ring-portrait-title.jpeg"))).toBe(true);
  expect(requested.some((u) => u.includes("intro-black-vineria-portrait-title.jpeg"))).toBe(true);

  const ringBox = await page.locator("#hero-ring").boundingBox();
  const gateBox = await page.locator("#gate").boundingBox();
  expect(ringBox && gateBox).toBeTruthy();
  expect(ringBox!.width, "hero must fill the gate width (no side bars)").toBeGreaterThanOrEqual(
    gateBox!.width - 2,
  );
  expect(ringBox!.height, "hero must fill the gate height (no letterbox bars)").toBeGreaterThanOrEqual(
    gateBox!.height - 2,
  );

  await expect(page.locator("#ring-hotspot")).toBeVisible();
  await page.locator("#ring-hotspot").tap();
  await expect(page.locator("#intro-moment")).toBeVisible();
  const momentSrc = await page.locator("#intro-moment-img").evaluate((el) => {
    const img = el as HTMLImageElement;
    return img.currentSrc || img.src;
  });
  expect(momentSrc.includes("intro-ring-portrait-title.jpeg") || momentSrc.includes("intro-ring-title.jpeg") || momentSrc.includes("intro-ring.jpeg")).toBe(
    true,
  );
  await page.locator("#intro-moment").tap();
  await expect(page.locator("#intro-moment")).toBeHidden();
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
});

test("phase 1 cover keeps the tree-smile pivot and still fills after a phase-2 hop", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const p1 = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(p1?.covers).toBe(true);
  expect(p1?.set).toBe(1);
  expect(p1?.orient).toBe("portrait");
  expect(p1?.src).toContain("bg-phase1-portrait.jpeg");
  expect(p1?.pivotX ?? 0).toBeGreaterThanOrEqual(0.65);
  expect(p1?.objectPosition).toMatch(/70%/);

  const fill = page.locator("#stage-fill");
  await expect(fill).toBeVisible();
  const fillFit = await fill.evaluate((el) => getComputedStyle(el).objectFit);
  expect(fillFit).toBe("cover");

  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(2);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 15_000 });
  const p2 = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(p2?.covers).toBe(true);
  expect(p2?.set).toBe(2);
  expect(p2?.src).toContain("bg-phase2-portrait.jpeg");
  expect(p2?.pivotX).toBe(0.5);
});

