import { expect, test } from "@playwright/test";

const HIGH_KEY = "sprunki-jam-secret-high-score";

async function enterJam(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#secret-btn")).toBeHidden();
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
}

test("Secret game stays off the title and appears after TAP TO JAM", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  await expect(page.locator("#jam-btn")).toBeVisible();
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  await expect(page.locator("#secret-btn")).toBeHidden();
  await expect(page.locator("#secret-over")).toBeHidden();
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const secret = page.locator("#secret-btn");
  await expect(secret).toBeVisible();
  await expect(secret).toHaveText("Secret game 🤫");
  await expect(page.locator("#jam-btn")).toHaveCount(0);
  await expect(page.locator("#reset-btn")).toBeVisible();
  await expect(page.locator("#phase-num")).toHaveText("1");
});

test("starting Secret game scores a pad tap and can return to the jam", async ({ page }) => {
  await enterJam(page);
  await expect(page.locator("#secret-btn")).toBeVisible();

  await page.locator("#secret-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-secret", "run");
  await expect(page.locator("#secret-scoreboard")).toBeVisible();
  await expect(page.locator("#secret-score")).toHaveText("0");
  await expect(page.locator("#secret-exit-btn")).toBeVisible();
  await expect(page.locator("#secret-btn")).toBeHidden();
  await expect(page.locator("#skip-dial")).toBeHidden();

  // Pin a long prompt immediately — the natural early window (~1.3s) can burn
  // all three lives before the next Playwright turn on slow software WebGL.
  await page.evaluate(() => {
    window.__sprunkiJamTest?.secretSpawn?.("mid", 12_000);
  });
  const started = await page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.status ?? "idle");
  expect(started).toBe("playing");
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.targets ?? []))
    .toEqual(["mid"]);

  // Hit + re-pin in one turn so the natural gap timer cannot burn lives before exit.
  const scored = await page.evaluate(() => {
    const result = window.__sprunkiJamTest?.secretTap?.("mid") ?? "ignore";
    window.__sprunkiJamTest?.secretSpawn?.("mid", 60_000);
    const state = window.__sprunkiJamTest?.secretState?.();
    return { result, score: state?.score ?? -1, status: state?.status ?? "idle" };
  });
  expect(scored.result).toBe("hit");
  expect(scored.score).toBe(1);
  expect(scored.status).toBe("playing");
  await expect(page.locator("#secret-score")).toHaveText("1");
  await expect(page.locator("#secret-over")).toBeHidden();
  await page.locator("#secret-exit-btn").tap();
  await expect(page.locator("body")).not.toHaveAttribute("data-secret");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#secret-over")).toBeHidden();
  await expect(page.locator("#secret-scoreboard")).toBeHidden();
  await expect(page.locator("#secret-btn")).toBeVisible();
  await expect(page.locator("#secret-btn")).toHaveText("Secret game 🤫");
  await expect(page.locator("#reset-btn")).toBeVisible();
  await expect(page.locator("#phase-num")).toHaveText("1");

  expect(await page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.status ?? "playing")).toBe(
    "idle",
  );

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("oren", "left");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("left") ?? null))
    .toEqual(["oren"]);

  const labels = await page.evaluate(() => window.__sprunkiJamTest?.padLabels?.() ?? []);
  expect(labels.some((t) => t === "DROP")).toBe(true);
});

