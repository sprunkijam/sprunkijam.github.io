import { expect, test } from "@playwright/test";
import {
  probeWebGlContext,
  WEBGL_UNAVAILABLE_MESSAGE,
} from "../src/view/gpuBudget";
import {
  idleRockAngle,
  IDLE_ROCK_AMP,
  IDLE_ROCK_SPEED,
  SEATED_GLOW_STRENGTH,
  TRAY_GLOW_STRENGTH,
} from "../src/view/characters";

test("WebGL probe is a cheap context check; no WebGPU / Canvas fallback helpers", async () => {
  expect(typeof probeWebGlContext).toBe("function");
  expect(WEBGL_UNAVAILABLE_MESSAGE).toMatch(/WebGL/i);
  expect(WEBGL_UNAVAILABLE_MESSAGE).not.toMatch(/canvas|webgpu/i);
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/view/gpuBudget.ts", import.meta.url), "utf8"),
  );
  expect(src).toContain("getContext(\"webgl2\")");
  expect(src).not.toContain("navigator.gpu");
  expect(src).not.toContain("requestAdapter");
  expect(src).not.toContain("RendererChoice");
  expect(src).not.toContain("parseRendererChoice");
});

test("title has a readable build stamp and no renderer dropdown", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#renderer-picker")).toHaveCount(0);
  await expect(page.locator("#renderer-select")).toHaveCount(0);
  const stamp = page.locator("#build-version");
  const jam = page.locator("#jam-btn");
  await expect(stamp).toBeVisible();
  await expect(stamp).toHaveCSS("pointer-events", "none");
  await expect(stamp).not.toHaveText("");
  await expect(stamp).not.toContainText(/webgpu|webgl|canvas/i);
  const layout = await page.evaluate(() => {
    const stampEl = document.getElementById("build-version");
    const jamEl = document.getElementById("jam-btn");
    if (!stampEl || !jamEl) return null;
    const sr = stampEl.getBoundingClientRect();
    const jr = jamEl.getBoundingClientRect();
    const style = getComputedStyle(stampEl);
    return {
      stampBelowJam: sr.top >= jr.bottom - 1,
      stampOverlapJam: !(sr.right < jr.left || sr.left > jr.right || sr.bottom < jr.top || sr.top > jr.bottom),
      opacity: Number.parseFloat(style.opacity),
    };
  });
  expect(layout).toBeTruthy();
  expect(layout!.stampBelowJam).toBe(true);
  expect(layout!.stampOverlapJam).toBe(false);
  expect(layout!.opacity).toBeGreaterThanOrEqual(0.8);

  await page.evaluate(() => {
    try {
      localStorage.setItem("sprunki-jam-renderer", "webgpu");
    } catch {
      /* ignore */
    }
  });
  await page.goto("/?renderer=canvas", { waitUntil: "networkidle" });
  await expect(page.locator("#renderer-select")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-renderer-override");
});

test("title screen has no WebGL canvas until TAP TO JAM", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  // Title is CSS/JPEG only — a live Pixi canvas here was the Windows Edge GPU spiral.
  await expect(page.locator("#stage-root canvas")).toHaveCount(0);
  const before = await page.evaluate(() => {
    const probe = window.__sprunkiJamTest?.layoutProbe?.() ?? null;
    return {
      canvasInDom: probe?.canvasInDom ?? false,
      screenW: probe?.screenW ?? 0,
      canvasCount: document.querySelectorAll("#stage-root canvas").length,
    };
  });
  expect(before.canvasCount).toBe(0);
  expect(before.canvasInDom).toBe(false);
  expect(before.screenW).toBe(0);

  // Resize the title pane — still must not create WebGL.
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(400);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(400);
  await expect(page.locator("#stage-root canvas")).toHaveCount(0);

  // Title heroes must be display JPEGs (≤4000 long edge), not 6000×4000 masters.
  const hero = await page.evaluate(() => {
    const ring = document.getElementById("hero-ring") as HTMLImageElement | null;
    const dark = document.getElementById("hero-dark") as HTMLImageElement | null;
    return {
      ringSrc: ring?.currentSrc || ring?.src || "",
      darkSrc: dark?.currentSrc || dark?.src || "",
      ringW: ring?.naturalWidth ?? 0,
      ringH: ring?.naturalHeight ?? 0,
      darkW: dark?.naturalWidth ?? 0,
      darkH: dark?.naturalHeight ?? 0,
    };
  });
  expect(hero.ringSrc).toMatch(/intro-ring.*title\.jpeg/);
  // Inactive hero drops src so only one ~4000px decode is live.
  expect(hero.darkSrc === "" || /intro-black-vineria.*title\.jpeg/.test(hero.darkSrc)).toBe(true);
  expect(Math.max(hero.ringW, hero.ringH)).toBeLessThanOrEqual(4000);
  expect(Math.max(hero.ringW, hero.ringH)).toBeGreaterThan(0);
  expect(Math.max(hero.ringW, hero.ringH)).toBeGreaterThan(1600);

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect(page.locator("#stage-root canvas")).toHaveCount(1);
  const after = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(after?.canvasInDom).toBe(true);
  expect(after?.presentMode).toBe("webgl");
  expect(after?.webglContext).toBe(true);
  expect(after?.screenW ?? 0).toBeGreaterThan(0);
});

test("iPhone boot is WebGL only; stored renderer picks are ignored", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect(page.locator("body")).toHaveAttribute("data-renderer", "webgl");
  const probe = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(probe?.presentMode).toBe("webgl");
  expect(probe?.webglContext).toBe(true);
  expect(probe?.preference).toBeUndefined();
  expect(probe?.webgpuContext).toBeUndefined();
  const fx = await page.evaluate(() => window.__sprunkiJamTest?.transitionFx?.() ?? null);
  expect(fx?.budget).toBe("webgl");
});

test("home idle rock helper matches the tray formula; seated glow is stronger", () => {
  expect(IDLE_ROCK_SPEED).toBe(2);
  expect(IDLE_ROCK_AMP).toBe(0.04);
  const seed = "oren".split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  expect(idleRockAngle(1.25, "oren")).toBeCloseTo(Math.sin(1.25 * 2 + seed) * 0.04, 8);
  expect(SEATED_GLOW_STRENGTH).toBeGreaterThan(TRAY_GLOW_STRENGTH);
  expect(SEATED_GLOW_STRENGTH).toBeLessThanOrEqual(1);
  expect(SEATED_GLOW_STRENGTH).toBeGreaterThanOrEqual(0.9);
});
