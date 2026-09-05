import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

function headersFile(): string {
  return readFileSync("public/_headers", "utf8");
}

test("public/_headers revalidates HTML, SW, and manifest; hashes stay immutable", () => {
  const text = headersFile();
  expect(text).toContain("X-Robots-Tag: noindex, nofollow");
  expect(text).toMatch(/\/index\.html\s*\n\s*Cache-Control:.*(?:no-store|no-cache|max-age=0)/);
  expect(text).toMatch(/\/\s*\n\s*Cache-Control:.*(?:no-store|no-cache|max-age=0)/);
  expect(text).toMatch(/\/sw\.js\s*\n\s*Cache-Control:.*(?:no-store|no-cache|max-age=0)/);
  expect(text).toMatch(/\/manifest\.webmanifest\s*\n\s*Cache-Control:.*(?:no-store|no-cache|max-age=0)/);
  expect(text).toMatch(/\/version\.json\s*\n\s*Cache-Control:.*(?:no-store|no-cache|max-age=0)/);
  expect(text).toMatch(/\/sw\.js[\s\S]*?no-store/);
  expect(text).toMatch(/\/version\.json[\s\S]*?no-store/);
  expect(text).toMatch(/\/assets\/\*\s*\n\s*Cache-Control:.*immutable/);
  const dist = readFileSync("dist/_headers", "utf8");
  expect(dist).toContain("/sw.js");
  expect(dist).toContain("Cache-Control");
});

test("version.json is a tiny build id and matches the in-bundle version", async ({ page }) => {
  const res = await page.goto("/version.json", { waitUntil: "networkidle" });
  expect(res?.ok()).toBe(true);
  const body = (await res!.json()) as { v?: string; t?: string };
  expect(typeof body.v).toBe("string");
  expect(body.v!.length).toBeGreaterThan(4);
  expect(typeof body.t).toBe("string");

  await page.goto("/", { waitUntil: "networkidle" });
  const bundled = await page.evaluate(() => window.__sprunkiJamTest?.pwaBuildVersion?.() ?? "");
  expect(bundled).toBe(body.v);
  expect(
    await page.evaluate(
      ([local, remote]) => window.__sprunkiJamTest?.pwaVersionChanged?.(local, remote) ?? true,
      [bundled, body.v] as const,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.pwaVersionChanged?.("old", "new") ?? false),
  ).toBe(true);

  // Tiny under-button stamp on the title gate — confirm a fresh deploy / not a stale SW.
  const stamp = page.locator("#build-version");
  await expect(stamp).toBeVisible();
  await expect(stamp).toHaveText(bundled);
  await expect(stamp).not.toContainText(/webgpu|webgl|canvas/i);
  await expect(stamp).toHaveAttribute("aria-hidden", "true");
  await expect(stamp).toHaveCSS("pointer-events", "none");
  // Must not sit under / steal TAP TO JAM.
  await expect(page.locator("#jam-btn")).toBeVisible();
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect(stamp).toBeHidden();
  await expect(page.locator("#title-meta")).toBeHidden();
});

test("update flash stays hidden on a cold title; copy is non-scary", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const flash = page.locator("#update-flash");
  await expect(flash).toBeHidden();
  await expect(flash).toHaveText("Updating…");
  await expect(page.getByText(/Nate|Marty/i)).toHaveCount(0);
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
});

test("title is a safe reload moment; jam is not; pending waits for Reset", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  expect(await page.evaluate(() => window.__sprunkiJamTest?.pwaSafeToReload?.())).toBe(true);

  await page.evaluate(() => {
    const scare = document.getElementById("scare");
    if (scare) scare.hidden = false;
  });
  expect(
    await page.evaluate(() => window.__sprunkiJamTest?.pwaSafeToReload?.()),
    "do not reload over a scare overlay",
  ).toBe(false);
  await page.evaluate(() => {
    const scare = document.getElementById("scare");
    if (scare) scare.hidden = true;
  });
  expect(await page.evaluate(() => window.__sprunkiJamTest?.pwaSafeToReload?.())).toBe(true);

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  expect(await page.evaluate(() => window.__sprunkiJamTest?.pwaSafeToReload?.())).toBe(false);

  await page.evaluate(() => window.__sprunkiJamTest?.pwaRequestReload?.());
  expect(await page.evaluate(() => window.__sprunkiJamTest?.pwaReloadPending?.())).toBe(true);
  await page.waitForTimeout(250);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#update-flash")).toBeHidden();
  await expect(page.locator("#reset-btn")).toBeVisible();
});

test("service worker is not registered on a cold title; it is after TAP TO JAM", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
  const before = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    return (await navigator.serviceWorker.getRegistration()) ? "yes" : "no";
  });
  expect(before, "cold title must not install a SW that can race /assets").toBe("no");

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          if (!("serviceWorker" in navigator)) return "unsupported";
          return (await navigator.serviceWorker.getRegistration()) ? "yes" : "no";
        }),
      { timeout: 15_000, message: "SW should register only after TAP TO JAM" },
    )
    .toBe("yes");
});

test("update scheduler fires immediately, on a timer, and when the tab is visible", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const counts = await page.evaluate(async () => {
    let n = 0;
    const handle = window.__sprunkiJamTest!.bindPwaUpdateChecks!(() => {
      n += 1;
    }, { intervalMs: 40, debounceMs: 20 });
    const afterImmediate = n;
    await new Promise((r) => setTimeout(r, 100));
    const afterTimer = n;

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
    const beforeVis = n;
    setVis("hidden");
    setVis("visible");
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 80));
    const afterVisible = n;
    handle.dispose();
    return { afterImmediate, afterTimer, beforeVis, afterVisible };
  });

  expect(counts.afterImmediate, "check once when scheduling starts").toBeGreaterThanOrEqual(1);
  expect(counts.afterTimer, "interval should fire while visible").toBeGreaterThan(counts.afterImmediate);
  expect(counts.afterVisible, "visibility/focus should schedule another check").toBeGreaterThan(
    counts.beforeVis,
  );
});