test("high score persists in localStorage across reload", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate((key) => {
    localStorage.removeItem(key);
  }, HIGH_KEY);

  await expect(page.locator("#secret-btn")).toBeHidden();
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await page.evaluate(() => {
    window.__sprunkiJamTest?.startSecret?.();
    window.__sprunkiJamTest?.secretSpawn?.("tr", 12_000);
    window.__sprunkiJamTest?.secretTap?.("tr");
    window.__sprunkiJamTest?.secretEnd?.();
  });

  await expect(page.locator("#secret-over")).toBeVisible();
  await expect(page.locator("#secret-over-score")).toHaveText("1");
  await expect(page.locator("#secret-over-high")).toHaveText("1");
  expect(await page.evaluate((key) => localStorage.getItem(key), HIGH_KEY)).toBe("1");

  await page.reload({ waitUntil: "networkidle" });
  expect(await page.evaluate((key) => localStorage.getItem(key), HIGH_KEY)).toBe("1");
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  await expect(page.locator("#secret-btn")).toBeHidden();

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await page.evaluate(() => {
    window.__sprunkiJamTest?.startSecret?.();
    window.__sprunkiJamTest?.secretEnd?.();
  });
  await expect(page.locator("#secret-over")).toBeVisible();
  await expect(page.locator("#secret-over-score")).toHaveText("0");
  await expect(page.locator("#secret-over-high")).toHaveText("1");
  expect(await page.evaluate((key) => localStorage.getItem(key), HIGH_KEY)).toBe("1");
});

test("BACK TO JAM from game over stays on the stage, not the title", async ({ page }) => {
  await enterJam(page);
  await page.evaluate(() => {
    window.__sprunkiJamTest?.startSecret?.();
    window.__sprunkiJamTest?.secretEnd?.();
  });
  await expect(page.locator("#secret-over")).toBeVisible();

  await page.locator("#secret-over-exit").tap();
  await expect(page.locator("#secret-over")).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("body")).not.toHaveAttribute("data-secret");
  await expect(page.locator("#jam-btn")).toHaveCount(0);
  await expect(page.locator("#secret-btn")).toBeVisible();
  await expect(page.locator("#reset-btn")).toBeVisible();

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("pinki", "mid");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["pinki"]);
});

test("TAP TO JAM still starts the main jam after Secret game exists", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#secret-btn")).toBeHidden();
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect(page.locator("#reset-btn")).toBeVisible();
  await expect(page.locator("#phase-num")).toHaveText("1");

  const audioState = await page.evaluate(() => window.__sprunkiJamTest?.audioState() ?? null);
  expect(audioState).toBe("running");

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("vineria", "right");
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("right") ?? null))
    .toEqual(["vineria"]);
  await expect(page.locator("body")).toHaveAttribute("data-phase", "1");
  await expect(page.locator("#secret-btn")).toBeVisible();
});

test("Secret game is available in later phases and does not hop the scare", async ({ page }) => {
  await enterJam(page);
  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("black", "mid");
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 10_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.transitionState?.()?.busy ?? true), {
      timeout: 15_000,
    })
    .toBe(false);
  await expect(page.locator("#secret-btn")).toBeVisible();

  await page.locator("#secret-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-secret", "run");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2");
  await expect(page.locator("#skip-dial")).toBeHidden();
  await expect(page.locator("#scare")).toBeHidden();

  await page.evaluate(() => window.__sprunkiJamTest?.exitSecret?.());
  await expect(page.locator("body")).not.toHaveAttribute("data-secret");
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2");
  await expect(page.locator("#skip-dial")).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["black"]);
});

test("multi-target set needs every lit pad; last tap clears", async ({ page }) => {
  await enterJam(page);
  await page.evaluate(() => {
    window.__sprunkiJamTest?.startSecret?.();
    window.__sprunkiJamTest?.secretSpawn?.(["mid", "left"], 12_000);
  });

  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.targets ?? []))
    .toEqual(["mid", "left"]);

  const first = await page.evaluate(() => window.__sprunkiJamTest?.secretTap?.("mid") ?? "ignore");
  expect(first).toBe("hit");
  await expect(page.locator("#secret-score")).toHaveText("1");
  expect(await page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.targets ?? [])).toEqual(["left"]);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.lives ?? 0)).toBe(3);

  const again = await page.evaluate(() => window.__sprunkiJamTest?.secretTap?.("mid") ?? "miss");
  expect(again).toBe("ignore");
  expect(await page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.lives ?? 0)).toBe(3);

  // Sample score/targets in the same turn as the clear tap — a new prompt can
  // spawn within a few hundred ms after clear on the natural gap timer.
  const cleared = await page.evaluate(() => {
    const result = window.__sprunkiJamTest?.secretTap?.("left") ?? "ignore";
    const state = window.__sprunkiJamTest?.secretState?.();
    return {
      result,
      score: state?.score ?? -1,
      targets: state?.targets ?? ["?"],
      lives: state?.lives ?? -1,
    };
  });
  expect(cleared.result).toBe("clear");
  expect(cleared.score).toBe(2);
  expect(cleared.targets).toEqual([]);
  expect(cleared.lives).toBe(3);
  await expect(page.locator("#secret-score")).toHaveText("2");
});

