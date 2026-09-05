import { expect, test } from "@playwright/test";

type SceneStats = {
  displayObjects: number;
  graphics: number;
  texts: number;
  graphicsInstructions: number;
  padLabels: number;
  slotChildren: number;
  dropLabelAllocs: number;
};

async function enterJam(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
}

async function sceneStats(page: import("@playwright/test").Page): Promise<SceneStats> {
  const stats = await page.evaluate(() => window.__sprunkiJamTest?.sceneStats?.() ?? null);
  expect(stats, "sceneStats hook must exist").toBeTruthy();
  return stats!;
}

function heapUsed(): number | null {
  const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
  return perf.memory?.usedJSHeapSize ?? null;
}

/**
 * Windows Chrome/Edge leaked GPU/RAM because DROP Text was recreated on every
 * layout/hover, cinematic hops rebuilt huge Graphics strokes every tick, and
 * texture lookups re-generated mipmaps. Scene graph + instruction counts must
 * stay bounded through idle ticks, hover storms, relayouts, and phase hops.
 */
test("scene graph stays bounded across idle, hover, relayout, hops, and reset-style seating", async ({
  page,
}) => {
  // Six cinematic hops after seating — software WebGL CI needs headroom.
  test.setTimeout(120_000);
  await enterJam(page);

  const boot = await sceneStats(page);
  expect(boot.padLabels, "five reused DROP labels after first layout").toBe(5);
  expect(boot.dropLabelAllocs, "DROP Text is constructed once per pad").toBe(5);
  expect(boot.slotChildren, "one label child per pad").toBe(5);
  expect(boot.texts, "tray names + DROP labels should be a small fixed set").toBeLessThan(40);
  const bootGraphics = boot.graphics;
  const bootObjects = boot.displayObjects;

  await page.waitForTimeout(2200);
  const idle = await sceneStats(page);
  expect(idle.padLabels, "idle ticks must not spawn DROP labels").toBe(boot.padLabels);
  expect(idle.texts, "idle ticks must not spawn Text").toBe(boot.texts);
  expect(idle.graphics, "idle ticks must not spawn Graphics").toBe(bootGraphics);
  expect(idle.displayObjects, "idle ticks must not grow the scene graph").toBe(bootObjects);
  expect(
    idle.graphicsInstructions,
    "idle cinematic overlay must not keep per-tick drawing commands",
  ).toBeLessThanOrEqual(boot.graphicsInstructions + 8);

  await page.evaluate(() => window.__sprunkiJamTest?.pumpDrawSlots?.(250));
  const afterHover = await sceneStats(page);
  expect(afterHover.padLabels, "hover restyle must reuse the 5 DROP labels").toBe(5);
  expect(afterHover.dropLabelAllocs, "250 hover restyles must not construct more DROP Text").toBe(5);
  expect(afterHover.slotChildren, "pads must not accumulate Text children").toBe(5);
  expect(afterHover.texts, "hover storm must not allocate Text").toBe(boot.texts);
  expect(afterHover.graphics).toBe(bootGraphics);

  await page.evaluate(() => window.__sprunkiJamTest?.pumpRelayout?.(120));
  const afterRelayout = await sceneStats(page);
  expect(afterRelayout.padLabels).toBe(5);
  expect(afterRelayout.dropLabelAllocs, "relayout storm must not construct more DROP Text").toBe(5);
  expect(afterRelayout.texts).toBe(boot.texts);
  expect(afterRelayout.graphics).toBe(bootGraphics);
  expect(afterRelayout.displayObjects).toBe(bootObjects);

  const heapBeforeHops = await page.evaluate(heapUsed);

  await page.evaluate(() => {
    window.__sprunkiJamTest?.placeStem?.("oren", "left");
    window.__sprunkiJamTest?.placeStem?.("pinki", "left");
    window.__sprunkiJamTest?.placeStem?.("black", "mid");
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 15_000 });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.transitionState?.()?.busy ?? true), {
      timeout: 15_000,
      message: "1→2 cinematic must finish before further hops",
    })
    .toBe(false);

  const seated = await sceneStats(page);
  expect(seated.padLabels, "labels stay pooled even when some pads are occupied").toBe(5);
  expect(seated.slotChildren).toBe(5);
  expect(seated.texts, "merge + seat may add a few labels, not hundreds").toBeLessThan(boot.texts + 12);

  for (const phase of [3, 10, 100, 1000, 100000, 2] as const) {
    await page.evaluate(async (p) => {
      await window.__sprunkiJamTest?.gotoPhase?.(p);
    }, phase);
    await expect(page.locator("body")).toHaveAttribute("data-phase", String(phase), {
      timeout: 15_000,
    });
    await expect
      .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.transitionState?.()?.busy ?? true), {
        timeout: 15_000,
        message: `cinematic overlay must clear after hop to ${phase}`,
      })
      .toBe(false);
    const hop = await sceneStats(page);
    expect(hop.padLabels, `DROP labels after hop to ${phase}`).toBe(5);
    expect(hop.dropLabelAllocs, `DROP Text allocs after hop to ${phase}`).toBe(5);
    expect(hop.slotChildren, `slot children after hop to ${phase}`).toBe(5);
    expect(
      hop.texts,
      `Text count after hop to ${phase} must not explode (got ${hop.texts})`,
    ).toBeLessThan(boot.texts + 16);
    expect(
      hop.graphics,
      `Graphics count after hop to ${phase} must stay near boot (boot ${bootGraphics}, got ${hop.graphics})`,
    ).toBeLessThan(bootGraphics + 40);
    expect(
      hop.graphicsInstructions,
      `cinematic overlay must unload after hop to ${phase}; remaining cmds are pads/shadows (got ${hop.graphicsInstructions})`,
    ).toBeLessThan(130);
    expect(
      await page.evaluate(() => window.__sprunkiJamTest?.transitionState?.() ?? null),
    ).toEqual({ busy: false, visible: false });
  }

  await page.evaluate(() => {
    window.__sprunkiJamTest?.beginDragThenCancel?.("green");
    window.__sprunkiJamTest?.beginDragThenCancel?.("blue");
    window.__sprunkiJamTest?.beginDragThenCancel?.("red");
  });
  const afterDrags = await sceneStats(page);
  expect(afterDrags.texts, "cancelled drags must destroy ghost Text").toBeLessThan(boot.texts + 16);
  expect(afterDrags.graphics).toBeLessThan(bootGraphics + 40);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.isDragging?.() ?? true)).toBe(false);

  const heapAfter = await page.evaluate(heapUsed);
  if (heapBeforeHops != null && heapAfter != null && heapBeforeHops > 0) {
    // Chromium JS heap is not GPU RAM, but a 4× climb here would still be a CPU leak.
    expect(
      heapAfter,
      `JS heap must not explode (before ${heapBeforeHops}, after ${heapAfter})`,
    ).toBeLessThan(heapBeforeHops * 4 + 80_000_000);
  }

  const cov = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(cov?.covers, "photo backdrop still covers after hop storm").toBe(true);
  expect(cov?.phaseNumeral).toBe(false);
  expect(cov?.benchOverlay).toBe(false);
  expect(cov?.set, "phase 2 after reverse hop uses bg set 2").toBe(2);

  // eslint-disable-next-line no-console
  console.log(
    "memory-leak scene stats",
    JSON.stringify({
      boot,
      idle,
      afterHover,
      afterRelayout,
      seated,
      afterDrags,
      heapBeforeHops,
      heapAfter,
    }),
  );
});
