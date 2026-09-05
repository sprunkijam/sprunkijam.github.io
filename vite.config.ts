import { webcrypto } from "crypto";

// Ensure a Web Crypto API exists during build (used by serialize-javascript)
if (typeof (globalThis as any).crypto === "undefined") {
  (globalThis as any).crypto = webcrypto;
}

import type { HtmlTagDescriptor, Plugin } from "vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Tiny build id for version.json + the in-bundle compare (SW-stuck fallback). */
const jamBuiltAt = new Date();
const jamBuildVersion = jamBuiltAt.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

function emitVersionJson(): Plugin {
  const payload = JSON.stringify({ v: jamBuildVersion, t: jamBuiltAt.toISOString() });
  return {
    name: "emit-version-json",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url !== "/version.json") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
        res.end(payload);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: payload,
      });
    },
  };
}

/** Preload Pixi's WebGL renderer chunk in parallel with the main bundle. */
function preloadWebglRenderer(): Plugin {
  let base = "/";
  return {
    name: "preload-webgl-renderer",
    apply: "build",
    configResolved(config) {
      base = config.base || "/";
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return;
        const root = base.endsWith("/") ? base : `${base}/`;
        const tags: HtmlTagDescriptor[] = [];
        for (const fileName of Object.keys(bundle)) {
          if (
            /WebGLRenderer[^/]*\.js$/.test(fileName) ||
            /RenderTargetSystem[^/]*\.js$/.test(fileName) ||
            /BufferResource[^/]*\.js$/.test(fileName)
          ) {
            tags.push({
              tag: "link",
              attrs: {
                rel: "modulepreload",
                href: `${root}${fileName}`,
                crossorigin: "",
              },
              injectTo: "head",
            });
          }
        }
        return tags;
      },
    },
  };
}

export default defineConfig({
  define: {
    __JAM_BUILD_VERSION__: JSON.stringify(jamBuildVersion),
  },
  plugins: [
    preloadWebglRenderer(),
    emitVersionJson(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      filename: "sw.js",
      includeAssets: [
        "favicon.svg",
        "favicon-32.png",
        "favicon-48.png",
        "apple-touch-icon.png",
        "icons/pwa-192.png",
        "icons/pwa-512.png",
        "robots.txt",
        "art/icon-iphone-silent.svg",
        "art/icon-iphone-sound.svg",
        "art/icon-volume-up.svg",
      ],
      manifest: {
        id: "/",
        name: "Sprunki and Rainbow Friends Jam",
        short_name: "Sprunki RF Jam",
        description:
          "Sprunki and Rainbow Friends Jam — cheerful phases that get stranger. Surprises… just as Mr. Black planned. Works on modern browsers, phones, tablets, and desktop. No ads.",
        lang: "en",
        dir: "ltr",
        theme_color: "#140810",
        background_color: "#140810",
        display: "standalone",
        display_override: ["standalone", "fullscreen", "minimal-ui"],
        orientation: "any",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icons/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        globIgnores: ["**/version.json", "**/art/**"],
        cleanupOutdatedCaches: true,
        // autoUpdate already forces these; keep them explicit so a new SW
        // activates instead of sitting `waiting` for a skipWaiting message.
        skipWaiting: true,
        clientsClaim: true,
        // Ignore /assets so a SW installed later cannot hijack hashed chunks
        // that a cold iPhone load is still fetching. version.json must hit
        // the network so a stuck precache cannot hide a new deploy.
        navigateFallbackDenylist: [/^\/assets\//, /^\/version\.json$/],
      },
    }),
  ],
  server: { host: true },
  preview: { host: true },
});