test("timeout with two pads leftover is a miss", async ({ page }) => {
  await enterJam(page);
  const spawned = await page.evaluate(() => {
    window.__sprunkiJamTest?.startSecret?.();
    window.__sprunkiJamTest?.secretSpawn?.(["tl", "tr"], 500);
    return window.__sprunkiJamTest?.secretState?.()?.targets ?? [];
  });
  expect(spawned).toEqual(["tl", "tr"]);

  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.lives ?? 3), {
      timeout: 4_000,
    })
    .toBe(2);

  const state = await page.evaluate(() => window.__sprunkiJamTest?.secretState?.() ?? null);
  expect(state?.status).toBe("playing");
  expect(state?.score).toBe(0);
});

test("wrong pad during a multi-set is a miss", async ({ page }) => {
  await enterJam(page);
  await page.evaluate(() => {
    window.__sprunkiJamTest?.startSecret?.();
    window.__sprunkiJamTest?.secretSpawn?.(["mid", "right"], 12_000);
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.targets ?? []))
    .toEqual(["mid", "right"]);

  const miss = await page.evaluate(() => window.__sprunkiJamTest?.secretTap?.("left") ?? "ignore");
  expect(miss).toBe("miss");
  expect(await page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.lives ?? 0)).toBe(2);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.score ?? -1)).toBe(0);
});

test("difficulty ramp reaches 2 then 3 then 4 concurrent pads and speeds up", async ({ page }) => {
  await enterJam(page);
  const curve = await page.evaluate(() => {
    const api = window.__sprunkiJamTest;
    return {
      early: api?.secretCurve?.(0) ?? null,
      two: api?.secretCurve?.(20_000) ?? null,
      three: api?.secretCurve?.(50_000) ?? null,
      four: api?.secretCurve?.(90_000) ?? null,
      late: api?.secretCurve?.(130_000) ?? null,
    };
  });

  expect(curve.early?.targetCount).toBe(1);
  expect(curve.two?.targetCount).toBe(2);
  expect(curve.three?.targetCount).toBe(3);
  expect(curve.four?.targetCount).toBe(4);
  expect(curve.late?.targetCount).toBe(4);
  expect(curve.early?.targetCount).toBeLessThan(5);
  expect(curve.late?.windowMs ?? 9999).toBeLessThan(curve.early?.windowMs ?? 0);
  expect(curve.late?.gapMs ?? 9999).toBeLessThan(curve.early?.gapMs ?? 0);
  expect(curve.late?.windowMs ?? 999).toBeLessThanOrEqual(180);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.startSecret?.();
    window.__sprunkiJamTest?.secretSpawn?.(["tl", "tr", "left", "mid"], 12_000);
  });
  const four = await page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.targets ?? []);
  expect(four).toEqual(["tl", "tr", "left", "mid"]);
  expect(four).not.toContain("right");
});

test("secret pads show unique random friends with green glow; miss is red", async ({ page }) => {
  await enterJam(page);
  await page.evaluate(() => {
    window.__sprunkiJamTest?.startSecret?.();
    window.__sprunkiJamTest?.secretSpawn?.(["mid", "left", "tr"], 12_000);
  });

  const faces = await page.evaluate(() => window.__sprunkiJamTest?.secretFaces?.() ?? {});
  const stems = Object.values(faces).filter((s): s is string => Boolean(s));
  expect(stems.length).toBe(3);
  expect(new Set(stems).size, "no duplicate friend in one prompt").toBe(3);

  const look = await page.evaluate(() => window.__sprunkiJamTest?.secretPadLook?.() ?? {});
  expect(look.mid?.glow).toBe("green");
  expect(look.left?.glow).toBe("green");
  expect(look.tr?.glow).toBe("green");
  expect(look.mid?.stem).toBeTruthy();
  expect(look.right?.glow).toBe("none");

  const after = await page.evaluate(() => {
    const miss = window.__sprunkiJamTest?.secretTap?.("right") ?? "ignore";
    const look = window.__sprunkiJamTest?.secretPadLook?.() ?? {};
    return { miss, look };
  });
  expect(after.miss).toBe("miss");
  expect(after.look.right?.glow).toBe("red");
});

test("ambient dust is visible on Phase 1 boot, dims in secret, and stays live after hops", async ({
  page,
}) => {
  await enterJam(page);
  const dust = await page.evaluate(() => window.__sprunkiJamTest?.dustState?.() ?? null);
  expect(dust, "dustState hook").toBeTruthy();
  expect(dust!.count).toBeGreaterThan(0);
  expect(dust!.count).toBeLessThanOrEqual(88);
  expect(dust!.live, "motes must be live on the first playable Phase 1 frame").toBeGreaterThan(0);
  expect(dust!.particleChildren, "ParticleContainer must hold the mote pool").toBeGreaterThan(0);
  expect(dust!.visible).toBe(true);
  expect(dust!.dim).toBe(1);
  expect(dust!.phase).toBe(1);
  expect(dust!.paused).toBe(false);
  expect(dust!.w).toBeGreaterThan(100);
  expect(dust!.h).toBeGreaterThan(100);

  const probe = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(probe?.dustLive, "layoutProbe sees live motes after TAP TO JAM").toBeGreaterThan(0);
  expect(probe?.dustVisible).toBe(true);
  expect(probe?.dustPaused).toBe(false);
  expect(probe?.dustDim).toBe(1);
  expect(probe?.dustPhase).toBe(1);

  const boot = await page.evaluate(() => window.__sprunkiJamTest?.sceneStats?.()?.displayObjects ?? 0);
  await page.waitForTimeout(400);
  const idle = await page.evaluate(() => window.__sprunkiJamTest?.sceneStats?.()?.displayObjects ?? 0);
  expect(idle).toBe(boot);

  await page.evaluate(() => window.__sprunkiJamTest?.startSecret?.());
  const dimmed = await page.evaluate(() => window.__sprunkiJamTest?.dustState?.() ?? null);
  expect(dimmed?.dim ?? 1).toBeLessThan(0.5);
  expect(dimmed?.dim ?? 0).toBeGreaterThan(0.2);
  expect(dimmed?.live ?? 0, "secret dims motes, it does not kill them").toBeGreaterThan(0);

  await page.evaluate(() => window.__sprunkiJamTest?.exitSecret?.());
  const restored = await page.evaluate(() => window.__sprunkiJamTest?.dustState?.() ?? null);
  expect(restored?.dim ?? 0).toBe(1);
  expect(restored?.live ?? 0).toBeGreaterThan(0);

  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(2);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 15_000 });
  await expect(page.locator("#scare")).toBeHidden({ timeout: 15_000 });
  const afterHop = await page.evaluate(() => window.__sprunkiJamTest?.dustState?.() ?? null);
  expect(afterHop?.paused).toBe(false);
  expect(afterHop?.dim).toBe(1);
  expect(afterHop?.phase).toBe(2);
  expect(afterHop?.live, "motes must still be live after a phase hop").toBeGreaterThan(0);
  expect(afterHop?.visible).toBe(true);
  const afterProbe = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(afterProbe?.dustLive, "layoutProbe live count after hop").toBeGreaterThan(0);
  expect(afterProbe?.dustPhase).toBe(2);
});
