import "pixi.js/browser";
import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  WebGLRenderer,
} from "pixi.js";
import { AudioEngine } from "../audio/engine";
import { haptic } from "../input/haptics";
import { bindMobileViewport, desktopHostCssBox, ensureStageSize, visibleSize } from "../input/viewport";
import type { Phase, SlotId, StemId } from "../types";
import { canMerge, mergeLabel, PAD_STEM_CAP, SKIP_PHASES, SLOT_IDS, TRAY_STEMS } from "../types";
import { detectPlatform } from "../ui/platformGuide";
import { AmbientDust } from "../view/ambientDust";
import { StageBackground } from "../view/background";
import {
  SecretRun,
  secretDifficulty,
  type SecretSnapshot,
  type SecretTapResult,
} from "./secret";
import {
  createCharacter,
  createPadCharacter,
  createTrayIcon,
  idleRockAngle,
  preloadPortraits,
  type CharacterView,
  type TrayIconView,
} from "../view/characters";
import {
  cappedResolution,
  DESKTOP_GPU_ORIENT_IDLE_MS,
  DESKTOP_PRESENT_MATERIAL_PX,
  DESKTOP_PRESENT_REMOUNT_PX,
  frozenDesktopResolution,
  isMaterialPresentHostChange,
  isPortraitSize,
  pickFixedGpuSize,
  pickFrozenDesktopPresent,
  presentIdleMs,
  presentRemountCooldownMs,
  presentScaleFor,
  presentScaleIsUndersized,
  probeWebGlContext,
  shouldAntialias,
  shouldDeferGpuResize,
  shouldFitFrozenPresentToHost,
  shouldRefitFrozenDesktopBuffer,
  shouldFreezeGpuBuffer,
  shouldSnapshotPresentDuringResize,
  WEBGL_UNAVAILABLE_MESSAGE,
} from "../view/gpuBudget";
import { center, computeLayout, dist, type Layout } from "../view/layout";
import { PhaseTransition, type TransitionRecipeId } from "../view/phaseTransition";
import {
  adoptSnapshotUrl,
  captureCanvasBlobUrl,
  captureCanvasDataUrl,
  FROZEN_TEXTURE_GC_CHECK_COUNT_MAX,
  FROZEN_TEXTURE_GC_MAX_IDLE,
  revokeSnapshotUrl,
} from "../view/presentGuard";
import { makeSoftGlowSprite, makeSoftShadowSprite, placeSoftFalloff } from "../view/softFalloff";
import { TEXT_HALO } from "../view/textHalo";

// Keep WebGL in the static module graph so Vite does not wait on a dynamic import.
void WebGLRenderer;

/** iPhone touch: move this far before a seat press becomes a drag. */
const DRAG_MOVE_PX = 14;
/** Long-press also starts a seat drag without needing much movement. */
const LONG_PRESS_MS = 320;
/** Hover magnetism while dragging (tighter). */
const HOVER_SNAP = 0.62;
/** Finger-up snap — generous so near-miss pads still land on iPhone. */
const DROP_SNAP = 0.95;

interface Occupant {
  /** One to three distinct friends. Two mergeable singles use fuse art. */
  stems: StemId[];
  view: CharacterView;
  remove: Container;
}

interface DragState {
  stems: StemId[];
  ghost: Container;
  fromSlot: SlotId | null;
}

interface SeatPress {
  slot: SlotId;
  x: number;
  y: number;
  pointerId: number;
  longPressTimer: number | null;
}

export class SprunkiJam {
  readonly audio = new AudioEngine();
  private app: Application | null = null;
  private bootPromise: Promise<void> | null = null;
  private bg = new StageBackground();
  private transition = new PhaseTransition();
  private dust = new AmbientDust();
  private world = new Container();
  private slotLayer = new Container();
  private actorLayer = new Container();
  private trayLayer = new Container();
  private ghostLayer = new Container();
  private slotGfx = new Map<SlotId, Graphics>();
  /** Pad wrap — reused for hit-pop scale; never rebuilt. */
  private slotWraps = new Map<SlotId, Container>();
  /** Fill-only target glow — baked disc, never a per-sprite Filter. */
  private slotHi = new Map<SlotId, Sprite>();
  /** Ground blob under each pad; alpha eases in tick, size only on layout. */
  private slotShadow = new Map<SlotId, Sprite>();
  /** Soft omnidirectional pool around empty seats / secret prompts. */
  private slotPool = new Map<SlotId, Sprite>();
  /** Secret-game friend portraits, reused per pad. */
  private secretFaces = new Map<SlotId, CharacterView>();
  /** Reused DROP labels — never create/destroy Text on hover/relayout. */
  private slotLabels = new Map<SlotId, Text>();
  private secret = new SecretRun();
  private reduceMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private secretBtn = document.getElementById("secret-btn");
  private secretExitBtn = document.getElementById("secret-exit-btn");
  private secretScoreEl = document.getElementById("secret-score");
  private secretLivesEl = document.getElementById("secret-lives");
  private secretScoreboard = document.getElementById("secret-scoreboard");
  private secretOverEl = document.getElementById("secret-over");
  private secretOverScore = document.getElementById("secret-over-score");
  private secretOverHigh = document.getElementById("secret-over-high");
  private secretAgainBtn = document.getElementById("secret-again-btn");
  private secretOverExit = document.getElementById("secret-over-exit");
  private trayIcons = new Map<StemId, TrayIconView>();
  private occupants = new Map<SlotId, Occupant>();
  private layout!: Layout;
  private phase: Phase = 1;
  private dragging: DragState | null = null;
  private seatPress: SeatPress | null = null;
  private hover: SlotId | null = null;
  private scareBusy = false;
  private fullMixAt: number | null = null;
  private faceScareDone = false;
  private time = 0;
  private hintEl = document.getElementById("hint")!;
  private skipEl = document.getElementById("skip-dial")!;
  private phaseEl = document.getElementById("phase-num")!;
  private host: HTMLElement | null = null;
  private activePointerId: number | null = null;
  private dragHintShown = false;
  /** Last known drag/press position — used when Edge/Safari cancels without coords. */
  private lastPointerX = 0;
  private lastPointerY = 0;
  private globalDragEndsBound = false;
  /** Playwright-only sticky viewport override (iPhone presets cannot setViewportSize). */
  private forcedSize: { w: number; h: number } | null = null;
  private lastLayoutW = 0;
  private lastLayoutH = 0;
  private layoutRaf = 0;
  private layoutFollowup = 0;
  /** DROP Text constructions — must stay at 5, not grow on hover/relayout. */
  private dropLabelAllocs = 0;
  private layoutBusy = false;
  private layoutQueued = false;
  private relayoutCount = 0;
  private gpuResizeCount = 0;
  /** Snapshot URLs created (object or data). Must not climb while idle. */
  private snapshotUrlCount = 0;
  private lastRelayoutMs = 0;
  private maxRelayoutMs = 0;
  private antialiasEnabled = false;
  private platformFamily = detectPlatform().family;
  /**
   * Desktop: Pixi boots at the real host CSS / window box + capped DPR.
   * Canvas CSS stays locked; `#stage-present` letterboxes via `transform: scale(...)`.
   * Observer-driven `renderer.resize` is off. Idle remount never grows the
   * buffer (maximize animations look like idle). Windows shrinks (or stays on
   * the snapshot) when the host is meaningfully smaller than the GPU box.
   *
   * Windows: snapshot the last frame and remove the live canvas during drag.
   * Mac desktop also snapshots. iPhone: live GPU resize. WebGL only.
   */
  private gpuFrozen = false;
  private presentHost: HTMLElement | null = null;
  private presentScale = 1;
  private resizePauseTimer = 0;
  private tickerPausedForResize = false;
  /** True while the present surface is hidden for an active desktop resize. */
  private presentHiddenForResize = false;
  /** True while the live canvas is torn out and a static snapshot is showing. */
  private presentSnapshotForResize = false;
  private presentSnapshotEl: HTMLImageElement | null = null;
  /** Last known-good still — reuse on storm start instead of sync GPU readback. */
  private presentSnapshotUrl: string | null = null;
  private snapshotCacheTimer = 0;
  /** Last letterbox write — skip identical CSS so drag ticks cannot dirty layout. */
  private lastPresentLetterbox = { gw: 0, gh: 0, scale: Number.NaN };
  /** Last host box that armed / extended a desktop present storm. */
  private lastPresentHostW = 0;
  private lastPresentHostH = 0;
  /** Until this timestamp, ignore small host twitches after remount. */
  private remountQuietUntil = 0;
  /** Coalesce window.resize + visualViewport.resize to one rAF. */
  private presentResizeRaf = 0;
  private readonly onGlobalPointerEnd = (ev: Event): void => {
    this.handleGlobalPointerEnd(ev);
  };
  private readonly onDesktopPresentResize = (): void => {
    if (this.presentResizeRaf) return;
    this.presentResizeRaf = window.requestAnimationFrame(() => {
      this.presentResizeRaf = 0;
      this.handleDesktopPresentResize();
    });
  };

  /** Coalesce viewport observers to one rAF. Frozen desktop skips entirely. */
  private scheduleLayout = (): void => {
    if (this.gpuFrozen && !this.forcedSize) return;
    if (this.layoutRaf) return;
    this.layoutRaf = window.requestAnimationFrame(() => {
      this.layoutRaf = 0;
      this.relayout("observer");
    });
  };

  /**
   * Start (or reuse) Pixi boot. Later taps must await the same promise so a
   * slow first init is never treated as a failed start.
   */
  mount(host: HTMLElement): Promise<void> {
    if (this.app) return Promise.resolve();
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = this.boot(host).catch((err: unknown) => {
      this.bootPromise = null;
      throw err;
    });
    return this.bootPromise;
  }

  private async boot(host: HTMLElement): Promise<void> {
    this.host = host;
    const size = await ensureStageSize(host);
    if (!probeWebGlContext()) {
      throw new Error(WEBGL_UNAVAILABLE_MESSAGE);
    }
    this.gpuFrozen = shouldFreezeGpuBuffer(this.platformFamily);
    this.reflectWebGl();
    // Frozen desktop: CSS box stays at the real host pane. WebGL uses a
    // DPR-aware resolution inside the family backing ceiling (~2.16MP desktop).
    // Applied at boot only — drag ticks never call renderer.resize.
    const bootSize = this.gpuFrozen ? this.presentHostCss(size) : size;
    const bootPresent = this.gpuFrozen
      ? pickFrozenDesktopPresent(
          bootSize.w,
          bootSize.h,
          this.platformFamily,
          typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
        )
      : null;
    const gpu = bootPresent ?? { w: size.w, h: size.h };
    this.antialiasEnabled = shouldAntialias(gpu.w, gpu.h, this.platformFamily);
    const resolution = bootPresent
      ? bootPresent.resolution
      : cappedResolution(gpu.w, gpu.h);
    const app = await this.initPixiApplication({
      gpuW: gpu.w,
      gpuH: gpu.h,
      resolution,
    });
    this.app = app;
    this.reflectWebGl();
    this.dust.setFxBudget(this.platformFamily);
    if (this.gpuFrozen) {
      this.installPresentation(host, app.canvas, gpu.w, gpu.h);
    } else {
      host.appendChild(app.canvas);
      app.canvas.style.touchAction = "none";
      app.canvas.style.width = "100%";
      app.canvas.style.height = "100%";
      app.canvas.style.display = "block";
      app.canvas.style.objectFit = "fill";
    }
    this.bg.attachFill(this.installStageFill(host));
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;
    // Dust floats *above* pads/tray (eventMode none) so meadow pollen reads on
    // the photo, not only in the thin gaps under chips. Hop overlay still on top.
    app.stage.addChild(this.bg.root, this.world, this.dust.root, this.transition.root);
    this.world.addChild(this.slotLayer, this.actorLayer, this.trayLayer, this.ghostLayer);

    // Portrait crops + phase photo BGs — load before tray so first drop is never blank.
    await Promise.all([preloadPortraits(), this.bg.preload()]);

    for (const id of SLOT_IDS) {
      const wrap = new Container();
      wrap.eventMode = "none";
      const sh = makeSoftShadowSprite(0, 0, 18, 16);
      sh.tint = 0xf4f0e6;
      sh.alpha = 0.32;
      const pool = makeSoftGlowSprite(0, 0, 18, 16);
      pool.tint = 0xfff8f0;
      pool.alpha = 0.28;
      pool.blendMode = "normal";
      const g = new Graphics();
      g.eventMode = "none";
      const hi = makeSoftGlowSprite(0, 0, 18, 16);
      hi.blendMode = "add";
      wrap.addChild(sh, pool, g, hi);
      this.slotWraps.set(id, wrap);
      this.slotShadow.set(id, sh);
      this.slotPool.set(id, pool);
      this.slotGfx.set(id, g);
      this.slotHi.set(id, hi);
      this.slotLayer.addChild(wrap);
    }

    for (const stem of TRAY_STEMS) {
      const icon = createTrayIcon(stem, 88);
      icon.root.on("pointerdown", (ev) => {
        this.beginTrayDrag(stem, ev.global.x, ev.global.y, ev.pointerId);
      });
      this.trayIcons.set(stem, icon);
      this.trayLayer.addChild(icon.root);
    }

    app.stage.on("pointerdown", (ev) => {
      this.ensureAudio();
      if (this.secret.status === "playing") {
        this.onSecretPointer(ev.global.x, ev.global.y);
      }
    });
    app.stage.on("pointermove", (ev) => this.onMove(ev.global.x, ev.global.y, ev.pointerId));
    app.stage.on("pointerup", (ev) => this.endPointerGesture(ev.global.x, ev.global.y, ev.pointerId));
    app.stage.on("pointerupoutside", (ev) => this.endPointerGesture(ev.global.x, ev.global.y, ev.pointerId));
    app.stage.on("pointercancel", (ev) => this.endPointerGesture(ev.global.x, ev.global.y, ev.pointerId));
    app.ticker.add((t) => this.tick(t.deltaMS / 1000));
    // Windows Iris Xe: 60fps idle dust/pads was 10–25% CPU with little visual gain.
    if (this.platformFamily === "windows") app.ticker.maxFPS = 30;
    // Background tabs: stop the ticker so dust/pads do not burn CPU unseen.
    if (typeof document !== "undefined" && !document.body.dataset.sprunkiVisPause) {
      document.body.dataset.sprunkiVisPause = "1";
      const onVis = (): void => {
        const live = this.app;
        if (!live) return;
        if (document.visibilityState === "hidden") {
          this.dust.pause(true);
          live.ticker.stop();
        } else if (!this.tickerPausedForResize) {
          this.dust.pause(false);
          live.ticker.start();
        }
      };
      document.addEventListener("visibilitychange", onVis);
    }

    // iOS Edge/Safari often drops stage pointerup when capture is lost mid-drag.
    // Window/document/canvas listeners always tear down a stuck ghost.
    this.bindGlobalDragEnds(app.canvas);

    const scheduleLayout = this.scheduleLayout;
    if (this.gpuFrozen) {
      // Presentation scale follows the window; GPU buffer stays frozen.
      // A maximize/drag storm must not touch the backbuffer or canvas CSS box.
      bindMobileViewport(host);
      window.addEventListener("resize", this.onDesktopPresentResize);
      window.visualViewport?.addEventListener("resize", this.onDesktopPresentResize);
      window.addEventListener("orientationchange", () => {
        this.handleDesktopPresentResize();
        this.armOrientSettle();
      });
      this.updatePresentationScale();
    } else {
      bindMobileViewport(host, scheduleLayout);
      new ResizeObserver(scheduleLayout).observe(host);
      window.addEventListener("orientationchange", () => {
        scheduleLayout();
        // Late settle — some WebKit builds publish the final vv size ~100–300ms later.
        window.setTimeout(() => this.relayout("immediate"), 250);
      });
    }
    this.relayout("immediate");
    this.bindHud();
    this.applyPhase(1, false);
    this.dust.setDim(1);
    this.dust.pause(false);
    if (this.gpuFrozen) {
      window.requestAnimationFrame(() => {
        try {
          this.app?.render();
        } catch {
          /* first still is best-effort */
        }
        this.scheduleSnapshotCacheRefresh();
      });
    }
  }

  /**
   * Pixi init, WebGL only. A missing WebGL context is a title error — never
   * fall through to Canvas2D.
   */
  private async initPixiApplication(opts: {
    gpuW: number;
    gpuH: number;
    resolution: number;
  }): Promise<Application> {
    const app = new Application();
    try {
      await app.init({
        background: "#140810",
        width: opts.gpuW,
        height: opts.gpuH,
        // Manual resize only. Pixi resizeTo + visualViewport pin + ResizeObserver
        // used to reallocate the ANGLE backbuffer every frame on Windows.
        antialias: this.antialiasEnabled,
        // Frozen desktop: fixed CSS px + transform letterbox; don't let Pixi write sizes.
        autoDensity: !this.gpuFrozen,
        resolution: opts.resolution,
        preference: "webgl",
        // Iris Xe / Windows ANGLE: prefer the integrated adapter. Does not
        // change the present path; cheap insurance next to the desktop backing cap.
        ...(this.platformFamily === "windows" ? { powerPreference: "low-power" as const } : {}),
        hello: false,
        // GC stays on so leaked filter RTs cannot sit immortal. Frozen desktop
        // uses a slower cadence than Pixi's ~10s default (that scan churned
        // large sources).
        textureGCActive: true,
        renderableGCActive: true,
        textureGCMaxIdle: this.gpuFrozen ? FROZEN_TEXTURE_GC_MAX_IDLE : 3600,
        textureGCCheckCountMax: this.gpuFrozen
          ? FROZEN_TEXTURE_GC_CHECK_COUNT_MAX
          : 600,
      });
    } catch (err) {
      try {
        app.destroy(true);
      } catch {
        /* ignore a half-inited renderer */
      }
      if (!probeWebGlContext()) {
        throw new Error(WEBGL_UNAVAILABLE_MESSAGE);
      }
      const reason = err instanceof Error ? err.message : "renderer failed to start";
      throw new Error(`Graphics failed to load (${reason})`);
    }
    if (!app.renderer) {
      try {
        app.destroy(true);
      } catch {
        /* ignore */
      }
      throw new Error(WEBGL_UNAVAILABLE_MESSAGE);
    }
    return app;
  }

  /** Low-key diagnostics: `data-renderer` matches the live Pixi path. */
  private reflectWebGl(): void {
    document.body.dataset.renderer = "webgl";
  }

  /**
   * Tight host CSS box for frozen present (min of host vs inner window).
   * `forcedSize` wins for Playwright rotate helpers.
   */
  private presentHostCss(fallback?: { w: number; h: number }): { w: number; h: number } {
    if (this.forcedSize) return this.forcedSize;
    if (this.host) {
      return this.gpuFrozen ? desktopHostCssBox(this.host) : visibleSize(this.host);
    }
    if (fallback) return fallback;
    return { w: 320, h: 320 };
  }

  /**
   * CSS photo behind the (possibly letterboxed) canvas. Same JPEG + cover as
   * the Pixi sprite so Windows / Mac / Linux never show empty stage color bars.
   */
  private installStageFill(host: HTMLElement): HTMLImageElement {
    const existing = document.getElementById("stage-fill");
    if (existing instanceof HTMLImageElement) return existing;
    const el = document.createElement("img");
    el.id = "stage-fill";
    el.alt = "";
    el.setAttribute("aria-hidden", "true");
    el.decoding = "async";
    host.insertBefore(el, host.firstChild);
    return el;
  }

  /** GPU size for sprites; host CSS box picks landscape vs portrait. */
  private syncBgHost(gpuW: number, gpuH: number): void {
    this.bg.resize(gpuW, gpuH, this.presentHostCss());
  }

  /**
   * Lock the canvas CSS box to the GPU buffer and letterbox with a transform
   * wrapper. Changing canvas CSS width/height during drag is the Windows death
   * path that survived a WebGL freeze that still let the CSS box flex.
   *
   * Apply `--gpu-css-*` + inline locks **before** the canvas enters the flex
   * host. A one-frame `width:100%` is enough for ANGLE to reshape to window×DPR.
   */
  private installPresentation(
    host: HTMLElement,
    canvas: HTMLCanvasElement,
    gpuW: number,
    gpuH: number,
  ): void {
    document.body.dataset.presentFreeze = "1";
    this.reflectWebGl();
    this.applyFrozenCanvasCss(canvas, gpuW, gpuH);

    const wrap = document.createElement("div");
    wrap.id = "stage-present";
    wrap.setAttribute("data-stage-present", "1");
    this.presentHost = wrap;

    const css = this.presentHostCss();
    this.lastPresentHostW = css.w;
    this.lastPresentHostH = css.h;
    const scale = presentScaleFor(css.w, css.h, gpuW, gpuH);
    this.presentScale = scale;
    this.applyPresentLetterbox(wrap, gpuW, gpuH, scale);

    host.appendChild(wrap);
    wrap.appendChild(canvas);
  }

  private applyFrozenCanvasCss(canvas: HTMLCanvasElement, w: number, h: number): void {
    const gw = Math.max(1, Math.round(w));
    const gh = Math.max(1, Math.round(h));
    const widthPx = `${gw}px`;
    const heightPx = `${gh}px`;
    // CSS variables + !important rule — CSS flex (516×1100 on a 540×720 GPU)
    // is the in-jam freeze path even when gpuResizeCount stays 0.
    const root = document.documentElement.style;
    if (root.getPropertyValue("--gpu-css-w") !== widthPx) root.setProperty("--gpu-css-w", widthPx);
    if (root.getPropertyValue("--gpu-css-h") !== heightPx) root.setProperty("--gpu-css-h", heightPx);
    canvas.style.touchAction = "none";
    if (canvas.style.display !== "block") canvas.style.display = "block";
    if (canvas.style.width !== widthPx) canvas.style.width = widthPx;
    if (canvas.style.height !== heightPx) canvas.style.height = heightPx;
    if (canvas.style.maxWidth !== "none") canvas.style.maxWidth = "none";
    if (canvas.style.maxHeight !== "none") canvas.style.maxHeight = "none";
    if (canvas.style.objectFit !== "fill") canvas.style.objectFit = "fill";
  }

  /**
   * Letterbox `#stage-present` to the host. Width/height stay at the frozen GPU
   * box; only `transform: scale(...)` tracks the window. Skip identical writes.
   */
  private applyPresentLetterbox(wrap: HTMLElement, gw: number, gh: number, scale: number): void {
    if (
      this.lastPresentLetterbox.gw === gw &&
      this.lastPresentLetterbox.gh === gh &&
      this.lastPresentLetterbox.scale === scale
    ) {
      return;
    }
    this.lastPresentLetterbox = { gw, gh, scale };
    const widthPx = `${gw}px`;
    const heightPx = `${gh}px`;
    if (wrap.style.width !== widthPx) wrap.style.width = widthPx;
    if (wrap.style.height !== heightPx) wrap.style.height = heightPx;
    const transform = `scale(${scale})`;
    if (wrap.style.transform !== transform) wrap.style.transform = transform;
  }

  /**
   * Defense in depth: if anything (Pixi, stylesheet, browser) flexes the canvas
   * CSS box away from the GPU size, slam it back. Never call renderer.resize.
   */
  private ensureFrozenCanvasCss(): void {
    const app = this.app;
    if (!app || !this.gpuFrozen || this.presentSnapshotForResize) return;
    const gw = Math.max(1, Math.round(app.screen.width));
    const gh = Math.max(1, Math.round(app.screen.height));
    const canvas = app.canvas;
    if (Math.abs(canvas.clientWidth - gw) > 1 || Math.abs(canvas.clientHeight - gh) > 1) {
      this.applyFrozenCanvasCss(canvas, gw, gh);
    }
  }

  private updatePresentationScale(): void {
    const host = this.host;
    const wrap = this.presentHost;
    const app = this.app;
    if (!host || !wrap || !app || !this.gpuFrozen) return;
    const css = this.presentHostCss();
    const gw = Math.max(1, Math.round(app.screen.width));
    const gh = Math.max(1, Math.round(app.screen.height));
    const scale = presentScaleFor(css.w, css.h, gw, gh);
    this.presentScale = scale;
    this.applyPresentLetterbox(wrap, gw, gh, scale);
    // Mid-snapshot: only the static <img> is in the wrap. Do not touch the
    // detached Pixi canvas (no bitmap / CSS box writes during the drag).
    if (this.presentSnapshotForResize) {
      if (this.presentSnapshotEl) {
        const widthPx = `${gw}px`;
        const heightPx = `${gh}px`;
        if (this.presentSnapshotEl.style.width !== widthPx) this.presentSnapshotEl.style.width = widthPx;
        if (this.presentSnapshotEl.style.height !== heightPx) this.presentSnapshotEl.style.height = heightPx;
      }
      return;
    }
    this.applyFrozenCanvasCss(app.canvas, gw, gh);
    this.ensureFrozenCanvasCss();
  }

  /**
   * Desktop window drag: pause ticker, snapshot-teardown the live canvas, and
   * CSS-letterbox the photo every tick. Never touch renderer.resize or the
   * live canvas CSS box while the window edge is moving.
   *
   * window.resize and visualViewport.resize share this handler (coalesced rAF).
   * Same-size echoes after remount do not re-enter snapshot.
   *
   * After idle: remount canvas, drop the photo, commit letterbox, resume.
   * Windows: if the host is smaller than the GPU box, shrink the frozen
   * buffer first (or keep the snapshot). Never remount an oversized live
   * canvas. Maximize / enlarge: grow the frozen buffer to the host (within
   * budget) so letterbox bars disappear — otherwise phase FX only cover the
   * canvas while #stage-fill shows bright strips around a black hop.
   * Remount cooldown still blocks mid-storm realloc.
   */
  private handleDesktopPresentResize(): void {
    if (!this.gpuFrozen || !this.app || !this.host) return;
    const css = this.presentHostCss();
    const inQuiet =
      performance.now() < this.remountQuietUntil && !this.presentSnapshotForResize;
    const threshold = inQuiet ? DESKTOP_PRESENT_REMOUNT_PX : DESKTOP_PRESENT_MATERIAL_PX;
    if (
      !isMaterialPresentHostChange(
        this.lastPresentHostW,
        this.lastPresentHostH,
        css.w,
        css.h,
        threshold,
      )
    ) {
      return;
    }
    this.lastPresentHostW = css.w;
    this.lastPresentHostH = css.h;
    this.bg.setHostBox(css.w, css.h);
    this.pauseTickerForResize();
    this.updateSnapshotLetterbox();
    if (this.resizePauseTimer) window.clearTimeout(this.resizePauseTimer);
    this.resizePauseTimer = window.setTimeout(() => {
      this.resizePauseTimer = 0;
      this.finishDesktopPresentResize();
    }, presentIdleMs(this.platformFamily));
  }

  /**
   * Idle settle after a desktop resize storm. Windows must not put a live
   * canvas back into the compositor when presentScale would be << 1.
   */
  private finishDesktopPresentResize(): void {
    if (shouldFitFrozenPresentToHost(this.platformFamily)) {
      this.fitFrozenGpuToHostIfUndersized();
    }
    this.refitFrozenGpuToHostIfNeeded();
    const css = this.presentHostCss();
    const app = this.app;
    const gw = Math.max(1, Math.round(app?.screen.width ?? css.w));
    const gh = Math.max(1, Math.round(app?.screen.height ?? css.h));
    const scale = presentScaleFor(css.w, css.h, gw, gh);
    this.presentScale = scale;
    const undersized =
      shouldFitFrozenPresentToHost(this.platformFamily) && presentScaleIsUndersized(scale);
    if (!undersized) {
      this.exitPresentSnapshot();
      this.updatePresentationScale();
      this.ensureFrozenCanvasCss();
    } else {
      this.updateSnapshotLetterbox();
    }
    this.resumeTickerAfterResize({ remount: !undersized });
    if (!undersized) {
      this.remountQuietUntil = performance.now() + presentRemountCooldownMs(this.platformFamily);
    }
  }

  /**
   * Idle-only: if the host is meaningfully smaller than the frozen GPU box,
   * rebuild the buffer at the host present. Canvas is detached (snapshot).
   * Never grow. Never call this mid-drag.
   */
  private fitFrozenGpuToHostIfUndersized(): void {
    const app = this.app;
    if (!app || !this.gpuFrozen) return;
    const css = this.presentHostCss();
    const curW = Math.max(1, Math.round(app.screen.width));
    const curH = Math.max(1, Math.round(app.screen.height));
    const scale = presentScaleFor(css.w, css.h, curW, curH);
    if (!presentScaleIsUndersized(scale)) return;
    const want = pickFrozenDesktopPresent(
      css.w,
      css.h,
      this.platformFamily,
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    );
    this.commitFrozenGpuSize(want.w, want.h, want.resolution);
  }

  /**
   * Idle-only: rebuild the frozen buffer to the settled host (grow, aspect
   * flip, or modest size change). Stops letterbox bars so phase transitions
   * cover the full stage instead of a black rectangle inside #stage-fill art.
   */
  private refitFrozenGpuToHostIfNeeded(): void {
    const app = this.app;
    if (!app || !this.gpuFrozen) return;
    const css = this.presentHostCss();
    const curW = Math.max(1, Math.round(app.screen.width));
    const curH = Math.max(1, Math.round(app.screen.height));
    const curRes = app.renderer.resolution ?? 1;
    const want = pickFrozenDesktopPresent(
      css.w,
      css.h,
      this.platformFamily,
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    );
    if (
      !shouldRefitFrozenDesktopBuffer(curW, curH, curRes, want.w, want.h, want.resolution)
    ) {
      return;
    }
    this.commitFrozenGpuSize(want.w, want.h, want.resolution);
  }

  private commitFrozenGpuSize(w: number, h: number, resolution: number): void {
    const app = this.app;
    if (!app) return;
    const resNow = app.renderer.resolution ?? 1;
    const gpuDirty =
      Math.abs(app.screen.width - w) > 0.5 ||
      Math.abs(app.screen.height - h) > 0.5 ||
      Math.abs(resNow - resolution) > 0.01;
    if (gpuDirty) {
      app.renderer.resize(w, h, resolution);
      this.gpuResizeCount += 1;
    }
    app.stage.hitArea = app.screen;
    this.lastLayoutW = w;
    this.lastLayoutH = h;
    this.layout = computeLayout(app.screen.width, app.screen.height);
    this.syncBgHost(app.screen.width, app.screen.height);
    this.transition.resize(app.screen.width, app.screen.height);
    this.dust.resize(app.screen.width, app.screen.height);
    this.drawSlots();
    this.placeTray();
    this.placeOccupants();
    this.lastPresentLetterbox = { gw: 0, gh: 0, scale: Number.NaN };
    this.applyFrozenCanvasCss(app.canvas, app.screen.width, app.screen.height);
    this.updateSnapshotLetterbox();
  }

  /**
   * CSS-only letterbox of #stage-present (snapshot or locked canvas box).
   * Does not write canvas width/height or call renderer.resize.
   */
  private updateSnapshotLetterbox(): void {
    const host = this.host;
    const wrap = this.presentHost;
    const app = this.app;
    if (!host || !wrap || !app || !this.gpuFrozen) return;
    const css = this.presentHostCss();
    const gw = Math.max(1, Math.round(app.screen.width));
    const gh = Math.max(1, Math.round(app.screen.height));
    const scale = presentScaleFor(css.w, css.h, gw, gh);
    this.presentScale = scale;
    this.applyPresentLetterbox(wrap, gw, gh, scale);
  }

  private pauseTickerForResize(): void {
    const app = this.app;
    if (!app) return;
    if (!this.tickerPausedForResize) {
      this.tickerPausedForResize = true;
      document.body.dataset.resizePaused = "1";
      this.dust.pause(true);
      app.ticker.stop();
      try {
        app.stop();
      } catch {
        /* older Pixi shapes may only expose ticker.stop */
      }
    }
    if (shouldSnapshotPresentDuringResize(this.platformFamily)) {
      this.enterPresentSnapshot();
    }
  }

  /**
   * Yank the live Pixi canvas out of the document first, then show a still.
   * Prefer the cached frame — sync GPU readback on storm start pegs a core
   * while the canvas is still compositing.
   */
  private enterPresentSnapshot(): void {
    if (this.presentSnapshotForResize) return;
    const app = this.app;
    const wrap = this.presentHost ?? this.host;
    if (!app || !wrap) return;

    const canvas = app.canvas;
    const gw = Math.max(1, Math.round(app.screen.width));
    const gh = Math.max(1, Math.round(app.screen.height));

    this.detachLiveCanvas(wrap, canvas);

    this.presentSnapshotForResize = true;
    document.body.dataset.presentSnapshot = "1";
    this.transition.pauseFx(true);
    this.dust.pause(true);

    let url = this.presentSnapshotUrl;
    if (!url) {
      // Detached already. One emergency still — never a mid-storm recapture.
      url = captureCanvasDataUrl(canvas);
      if (url) {
        this.presentSnapshotUrl = url;
        this.snapshotUrlCount += 1;
      }
    }
    this.mountPresentSnapshot(wrap, gw, gh, url);
  }

  /** Hide + remove every live canvas in the present wrap. Safe to call twice. */
  private detachLiveCanvas(wrap: HTMLElement, canvas: HTMLCanvasElement): void {
    canvas.style.display = "none";
    canvas.style.visibility = "hidden";
    canvas.style.pointerEvents = "none";
    for (const el of [...wrap.querySelectorAll("canvas")]) {
      el.style.display = "none";
      el.style.visibility = "hidden";
      el.style.pointerEvents = "none";
      if (el.isConnected) el.remove();
    }
    if (canvas.isConnected) canvas.remove();
  }

  private mountPresentSnapshot(
    wrap: HTMLElement,
    gw: number,
    gh: number,
    url: string | null,
  ): void {
    const img = document.createElement("img");
    img.id = "stage-snapshot";
    img.setAttribute("data-stage-snapshot", "1");
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    img.style.pointerEvents = "none";
    img.style.display = "block";
    img.style.touchAction = "none";
    img.style.width = `${gw}px`;
    img.style.height = `${gh}px`;
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
    img.style.objectFit = "fill";
    img.style.userSelect = "none";
    if (url) img.src = url;
    wrap.appendChild(img);
    this.presentSnapshotEl = img;
  }

  /**
   * Put the live canvas back, drop the photo, restore hit testing.
   * Re-apply frozen CSS **before** insert so the host never flashes at
   * width/height 100% of the window.
   */
  private exitPresentSnapshot(): void {
    if (!this.presentSnapshotForResize) return;
    const app = this.app;
    const wrap = this.presentHost ?? this.host;
    if (app && wrap) {
      const canvas = app.canvas;
      const gw = Math.max(1, Math.round(app.screen.width));
      const gh = Math.max(1, Math.round(app.screen.height));
      this.applyFrozenCanvasCss(canvas, gw, gh);
      this.updateSnapshotLetterbox();
      canvas.style.display = "block";
      canvas.style.visibility = "";
      canvas.style.pointerEvents = "";
      if (!wrap.contains(canvas)) {
        wrap.insertBefore(canvas, wrap.firstChild);
      }
      try {
        app.render();
      } catch {
        /* first frame after remount is best-effort */
      }
    }
    if (this.presentSnapshotEl) {
      this.presentSnapshotEl.remove();
      this.presentSnapshotEl.src = "";
      this.presentSnapshotEl = null;
    }
    this.presentSnapshotForResize = false;
    delete document.body.dataset.presentSnapshot;
    this.transition.pauseFx(false);
    this.dust.pause(false);
    // Do not recapture the frozen buffer on remount — that readback retains
    // the current framebuffer (the idle + resize climb).
    if (!this.presentSnapshotUrl) this.scheduleSnapshotCacheRefresh();
  }

  private scheduleSnapshotCacheRefresh(): void {
    if (this.snapshotCacheTimer) window.clearTimeout(this.snapshotCacheTimer);
    this.snapshotCacheTimer = window.setTimeout(() => {
      this.snapshotCacheTimer = 0;
      this.refreshPresentSnapshotCache();
    }, 100);
  }

  /** Idle-only JPEG of the live canvas. Never run this mid-storm or if we already hold a still. */
  private refreshPresentSnapshotCache(): void {
    const app = this.app;
    if (!app || this.presentSnapshotForResize || !app.canvas) return;
    if (this.presentSnapshotUrl) return;
    captureCanvasBlobUrl(app.canvas, (url) => {
      if (this.presentSnapshotForResize || this.presentSnapshotUrl) {
        revokeSnapshotUrl(url);
        return;
      }
      this.presentSnapshotUrl = adoptSnapshotUrl(this.presentSnapshotUrl, url);
      this.snapshotUrlCount += 1;
    });
  }

  private resumeTickerAfterResize(opts?: { remount?: boolean }): void {
    const app = this.app;
    if (!app || !this.tickerPausedForResize) return;
    if (opts?.remount !== false) this.exitPresentSnapshot();
    this.tickerPausedForResize = false;
    this.presentHiddenForResize = false;
    delete document.body.dataset.resizePaused;
    delete document.body.dataset.presentHidden;
    this.dust.pause(false);
    if (this.presentHost) this.presentHost.style.visibility = "";
    app.canvas.style.visibility = "";
    app.canvas.style.display = "block";
    try {
      app.start();
    } catch {
      app.ticker.start();
    }
  }

  /** Immediate title escape — must not wait on whoosh timers when the tab is wedged. */
  private navigateHomeNow(): void {
    const dest = `${window.location.pathname}${window.location.search}`;
    try {
      window.location.href = dest;
    } catch {
      try {
        window.location.reload();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Capture-phase listeners so a lost gesture still clears dragging even when
   * Pixi never sees pointerup (common on iPhone Edge / Safari WebKit).
   */
  private bindGlobalDragEnds(canvas: HTMLCanvasElement): void {
    if (this.globalDragEndsBound) return;
    this.globalDragEndsBound = true;
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const target of [window, document, canvas]) {
      target.addEventListener("pointerup", this.onGlobalPointerEnd, opts);
      target.addEventListener("pointercancel", this.onGlobalPointerEnd, opts);
      target.addEventListener("lostpointercapture", this.onGlobalPointerEnd, opts);
      target.addEventListener("touchend", this.onGlobalPointerEnd, opts);
      target.addEventListener("touchcancel", this.onGlobalPointerEnd, opts);
    }
  }

  private handleGlobalPointerEnd(ev: Event): void {
    if (!this.dragging && !this.seatPress) return;
    const pos = this.eventToStage(ev);
    this.endPointerGesture(pos?.x ?? this.lastPointerX, pos?.y ?? this.lastPointerY, undefined);
  }

  private eventToStage(ev: Event): { x: number; y: number } | null {
    const app = this.app;
    if (!app) return null;
    let clientX: number | null = null;
    let clientY: number | null = null;
    if (ev instanceof PointerEvent) {
      clientX = ev.clientX;
      clientY = ev.clientY;
    } else if (typeof TouchEvent !== "undefined" && ev instanceof TouchEvent) {
      const t = ev.changedTouches[0] ?? ev.touches[0];
      if (t) {
        clientX = t.clientX;
        clientY = t.clientY;
      }
    }
    if (clientX == null || clientY == null) return null;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = app.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * app.screen.width,
      y: ((clientY - rect.top) / rect.height) * app.screen.height,
    };
  }

  /**
   * First-gesture audio unlock from TAP TO JAM. Never throws; silent jam is
   * better than a failed start. Stage taps call ensureAudio() to retry if
   * iOS WebKit dropped the first gesture.
   */
  unlock(): void {
    try {
      this.audio.unlock();
      this.audio.setPhase(this.phase);
      haptic(16);
    } catch (err) {
      console.error(err);
    }
  }

  /** Retry Web Audio resume on later taps/drags if the first gesture was lost. */
  ensureAudio(): void {
    this.audio.unlock();
  }

  /** Test helper: seat stem(s) on a slot without pointer simulation. */
  testPlace(stem: StemId, slot: SlotId = "mid"): void {
    void this.drop(stem, slot, [stem]);
  }

  /** Test helper: stems currently on a pad (merge/stack-aware). */
  testSlotStems(slot: SlotId): StemId[] | null {
    const occ = this.occupants.get(slot);
    return occ ? [...occ.stems] : null;
  }

  /** Test helper: CharacterView.stems (trio fan must list 3, not a 2-fuse). */
  testOccupantViewStems(slot: SlotId): StemId[] | null {
    const occ = this.occupants.get(slot);
    return occ ? [...occ.view.stems] : null;
  }

  /** Test helper: seated idle-rock + friend-colored glow. */
  testOccupantLook(slot: SlotId): { rocks: number[]; glow: number } | null {
    const occ = this.occupants.get(slot);
    if (!occ) return null;
    return { rocks: occ.view.rockAngles(), glow: occ.view.glowAlpha() };
  }

  /** Test helper: whether a drag ghost is active. */
  testIsDragging(): boolean {
    return this.dragging != null;
  }

  /** Test helper: whether a tray icon is interactive (not stuck mid-drag). */
  testTrayInteractive(stem: StemId): boolean {
    const icon = this.trayIcons.get(stem);
    return Boolean(icon && icon.root.eventMode === "static" && icon.root.alpha > 0.5);
  }

  /**
   * Test helper: start a tray drag, move outside every pad's drop snap,
   * then end with a mismatched pointer id — must not leave a stuck ghost.
   */
  testBeginDragThenCancel(stem: StemId): void {
    const app = this.app;
    if (!app || !this.layout) return;
    const sx = app.screen.width * 0.2;
    const sy = app.screen.height * 0.92;
    this.beginTrayDrag(stem, sx, sy, 42);
    const miss = this.offPadPoint();
    this.onMove(miss.x, miss.y, 42);
    // Mismatched pointer id — iOS Edge cancel path; must still clear dragging.
    this.endPointerGesture(this.lastPointerX, this.lastPointerY, 999);
  }

  /** Test helper: lift a seated group and drop off every pad (tray return). */
  testDragSeatOffPad(slot: SlotId): void {
    if (!this.layout || !this.occupants.has(slot)) return;
    const c = center(this.layout.slots[slot]);
    this.onSeatPointerDown(slot, c.x, c.y, 7);
    this.promoteSeatDrag(c.x, c.y);
    const miss = this.offPadPoint();
    this.onMove(miss.x, miss.y, 7);
    this.endPointerGesture(miss.x, miss.y, 7);
  }

  /** A point that is not inside any pad's generous drop snap. */
  private offPadPoint(): { x: number; y: number } {
    const { w, stageTop, stageBottom } = this.layout;
    const candidates = [
      { x: 8, y: stageTop + 6 },
      { x: w - 8, y: stageTop + 6 },
      { x: w * 0.5, y: stageBottom - 4 },
      { x: 8, y: (stageTop + stageBottom) / 2 },
      { x: -80, y: -80 },
    ];
    for (const p of candidates) {
      if (!this.bestSlot(p.x, p.y, DROP_SNAP)) return p;
    }
    return { x: -80, y: -80 };
  }

  /** Test helper: current mix duck gain (1 = full). */
  testMixGain(): number {
    return this.audio.mixGain();
  }

  /** Test helper: seated stem is in the audible mix (no mute/solo cycle). */
  testIsAudible(stem: StemId): boolean {
    return this.audio.isAudible(stem);
  }

  /** Test helper: canvas coords of a pad center (for tap/drag smoke). */
  testSlotCenter(slot: SlotId): { x: number; y: number } | null {
    if (!this.layout?.slots[slot]) return null;
    return center(this.layout.slots[slot]);
  }

  /** Test helper: snap mix duck (simulates a stuck cue without a real hop). */
  testSilenceMix(on: boolean): void {
    this.audio.silence(on);
  }

  /** Test helper: fire a phase-hop duck cue (Safari stacked-ramp path). */
  testPhaseTransitionCue(kind: "cosmic-to-vortex" | "reverse-unwind" = "cosmic-to-vortex"): void {
    this.audio.phaseTransitionCue(kind);
  }

  /** Test helper: apply a phase without the cinematic overlay. */
  testSetPhase(phase: Phase): void {
    this.relayout();
    this.applyPhase(phase, false);
  }

  /** Test helper: cinematic phase hop (prepare → transition → finishReveal). */
  async testGotoPhase(phase: Phase): Promise<void> {
    await this.gotoPhase(phase, "skip");
  }

  /** Test helper: cinematic overlay is a one-shot — busy during hop, gone after. */
  testTransitionState(): { busy: boolean; visible: boolean } {
    return { busy: this.transition.busy, visible: this.transition.root.visible };
  }

  testTransitionFx(): { budget: string; bloom: boolean; paused: boolean } {
    return this.transition.testFx();
  }

  testDustState(): {
    count: number;
    live: number;
    dim: number;
    paused: boolean;
    phase: number;
    visible: boolean;
    particleChildren: number;
    w: number;
    h: number;
    updates: number;
  } {
    return this.dust.testState();
  }

  /** Test helper: pin cinematic progress for screenshots (null resumes). */
  testFreezeTransition(u: number | null): void {
    this.transition.freezeAt(u);
  }

  /**
   * Test helper: visible phase photo must cover the stage (guards rotate+phase
   * black half-screen regressions).
   */
  testBgCoverage(): ReturnType<StageBackground["testCoverage"]> {
    return this.bg.testCoverage();
  }

  /**
   * Test helper: live Pixi object counts. DROP labels and Graphics children must
   * stay bounded across ticks, hops, and relayout storms (Windows RAM leak guard).
   */
  testSceneStats(): {
    displayObjects: number;
    graphics: number;
    texts: number;
    graphicsInstructions: number;
    padLabels: number;
    slotChildren: number;
    dropLabelAllocs: number;
  } {
    let displayObjects = 0;
    let graphics = 0;
    let texts = 0;
    let graphicsInstructions = 0;
    const walk = (node: Container): void => {
      displayObjects += 1;
      if (node instanceof Graphics) {
        graphics += 1;
        graphicsInstructions += node.context?.instructions?.length ?? 0;
      }
      if (node instanceof Text) texts += 1;
      for (const child of node.children) walk(child as Container);
    };
    if (this.app) walk(this.app.stage);
    let slotChildren = 0;
    for (const g of this.slotGfx.values()) slotChildren += g.children.length;
    return {
      displayObjects,
      graphics,
      texts,
      graphicsInstructions,
      padLabels: this.slotLabels.size,
      slotChildren,
      dropLabelAllocs: this.dropLabelAllocs,
    };
  }

  /** Test helper: call drawSlots many times (hover restyle) without creating Text. */
  testPumpDrawSlots(times: number): void {
    if (!this.layout) this.relayout();
    const ids: SlotId[] = ["mid", "left", "right", "tl", "tr"];
    for (let i = 0; i < times; i++) {
      this.hover = ids[i % ids.length]!;
      this.drawSlots();
    }
    this.hover = null;
    this.drawSlots();
  }

  /** Test helper: repeat relayout (same size should early-out; still safe if it does not). */
  testPumpRelayout(times: number): void {
    for (let i = 0; i < times; i++) this.relayout();
  }

  /**
   * Test helper: layout/GPU resize counters for maximize freeze guards.
   */
  testLayoutProbe(): {
    relayoutCount: number;
    gpuResizeCount: number;
    lastRelayoutMs: number;
    maxRelayoutMs: number;
    inRelayout: boolean;
    screenW: number;
    screenH: number;
    resolution: number;
    antialias: boolean;
    backingPixels: number;
    gpuFrozen: boolean;
    canvasCssW: number;
    canvasCssH: number;
    hostCssW: number;
    hostCssH: number;
    presentScale: number;
    tickerPausedForResize: boolean;
    presentHiddenForResize: boolean;
    presentSnapshotForResize: boolean;
    canvasInDom: boolean;
    presentFreeze: boolean;
    devicePixelRatio: number;
    rendererName: string;
    presentMode: "webgl";
    webglContext: boolean;
    dustLive: number;
    dustCount: number;
    dustDim: number;
    dustPaused: boolean;
    dustPhase: number;
    dustVisible: boolean;
    snapshotUrlCount: number;
    filterResizeCount: number;
    dustUpdates: number;
  } {
    const app = this.app;
    const res = app?.renderer.resolution ?? 0;
    const w = app?.screen.width ?? 0;
    const h = app?.screen.height ?? 0;
    const canvas = app?.canvas;
    const canvasInDom = Boolean(canvas?.isConnected);
    // clientWidth is layout size (ignores transform) — must stay at GPU size when frozen.
    // Detached mid-snapshot: report the locked GPU size, not 0.
    const liveCss = canvasInDom && (canvas?.clientWidth ?? 0) > 0;
    const cssW = liveCss ? canvas!.clientWidth : Math.round(w);
    const cssH = liveCss ? canvas!.clientHeight : Math.round(h);
    const rendererName = app?.renderer.name ?? "";
    const hostCss = this.presentHostCss();
    const dust = this.dust.testState();
    return {
      relayoutCount: this.relayoutCount,
      gpuResizeCount: this.gpuResizeCount,
      lastRelayoutMs: this.lastRelayoutMs,
      maxRelayoutMs: this.maxRelayoutMs,
      inRelayout: this.layoutBusy,
      screenW: w,
      screenH: h,
      resolution: res,
      antialias: this.antialiasEnabled,
      backingPixels: Math.round(w * h * res * res),
      gpuFrozen: this.gpuFrozen,
      canvasCssW: cssW,
      canvasCssH: cssH,
      hostCssW: hostCss.w,
      hostCssH: hostCss.h,
      presentScale: this.presentScale,
      tickerPausedForResize: this.tickerPausedForResize,
      presentHiddenForResize: this.presentHiddenForResize,
      presentSnapshotForResize: this.presentSnapshotForResize,
      canvasInDom,
      presentFreeze: document.body.dataset.presentFreeze === "1",
      devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      rendererName,
      presentMode: "webgl",
      webglContext: true,
      dustLive: dust.live,
      dustCount: dust.count,
      dustDim: dust.dim,
      dustPaused: dust.paused,
      dustPhase: dust.phase,
      dustVisible: dust.visible,
      snapshotUrlCount: this.snapshotUrlCount,
      filterResizeCount: this.transition.testFilterResizeCount(),
      dustUpdates: dust.updates,
    };
  }

  /**
   * Test helper: enter snapshot teardown without a material host-size change.
   * Production ignores same-size visualViewport echoes; tests still need to
   * arm the storm in the same turn as a DOM inspect.
   */
  testForcePresentSnapshot(): void {
    if (!this.gpuFrozen || !this.app) return;
    this.pauseTickerForResize();
    this.updateSnapshotLetterbox();
  }

  /**
   * Test helper: simulate an orientation/viewport change when Playwright cannot
   * resize an iPhone-emulated window. Sticky so later gotoPhase → relayout keeps
   * the forced size (same path as a real rotate on device). Always resizes the
   * GPU — this is not the desktop window-drag path.
   */
  testForceStageSize(w: number, h: number): void {
    this.forcedSize = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    const host = this.host;
    if (host) {
      host.style.width = `${this.forcedSize.w}px`;
      host.style.height = `${this.forcedSize.h}px`;
    }
    this.relayout();
  }

  /**
   * Test helper: stage pad ids from the live layout (no portal).
   */
  testSlotIds(): SlotId[] {
    return SLOT_IDS.filter((id) => this.slotGfx.has(id));
  }

  /**
   * Test helper: empty-pad Pixi labels (should be DROP, never MR. BLACK).
   */
  testPadLabels(): string[] {
    const labels: string[] = [];
    for (const g of this.slotGfx.values()) {
      for (const child of g.children) {
        if (child instanceof Text && child.visible) labels.push(child.text);
      }
    }
    return labels;
  }

  testSecretSnapshot(): SecretSnapshot {
    return this.secret.snapshot();
  }

  testStartSecret(): void {
    this.startSecret();
  }

  testExitSecret(): void {
    this.exitSecret({ restoreJam: true });
  }

  testSecretSpawn(slots: SlotId | readonly SlotId[], windowMs = 10_000): void {
    this.ensureAudio();
    // `active` is also true while status === "over". Restart so the game-over
    // card is dismissed and lives/score reset before pinning a prompt.
    if (this.secret.status !== "playing") this.startSecret();
    this.secret.forcePrompt(slots, windowMs);
    this.syncSecretHud();
    this.drawSlots();
  }

  testSecretTap(slot: SlotId): SecretTapResult {
    this.ensureAudio();
    const result = this.secret.tap(slot);
    this.onSecretTapResult(result, slot);
    return result;
  }

  testSecretCurve(elapsedMs: number): ReturnType<typeof secretDifficulty> {
    return secretDifficulty(elapsedMs);
  }

  testSecretFaces(): Partial<Record<SlotId, string>> {
    return this.secret.liveFaces();
  }

  testSecretPadLook(): Record<SlotId, { stem: string | null; glow: "green" | "red" | "none" }> {
    const now = performance.now();
    const snap = this.secret.snapshot(now);
    const out = {} as Record<SlotId, { stem: string | null; glow: "green" | "red" | "none" }>;
    for (const id of SLOT_IDS) {
      const isTarget = snap.status === "playing" && snap.targets.includes(id);
      const isDecoy = snap.status === "playing" && snap.decoy === id;
      const isLose = snap.loseSlots.includes(id);
      const fx = this.secret.fx;
      const isHit = Boolean(fx && fx.kind === "hit" && fx.slot === id && now < fx.until);
      const isMiss = Boolean(fx && fx.kind === "miss" && fx.slot === id && now < fx.until);
      let glow: "green" | "red" | "none" = "none";
      if (isHit || (isTarget && !isMiss && !isLose)) glow = "green";
      else if (isMiss || isLose) glow = "red";
      out[id] = {
        stem: snap.faces[id] ?? null,
        glow: isDecoy && glow === "green" ? "none" : glow,
      };
    }
    return out;
  }

  testSecretEnd(): void {
    this.secret.endRun();
    this.syncSecretHud();
    this.showSecretOver();
    this.drawSlots();
  }

  /**
   * RESET returns to the TAP TO JAM title gate.
   * `#gate` is removed after enterGame(), so a full reload is the reliable
   * iPhone Edge / Safari path — hero crossfade and title bed all come back
   * clean. Navigation is **immediate**: a 380ms whoosh timer never fires when
   * Windows Chrome has wedged the main thread mid-resize.
   */
  reset(): void {
    // Escape first — if the tab is struggling, do not wait on audio timers.
    this.navigateHomeNow();
    if (this.scareBusy) return;
    try {
      this.exitSecret({ restoreJam: false });
      this.cancelSeatPress();
      this.abortDrag({ restoreSeat: false });
      this.audio.restoreMixGain();
      this.audio.whoosh(true);
      delete document.body.dataset.ready;
    } catch {
      /* navigating away — best-effort only */
    }
  }

  private bindHud(): void {
    const resetBtn = document.getElementById("reset-btn");
    // Capture-phase: always schedule navigation even if later handlers hang.
    resetBtn?.addEventListener(
      "pointerdown",
      (e) => {
        e.preventDefault();
        this.navigateHomeNow();
      },
      { capture: true },
    );
    resetBtn?.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.reset();
    });
    this.skipEl.querySelectorAll<HTMLButtonElement>("button[data-phase]").forEach((btn) => {
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (this.secret.active) return;
        const next = Number(btn.dataset.phase) as Phase;
        if (SKIP_PHASES.includes(next)) void this.gotoPhase(next, "skip");
      });
    });
    this.secretBtn?.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startSecret();
    });
    this.secretExitBtn?.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.exitSecret({ restoreJam: true });
    });
    this.secretAgainBtn?.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startSecret();
    });
    this.secretOverExit?.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.exitSecret({ restoreJam: true });
    });
    this.secretOverEl?.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });
  }

  private armGpuSettle(): void {
    if (this.layoutFollowup) window.clearTimeout(this.layoutFollowup);
    this.layoutFollowup = window.setTimeout(() => {
      this.layoutFollowup = 0;
      this.relayout("immediate");
    }, 80);
  }

  /**
   * Desktop tablet / snap: after the window has been idle, allow **one** GPU
   * resize only if portrait↔landscape flipped. Drag-resize (same aspect) never
   * reallocates — that is the Windows Chrome death path PR #28 still hit.
   */
  private armOrientSettle(): void {
    if (!this.gpuFrozen) return;
    if (this.layoutFollowup) window.clearTimeout(this.layoutFollowup);
    this.layoutFollowup = window.setTimeout(() => {
      this.layoutFollowup = 0;
      this.relayout("orient");
    }, DESKTOP_GPU_ORIENT_IDLE_MS);
  }

  /**
   * observer: viewport/RO path — coalesce; desktop frozen GPU never reallocates.
   * immediate: boot, rotate settle, forceStageSize, phase hops.
   * orient: desktop one-shot after orientationchange idle (aspect flip only).
   */
  private relayout(mode: "immediate" | "observer" | "orient" = "immediate"): void {
    if (this.layoutBusy) {
      this.layoutQueued = true;
      return;
    }
    const app = this.app;
    const host = this.host ?? app?.canvas.parentElement;
    if (!app || !host) return;

    this.layoutBusy = true;
    this.relayoutCount += 1;
    const t0 = performance.now();
    try {
      const css = this.gpuFrozen ? this.presentHostCss() : (this.forcedSize ?? visibleSize(host));
      if (this.gpuFrozen) {
        // Keep canvas CSS locked to the GPU buffer. Presentation scale follows
        // the host via transform — never width/height: 100%. Skip canvas writes
        // while the live canvas is detached for a Windows resize snapshot.
        if (!this.presentSnapshotForResize) {
          this.applyFrozenCanvasCss(app.canvas, app.screen.width, app.screen.height);
        }
        this.updatePresentationScale();
      } else {
        if (app.canvas.style.width !== "100%") app.canvas.style.width = "100%";
        if (app.canvas.style.height !== "100%") app.canvas.style.height = "100%";
        if (app.canvas.style.objectFit !== "fill") app.canvas.style.objectFit = "fill";
      }

      let w = app.screen.width;
      let h = app.screen.height;
      let wantRes = app.renderer.resolution ?? 1;

      if (this.forcedSize) {
        // Test / iPhone rotate simulation — explicit GPU resize, still pixel-capped.
        w = css.w;
        h = css.h;
        wantRes = this.gpuFrozen ? cappedResolution(w, h, 1) : cappedResolution(w, h);
      } else if (this.gpuFrozen) {
        if (mode === "observer") {
          // Letterbox the existing buffer. Do not realloc GPU or redraw slots.
          // Still swap the JPEG if the window box crossed portrait ↔ landscape.
          this.bg.setHostBox(css.w, css.h);
          return;
        }
        if (mode === "orient") {
          const next = pickFixedGpuSize(css.w, css.h, this.platformFamily);
          const gpuPortrait = isPortraitSize(app.screen.width, app.screen.height);
          const cssPortrait = isPortraitSize(css.w, css.h);
          if (gpuPortrait === cssPortrait && this.layout) {
            return;
          }
          w = next.w;
          h = next.h;
          wantRes = frozenDesktopResolution(
            w,
            h,
            this.platformFamily,
            typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
          );
        } else {
          // Boot / phase hop: layout in the frozen buffer. Never grow to CSS.
          w = app.screen.width;
          h = app.screen.height;
          wantRes = app.renderer.resolution ?? 1;
        }
      } else {
        w = css.w;
        h = css.h;
        wantRes = cappedResolution(w, h);
        if (mode === "observer") {
          if (Math.abs(app.screen.width - w) > 0.5 || Math.abs(app.screen.height - h) > 0.5) {
            if (shouldDeferGpuResize(w, h)) {
              this.armGpuSettle();
              return;
            }
            this.armGpuSettle();
          }
        }
      }

      const resNow = app.renderer.resolution ?? 1;
      const gpuDirty =
        Math.abs(app.screen.width - w) > 0.5 ||
        Math.abs(app.screen.height - h) > 0.5 ||
        Math.abs(resNow - wantRes) > 0.01;
      const layoutDirty =
        !this.layout ||
        Math.abs(this.lastLayoutW - w) > 0.5 ||
        Math.abs(this.lastLayoutH - h) > 0.5;

      if (!gpuDirty && !layoutDirty) {
        if (this.gpuFrozen) this.updatePresentationScale();
        // Still sync overlay/dust sizes — an early return used to leave
        // PhaseTransition at stale w/h (or the default 100×100), so hop
        // darkness painted a top-left rectangle instead of the full stage.
        this.transition.resize(app.screen.width, app.screen.height);
        this.dust.resize(app.screen.width, app.screen.height);
        return;
      }

      if (gpuDirty) {
        app.renderer.resize(w, h, wantRes);
        this.gpuResizeCount += 1;
      }
      app.stage.hitArea = app.screen;
      this.lastLayoutW = w;
      this.lastLayoutH = h;
      this.layout = computeLayout(app.screen.width, app.screen.height);
      this.syncBgHost(app.screen.width, app.screen.height);
      this.transition.resize(app.screen.width, app.screen.height);
      this.dust.resize(app.screen.width, app.screen.height);
      this.drawSlots();
      this.placeTray();
      this.placeOccupants();
      if (this.gpuFrozen) {
        if (!this.presentSnapshotForResize) {
          this.applyFrozenCanvasCss(app.canvas, app.screen.width, app.screen.height);
        }
        this.updatePresentationScale();
      }
    } finally {
      this.lastRelayoutMs = performance.now() - t0;
      this.maxRelayoutMs = Math.max(this.maxRelayoutMs, this.lastRelayoutMs);
      this.layoutBusy = false;
      if (this.layoutQueued) {
        this.layoutQueued = false;
        this.scheduleLayout();
      }
    }
  }

  private drawSlots(): void {
    const now = performance.now();
    const secretOn = this.secret.active;
    const snap = secretOn ? this.secret.snapshot(now) : null;
    const pulse = this.reduceMotion ? 0.32 : 0.22 + 0.18 * Math.sin(this.time * 11);

    for (const [id, g] of this.slotGfx) {
      const r = this.layout.slots[id];
      const wrap = this.slotWraps.get(id);
      const hi = this.slotHi.get(id);
      g.clear();

      const hot = !secretOn && this.hover === id;
      const isTarget = snap?.status === "playing" && snap.targets.includes(id);
      const isDecoy = snap?.status === "playing" && snap.decoy === id;
      const isLose = Boolean(snap?.loseSlots.includes(id));
      const fx = this.secret.fx;
      const isHit = Boolean(fx && fx.kind === "hit" && fx.slot === id && now < fx.until);
      const isMiss = Boolean(fx && fx.kind === "miss" && fx.slot === id && now < fx.until);
      const faceStem = snap?.faces[id] ?? null;
      const showFace = Boolean(
        secretOn && faceStem && (isTarget || isDecoy || isHit || isMiss || isLose),
      );

      let fill = 0xffffff;
      let fillA = hot ? 0.22 : 0.1;
      let stroke = hot ? 0xff3355 : 0xfff3c4;
      let strokeW = hot ? 6 : 3.2;

      if (secretOn) {
        fillA = 0.12;
        strokeW = 2.5;
        stroke = 0xfff3c4;
        fill = 0xffffff;
        if (isTarget && !isMiss && !isLose) {
          // Bright rim so active pads read green even on sunny meadow photos.
          fill = 0x2dff7a;
          fillA = 0.16;
          stroke = 0x8dffb8;
          strokeW = 4.5;
        } else if (isHit) {
          fill = 0x7dff9a;
          fillA = 0.22;
          stroke = 0xe8ffe8;
          strokeW = 5;
        } else if (isMiss || isLose) {
          fill = 0xff4466;
          fillA = 0.2;
          stroke = 0xff99aa;
          strokeW = 5;
        } else if (isDecoy) {
          stroke = 0xa8d4ff;
          strokeW = 3;
        }
      }

      g.roundRect(r.x, r.y, r.w, r.h, r.w * 0.22);
      g.fill({ color: fill, alpha: fillA });
      g.stroke({ width: strokeW, color: stroke, alpha: 0.85 });

      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const sh = this.slotShadow.get(id);
      if (sh) {
        placeSoftFalloff(sh, cx, r.y + r.h * 0.56, r.w * 0.84, r.h * 0.76);
      }
      const pool = this.slotPool.get(id);
      if (pool) {
        if (secretOn && (isTarget || isHit) && !isMiss && !isLose) {
          // Normal-blend green pool under the friend — additive alone washes out
          // on bright meadow photos. Size peeks past every chip edge.
          placeSoftFalloff(pool, cx, cy, r.w * 1.28, r.h * 1.22);
          pool.tint = 0x1fdc6a;
          pool.blendMode = "normal";
          pool.alpha = this.reduceMotion ? 0.78 : 0.58 + pulse * 0.28;
        } else if (secretOn && (isMiss || isLose)) {
          placeSoftFalloff(pool, cx, cy, r.w * 1.28, r.h * 1.22);
          pool.tint = 0xff2244;
          pool.blendMode = "normal";
          pool.alpha = 0.72;
        } else if (secretOn && isDecoy) {
          placeSoftFalloff(pool, cx, cy, r.w * 1.05, r.h * 1.0);
          pool.tint = 0x8ec8ff;
          pool.blendMode = "normal";
          pool.alpha = 0.28;
        } else {
          placeSoftFalloff(pool, cx, cy, r.w * 0.95, r.h * 0.9);
          pool.tint = 0xfff6ea;
          pool.blendMode = "normal";
          pool.alpha = hot ? 0.42 : 0.28;
        }
      }

      this.syncSecretFace(id, wrap, showFace ? faceStem : null, r, now);

      // Additive rim ABOVE the friend for a soft glow fringe.
      if (hi) {
        if (secretOn && (isTarget || isHit) && !isMiss && !isLose) {
          hi.tint = 0x66ffaa;
          hi.alpha = this.reduceMotion ? 0.7 : 0.48 + pulse * 0.42;
          hi.blendMode = "add";
          placeSoftFalloff(hi, cx, cy, r.w * 1.24, r.h * 1.18);
          wrap?.addChild(hi);
        } else if (secretOn && (isMiss || isLose)) {
          hi.tint = 0xff6688;
          hi.alpha = 0.7;
          hi.blendMode = "add";
          placeSoftFalloff(hi, cx, cy, r.w * 1.24, r.h * 1.18);
          wrap?.addChild(hi);
        } else {
          hi.alpha = 0;
        }
      }

      if (wrap) {
        const c = center(r);
        const pop = !this.reduceMotion && isHit ? 1.1 : 1;
        wrap.pivot.set(c.x, c.y);
        wrap.position.set(c.x, c.y);
        wrap.scale.set(pop);
      }

      let label = this.slotLabels.get(id);
      if (!this.occupants.has(id) && !secretOn) {
        const fontSize = Math.max(11, Math.min(14, r.w * 0.08));
        if (!label) {
          label = new Text({
            text: "DROP",
            style: {
              fill: 0xfff4d8,
              fontSize,
              fontWeight: "800",
              fontFamily: "ui-rounded, system-ui",
              letterSpacing: 1,
              dropShadow: TEXT_HALO,
            },
          });
          label.anchor.set(0.5);
          label.eventMode = "none";
          this.slotLabels.set(id, label);
          g.addChild(label);
          this.dropLabelAllocs += 1;
        } else if (label.style.fontSize !== fontSize) {
          label.style.fontSize = fontSize;
        }
        label.visible = true;
        label.position.set(r.x + r.w / 2, r.y + r.h - Math.max(14, r.h * 0.1));
      } else if (label) {
        label.visible = false;
      }
    }
  }

  private syncSecretFace(
    id: SlotId,
    wrap: Container | undefined,
    stem: StemId | null,
    r: { x: number; y: number; w: number; h: number },
    _now: number,
  ): void {
    let view = this.secretFaces.get(id);
    if (!stem || !wrap) {
      if (view) view.root.visible = false;
      return;
    }
    if (!view || view.id !== stem) {
      if (view) {
        view.root.destroy({ children: true });
        this.secretFaces.delete(id);
      }
      view = createCharacter(stem, 120, { idleRock: false, seatedGlow: false });
      view.root.eventMode = "none";
      wrap.addChild(view.root);
      this.secretFaces.set(id, view);
    }
    view.setMood(this.phase);
    view.root.visible = true;
    const c = center(r);
    view.root.position.set(c.x, c.y);
    // Slightly smaller than the pad glow so the green/red halo peeks around.
    view.root.scale.set((r.w * 0.7) / 120);
  }

  private clearSecretFaces(): void {
    for (const view of this.secretFaces.values()) {
      view.root.destroy({ children: true });
    }
    this.secretFaces.clear();
  }

  private stemInUse(stem: StemId): boolean {
    if (this.dragging?.stems.includes(stem)) return true;
    return [...this.occupants.values()].some((o) => o.stems.includes(stem));
  }

  private placeTray(): void {
    TRAY_STEMS.forEach((stem, i) => {
      const icon = this.trayIcons.get(stem)!;
      const r = this.layout.tray[i];
      // Cell `w` is the holder-plate size; park the plate in the upper cell so
      // the under-label uses the gutter in `h - w` without colliding with the next row.
      icon.root.position.set(r.x + r.w / 2, r.y + r.w / 2);
      icon.root.scale.set(r.w / 88);
      const used = this.stemInUse(stem);
      const secretOn = this.secret.active;
      icon.root.alpha = secretOn ? 0.12 : used ? 0.28 : 1;
      icon.root.eventMode = secretOn || used || this.dragging || this.seatPress ? "none" : "static";
    });
  }

  private placeOccupants(): void {
    for (const [slot, occ] of this.occupants) {
      const r = this.layout.slots[slot];
      const c = center(r);
      occ.view.root.position.set(c.x, c.y);
      // Portrait diameter is ~0.97 of size; ~0.98 pad scale → chip fills ~95%+.
      const scale = (r.w * 0.98) / 160;
      occ.view.root.scale.set(scale);
      occ.remove.position.set(r.x + r.w - 18, r.y + 18);
      const hide = this.secret.active;
      occ.view.root.visible = !hide;
      occ.view.root.eventMode = hide ? "none" : "static";
      occ.remove.visible = !hide;
      occ.remove.eventMode = hide ? "none" : "static";
    }
  }

  private capturePointer(pointerId?: number): void {
    this.activePointerId = pointerId ?? null;
    if (pointerId != null && this.app) {
      try {
        this.app.canvas.setPointerCapture(pointerId);
      } catch {
        /* Edge may reject capture mid-gesture — drag still works via stage */
      }
    }
  }

  private releasePointer(): void {
    if (this.activePointerId != null && this.app) {
      try {
        this.app.canvas.releasePointerCapture(this.activePointerId);
      } catch {
        /* ignore */
      }
    }
    this.activePointerId = null;
  }

  private beginTrayDrag(stem: StemId, x: number, y: number, pointerId?: number): void {
    if (this.scareBusy || this.secret.active) return;
    // Never stack ghosts — a new drag always tears down a stuck one first.
    if (this.dragging || this.seatPress) this.abortDrag({ restoreSeat: true });
    this.ensureAudio();
    this.cancelSeatPress();
    if (this.stemInUse(stem)) return;
    this.lastPointerX = x;
    this.lastPointerY = y;
    const ghost = this.makeGhost([stem]);
    ghost.position.set(x, y);
    this.ghostLayer.addChild(ghost);
    this.dragging = { stems: [stem], ghost, fromSlot: null };
    this.capturePointer(pointerId);
    this.hint(stem === "black" ? "Drop him on a glowing pad — the backyard turns dark." : "Snap onto a glowing stage pad");
    haptic(12);
    this.placeTray();
  }

  private onSeatPointerDown(slot: SlotId, x: number, y: number, pointerId: number): void {
    if (this.scareBusy || this.secret.active) return;
    if (this.dragging) this.abortDrag({ restoreSeat: true });
    this.ensureAudio();
    this.cancelSeatPress();
    this.lastPointerX = x;
    this.lastPointerY = y;
    const timer = window.setTimeout(() => {
      if (this.seatPress?.slot === slot) this.promoteSeatDrag(this.lastPointerX, this.lastPointerY);
    }, LONG_PRESS_MS);
    this.seatPress = { slot, x, y, pointerId, longPressTimer: timer };
    this.capturePointer(pointerId);
  }

  private cancelSeatPress(): void {
    if (this.seatPress?.longPressTimer != null) {
      window.clearTimeout(this.seatPress.longPressTimer);
    }
    this.seatPress = null;
  }

  /** Lift a seated Sprunki (or group) into a drag ghost. */
  private promoteSeatDrag(x: number, y: number): void {
    const press = this.seatPress;
    if (!press) return;
    if (this.dragging) this.abortDrag({ restoreSeat: true });
    const occ = this.occupants.get(press.slot);
    if (!occ) {
      this.cancelSeatPress();
      return;
    }
    if (press.longPressTimer != null) window.clearTimeout(press.longPressTimer);
    const stems = [...occ.stems];
    const fromSlot = press.slot;
    this.seatPress = null;
    // Lift visuals; keep stems audible until drop decides remove vs re-seat/merge.
    this.occupants.delete(fromSlot);
    occ.view.root.destroy({ children: true });
    occ.remove.destroy({ children: true });

    this.lastPointerX = x;
    this.lastPointerY = y;
    const ghost = this.makeGhost(stems);
    ghost.position.set(x, y);
    this.ghostLayer.addChild(ghost);
    this.dragging = { stems, ghost, fromSlot };
    this.hint("Drag off the pad to put them away");
    this.dragHintShown = true;
    haptic(14);
    this.placeTray();
    this.drawSlots();
  }

  private makeGhost(stems: StemId[]): Container {
    // Match the destination pad art (Phase 2+ horror / deep-horror), not Phase 1.
    const view = createPadCharacter(stems, 96);
    view.setMood(this.phase);
    view.root.alpha = 0.92;
    view.root.eventMode = "none";
    return view.root;
  }

  /**
   * Tear down any active drag/press without applying a drop.
   * Seat-originated lifts are put back on their pad so a lost gesture never
   * eats a Sprunki; tray drags simply clear the ghost.
   */
  private abortDrag(opts: { restoreSeat: boolean }): void {
    this.cancelSeatPress();
    const drag = this.dragging;
    if (!drag) {
      this.releasePointer();
      this.hover = null;
      this.placeTray();
      this.drawSlots();
      return;
    }
    const stems = [...drag.stems];
    const fromSlot = drag.fromSlot;
    try {
      drag.ghost.destroy({ children: true });
    } catch {
      /* already destroyed */
    }
    this.dragging = null;
    this.releasePointer();
    this.hover = null;
    if (opts.restoreSeat && fromSlot && !this.occupants.has(fromSlot)) {
      this.seat(stems, fromSlot);
    }
    this.placeTray();
    this.drawSlots();
  }

  private onMove(x: number, y: number, pointerId?: number): void {
    if (this.seatPress && !this.dragging) {
      if (pointerId != null && pointerId !== this.seatPress.pointerId) return;
      this.lastPointerX = x;
      this.lastPointerY = y;
      const d = dist(x, y, this.seatPress.x, this.seatPress.y);
      if (d >= DRAG_MOVE_PX) this.promoteSeatDrag(x, y);
    }
    if (!this.dragging) return;
    // Ignore stray move ids, but never leave a drag stuck for that reason on end.
    if (pointerId != null && this.activePointerId != null && pointerId !== this.activePointerId) return;
    this.lastPointerX = x;
    this.lastPointerY = y;
    const snap = this.bestSlot(x, y, HOVER_SNAP);
    if (snap) {
      const c = center(this.layout.slots[snap]);
      const pull = 0.45;
      this.dragging.ghost.position.set(x + (c.x - x) * pull, y + (c.y - y) * pull);
      this.hover = snap;
    } else {
      this.dragging.ghost.position.set(x, y);
      this.hover = null;
    }
    this.drawSlots();
  }

  /**
   * Always clears dragging — even with stale coords or mismatched pointer ids.
   * Near a pad (generous snap) → complete drop; otherwise cancel cleanly.
   */
  private endPointerGesture(x: number, y: number, _pointerId?: number): void {
    // Short tap on a seated friend: no mute/solo cycle (confuses kids).
    // Drag / long-press still lifts them for move / drag-off-to-remove.
    if (this.seatPress && !this.dragging) {
      this.cancelSeatPress();
      this.releasePointer();
      this.placeTray();
      return;
    }

    const drag = this.dragging;
    if (!drag) return;

    const stems = [...drag.stems];
    const fromSlot = drag.fromSlot;
    const px = Number.isFinite(x) ? x : this.lastPointerX;
    const py = Number.isFinite(y) ? y : this.lastPointerY;

    // Destroy ghost FIRST so a failed drop path can never leave it floating.
    try {
      drag.ghost.destroy({ children: true });
    } catch {
      /* ignore */
    }
    this.dragging = null;
    this.releasePointer();
    this.hover = null;
    this.drawSlots();

    const slot = this.bestSlot(px, py, DROP_SNAP);

    if (slot) {
      void this.drop(stems[0], slot, stems, fromSlot);
      this.placeTray();
      return;
    }

    // Not near enough: cancel cleanly.
    if (fromSlot) {
      // Seat-originated drag off-pad → put them away (Incredibox-style).
      this.removeStems(stems);
      if (!this.dragHintShown) {
        this.hint("Drag off the pad to put them away");
        this.dragHintShown = true;
      } else {
        this.hint("Friends back in the tray.");
      }
      this.watchFullMix();
    }
    // Tray-originated cancel: stem never left the tray; just restore interactivity.
    this.placeTray();
  }

  private removeStems(stems: StemId[]): void {
    for (const id of stems) this.audio.remove(id);
    if (stems.includes("black") && this.phase !== 1) {
      void this.gotoPhase(1, "reverse");
      this.hint("The dark lifts. Backyard lights flicker back on.");
    }
  }

  private bestSlot(x: number, y: number, snap = DROP_SNAP): SlotId | null {
    if (!this.layout) return null;
    let best: SlotId | null = null;
    let bestD = Infinity;
    for (const id of SLOT_IDS) {
      const r = this.layout.slots[id];
      const c = center(r);
      const d = dist(x, y, c.x, c.y);
      const reach = Math.max(r.w, r.h) * snap;
      if (d < reach && d < bestD) {
        best = id;
        bestD = d;
      }
    }
    return best;
  }

  private async drop(
    stem: StemId,
    slot: SlotId,
    stems: StemId[] = [stem],
    fromSlot: SlotId | null = null,
  ): Promise<void> {
    if (this.secret.active) return;
    this.ensureAudio();
    const incoming = [...stems];
    const existing = this.occupants.get(slot);

    // Same pad they lifted from with no other occupant change → put back.
    if (existing && fromSlot === slot) {
      this.seat(incoming, slot);
      return;
    }

    const blackIncoming = incoming.includes("black");
    const blackHere = Boolean(existing?.stems.includes("black"));

    // Mr. Black never shares a pad — exclusive replace / sit alone.
    if (existing && (blackIncoming || blackHere)) {
      this.vacate(slot, false);
      if (blackIncoming) {
        this.seat(["black"], slot);
        this.audio.place("black");
        await this.gotoPhase(2, "black");
        return;
      }
      this.seatIncoming(incoming, slot);
      return;
    }

    if (existing) {
      const other = existing.stems;
      if (incoming.some((id) => other.includes(id))) {
        if (fromSlot && !this.occupants.has(fromSlot)) this.seat(incoming, fromSlot);
        this.hint("Already on this pad.");
        this.placeTray();
        return;
      }

      const combined = [...other, ...incoming];
      const padFull = other.length >= PAD_STEM_CAP;
      const wouldOverflow = combined.length > PAD_STEM_CAP;
      if (padFull || wouldOverflow) {
        this.vacate(slot, false);
        this.seat(incoming, slot);
        this.playIncoming(incoming);
        haptic(22);
        this.hint("This pad was full — new friends take the stage!");
        this.watchFullMix();
        return;
      }

      // Two different singles that can fuse → keep the 2-friend merge art.
      if (incoming.length === 1 && other.length === 1 && canMerge(incoming[0]!, other[0]!)) {
        const a = other[0]!;
        const b = incoming[0]!;
        this.restackOccupant(slot, existing, [a, b]);
        this.audio.place(a, { chime: false });
        this.audio.place(b, { chime: true });
        haptic(28);
        this.hint(`${mergeLabel(a, b)} fused! Drag off the pad to put them away`);
        this.dragHintShown = true;
        this.watchFullMix();
        return;
      }

      // Stack: non-mergeable duo, adding a 3rd, or dropping a group onto a pad.
      this.restackOccupant(slot, existing, combined);
      this.playIncoming(incoming);
      haptic(24);
      this.hint(
        combined.length >= 3
          ? "Three friends on one pad — a backyard trio!"
          : "Two friends sharing this pad!",
      );
      this.dragHintShown = true;
      this.watchFullMix();
      return;
    }

    if (stem === "black" || blackIncoming) {
      this.seat(["black"], slot);
      this.audio.place("black");
      await this.gotoPhase(2, "black");
      return;
    }

    this.seatIncoming(incoming, slot);
  }

  private restackOccupant(slot: SlotId, existing: Occupant, nextStems: StemId[]): void {
    this.occupants.delete(slot);
    existing.view.root.destroy({ children: true });
    existing.remove.destroy({ children: true });
    this.seat(nextStems, slot);
  }

  private playIncoming(incoming: StemId[]): void {
    for (const [i, id] of incoming.entries()) {
      this.audio.place(id, { chime: i === incoming.length - 1 });
    }
  }

  private seatIncoming(incoming: StemId[], slot: SlotId): void {
    this.seat(incoming, slot);
    this.playIncoming(incoming);
    haptic(20);
    if (!this.dragHintShown) {
      this.hint("Drag off the pad to put them away");
      this.dragHintShown = true;
    } else if (this.filledPerformers() >= 3 && !this.blackSeated()) {
      this.hint("Three-piece backyard band! Drop the tall hat if you dare…");
    } else {
      this.hint("Nice. Stack more loops — or drop one Sprunki on another to merge.");
    }
    this.watchFullMix();
  }

  private seat(stems: StemId[], slot: SlotId): void {
    const r = this.layout.slots[slot];
    const view = createPadCharacter(stems, 160);
    view.setMood(this.phase);
    view.land();
    const c = center(r);
    view.root.position.set(c.x, c.y);
    view.root.eventMode = "static";
    view.root.cursor = "pointer";
    view.root.on("pointerdown", (ev) => {
      if (this.dragging || this.scareBusy || this.secret.active) return;
      ev.stopPropagation();
      this.onSeatPointerDown(slot, ev.global.x, ev.global.y, ev.pointerId);
    });

    const remove = new Container();
    const shadow = makeSoftShadowSprite(0, 3, 22, 20);
    shadow.tint = 0xe23a2a;
    shadow.alpha = 0.55;
    const g = new Graphics();
    g.circle(0, 0, 16);
    g.fill(0xe23a2a);
    g.moveTo(-6, -6);
    g.lineTo(6, 6);
    g.moveTo(6, -6);
    g.lineTo(-6, 6);
    g.stroke({ width: 3, color: 0xfff4d8 });
    remove.addChild(shadow, g);
    remove.eventMode = "static";
    remove.cursor = "pointer";
    remove.position.set(r.x + r.w - 18, r.y + 18);
    remove.on("pointerdown", (ev) => {
      ev.stopPropagation();
      if (this.secret.active) return;
      this.vacate(slot, true);
    });

    this.actorLayer.addChild(view.root, remove);
    this.occupants.set(slot, { stems, view, remove });
    this.placeTray();
    this.drawSlots();
    this.placeOccupants();
  }

  private vacate(slot: SlotId, fromUser: boolean): void {
    const occ = this.occupants.get(slot);
    if (!occ) return;
    this.occupants.delete(slot);
    occ.view.root.destroy({ children: true });
    occ.remove.destroy({ children: true });
    for (const id of occ.stems) this.audio.remove(id);
    if (occ.stems.includes("black") && fromUser && this.phase !== 1) {
      this.audio.whoosh(true);
      this.applyPhase(1, false);
      this.hint("The dark lifts. Backyard lights flicker back on.");
    } else if (fromUser && occ.stems.length > 1) {
      this.hint("Friends back in the tray.");
    }
    this.placeTray();
    this.drawSlots();
    this.watchFullMix();
  }

  private filledPerformers(): number {
    return SLOT_IDS.filter((id) => this.occupants.has(id)).length;
  }

  private blackSeated(): boolean {
    return [...this.occupants.values()].some((o) => o.stems.includes("black"));
  }

  /**
   * Seat Mr. Black when a horror skip/jump needs him on stage.
   * Kid-friendly rule: prefer the center (mid) pad, then left/right, then tl/tr.
   * If all five pads are full, replace mid — that friend goes back to the tray.
   */
  private autoSeatBlack(): void {
    if (this.blackSeated()) return;
    const prefer: SlotId[] = ["mid", "left", "right", "tl", "tr"];
    const slot = prefer.find((id) => !this.occupants.has(id)) ?? "mid";
    if (this.occupants.has(slot)) this.vacate(slot, false);
    this.seat(["black"], slot);
  }

  private watchFullMix(): void {
    const full = this.filledPerformers() === SLOT_IDS.length && this.blackSeated();
    this.fullMixAt = full ? performance.now() : null;
  }

  private async gotoPhase(next: Phase, why: "black" | "skip" | "auto" | "reverse"): Promise<void> {
    if (this.scareBusy || next === this.phase || this.secret.active) return;
    const from = this.phase;
    this.scareBusy = true;

    // Re-measure before picking portrait/landscape art so a phase hop after
    // rotate never cover-fits against the previous viewport.
    this.relayout();

    // Prepare destination photo under the current one — revealed BY the transition.
    await this.bg.preparePhase(next);

    let scareCommitted = false;
    const commitScareVisuals = (): void => {
      if (scareCommitted) return;
      scareCommitted = true;
      this.phase = next;
      document.body.dataset.phase = String(next);
      this.phaseEl.textContent = next.toLocaleString();
      this.audio.setPhase(next);
      this.dust.setPhase(next);
      for (const occ of this.occupants.values()) occ.view.setMood(next);
      for (const icon of this.trayIcons.values()) icon.setMood(next);
      this.skipEl.hidden = this.secret.active || next === 1 ? true : !this.blackSeated();
      this.skipEl.querySelectorAll<HTMLButtonElement>("button[data-phase]").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.dataset.phase) === next);
      });
      this.drawSlots();
      haptic(why === "reverse" ? [40, 30, 60] : [80, 40, 220, 30, 90]);
      if (next === 100000 || why === "skip") this.flashPhase(next);
    };

    // Letterbox bars use #stage-fill; hide it for the hop so FX/black wash
    // cannot leave bright art strips around the canvas.
    this.bg.setFillVisible(false);
    try {
      const appLive = this.app;
      if (appLive) {
        this.transition.resize(appLive.screen.width, appLive.screen.height);
      }
      await this.transition.play(from, next, {
        onRevealProgress: (t) => this.bg.setRevealProgress(t),
        onScareBeat: () => commitScareVisuals(),
        onShake: (x, y) => {
          this.world.x = x;
          this.world.y = y;
        },
        onAudio: (recipe: TransitionRecipeId, compressed, reverse) => {
          this.audio.phaseTransitionCue(recipe, { compressed, reverse });
        },
      });
    } finally {
      this.bg.setFillVisible(true);
    }

    this.bg.finishReveal(next);
    // Orientation may have changed mid-transition — refit to the live stage.
    this.relayout();
    this.world.x = 0;
    this.world.y = 0;

    if (next >= 2 && !this.blackSeated()) {
      this.autoSeatBlack();
    }
    if (this.blackSeated() && next !== 1) this.audio.place("black", { chime: false });

    // Ensure scare visuals landed even if the transition was tiny.
    commitScareVisuals();
    this.skipEl.hidden = this.secret.active || !this.blackSeated() || next === 1;

    if (why !== "reverse") {
      if (!this.faceScareDone) this.faceScareDone = next === 1 ? false : this.faceScareDone;
    }
    if (next === 1) this.faceScareDone = false;

    this.scareBusy = false;
    this.dust.pause(false);
    if (!this.secret.active) this.dust.setDim(1);
    this.dust.setPhase(next);

    if (why === "reverse") return;
    if (next === 2) this.hint("Horror jam. Skip the dial if you dare.");
    else if (next === 3) this.hint("Nightmare. Smash RESET anytime.");
    else if (next === 100000) this.hint("GLITCH CARNIVAL. Too many eyes.");
    else this.hint(`Phase ${next.toLocaleString()}. The mix mutates.`);
  }

  /** Boot / non-cinematic phase commit (no overlay). */
  private applyPhase(phase: Phase, afterScare: boolean): void {
    this.phase = phase;
    document.body.dataset.phase = String(phase);
    this.phaseEl.textContent = phase.toLocaleString();
    this.bg.setPhase(phase);
    this.dust.setPhase(phase);
    this.audio.setPhase(phase);
    this.skipEl.hidden = this.secret.active || !this.blackSeated();
    this.skipEl.querySelectorAll<HTMLButtonElement>("button[data-phase]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.phase) === phase);
    });
    for (const occ of this.occupants.values()) occ.view.setMood(phase);
    for (const icon of this.trayIcons.values()) icon.setMood(phase);
    if (!afterScare) this.faceScareDone = phase === 1 ? false : this.faceScareDone;
    if (phase === 1) this.faceScareDone = false;
    this.drawSlots();
  }

  private flashPhase(phase: Phase): void {
    this.phaseEl.style.transform = "scale(1.35)";
    this.phaseEl.textContent = phase.toLocaleString();
    setTimeout(() => {
      this.phaseEl.style.transform = "";
    }, 400);
  }

  private hint(text: string): void {
    if (this.secret.active) return;
    this.hintEl.textContent = text;
    this.hintEl.classList.remove("gone");
    window.setTimeout(() => this.hintEl.classList.add("gone"), 2800);
  }

  private startSecret(): void {
    if (this.scareBusy) return;
    if (document.body.dataset.ready !== "1") return;
    this.cancelSeatPress();
    this.abortDrag({ restoreSeat: true });
    this.ensureAudio();
    this.audio.silence(true);
    this.secret.start();
    document.body.dataset.secret = "run";
    this.skipEl.hidden = true;
    if (this.secretExitBtn) this.secretExitBtn.hidden = false;
    if (this.secretScoreboard) this.secretScoreboard.hidden = false;
    if (this.secretOverEl) this.secretOverEl.hidden = true;
    this.placeOccupants();
    this.placeTray();
    this.syncSecretHud();
    this.dust.setDim(0.38);
    this.drawSlots();
    haptic(12);
  }

  private exitSecret(opts: { restoreJam: boolean }): void {
    if (!this.secret.active && !document.body.dataset.secret) {
      this.hideSecretChrome();
      return;
    }
    this.secret.abort();
    delete document.body.dataset.secret;
    this.hideSecretChrome();
    this.clearSecretFaces();
    this.dust.setDim(1);
    if (!opts.restoreJam) return;
    this.audio.silence(false);
    this.audio.restoreMixGain();
    this.skipEl.hidden = !this.blackSeated() || this.phase === 1;
    for (const wrap of this.slotWraps.values()) {
      wrap.scale.set(1);
    }
    this.placeOccupants();
    this.placeTray();
    this.drawSlots();
  }

  private hideSecretChrome(): void {
    if (this.secretExitBtn) this.secretExitBtn.hidden = true;
    if (this.secretScoreboard) this.secretScoreboard.hidden = true;
    if (this.secretOverEl) this.secretOverEl.hidden = true;
  }

  private showSecretOver(): void {
    document.body.dataset.secret = "over";
    this.secret.prompt = null;
    if (this.secretScoreboard) this.secretScoreboard.hidden = false;
    if (this.secretOverEl) this.secretOverEl.hidden = false;
    if (this.secretOverScore) this.secretOverScore.textContent = String(this.secret.score);
    if (this.secretOverHigh) this.secretOverHigh.textContent = String(this.secret.highScore);
    if (this.secretExitBtn) this.secretExitBtn.hidden = false;
    this.syncSecretHud();
    this.drawSlots();
  }

  private syncSecretHud(): void {
    const snap = this.secret.snapshot();
    if (this.secretScoreEl) this.secretScoreEl.textContent = String(snap.score);
    if (this.secretLivesEl) {
      const dots = this.secretLivesEl.querySelectorAll("span");
      dots.forEach((el, i) => {
        el.classList.toggle("is-lost", i >= snap.lives);
      });
      this.secretLivesEl.setAttribute("aria-label", `${snap.lives} ${snap.lives === 1 ? "try" : "tries"} left`);
    }
  }

  private onSecretPointer(x: number, y: number): void {
    if (this.secret.status !== "playing") return;
    const slot = this.bestSlot(x, y, 0.78);
    if (!slot) return;
    const result = this.secret.tap(slot);
    this.onSecretTapResult(result, slot);
  }

  private onSecretTapResult(result: SecretTapResult, slot: SlotId): void {
    if (result === "ignore") return;
    if (result === "hit" || result === "clear") {
      this.audio.playSecretHit(slot, this.secret.streak);
      if (result === "clear") this.audio.playSecretClear(this.secret.lastCleared);
      haptic(14);
    } else {
      this.audio.playSecretMiss();
      haptic(24);
    }
    this.syncSecretHud();
    this.drawSlots();
    if (this.secret.status === "over") this.showSecretOver();
  }

  private tickPadShadows(dt: number): void {
    const k = 1 - Math.exp(-Math.max(0.001, dt) * 7);
    for (const id of SLOT_IDS) {
      const sh = this.slotShadow.get(id);
      if (!sh) continue;
    const want = this.hover === id ? 0.52 : this.occupants.has(id) ? 0.4 : 0.32;
      sh.alpha += (want - sh.alpha) * k;
    }
  }

  private tick(dt: number): void {
    this.time += dt;
    this.tickPadShadows(dt);
    this.dust.tick(dt);
    if (this.secret.active) {
      const now = performance.now();
      const step = this.secret.tick(now);
      if (step.timedOut) {
        this.audio.playSecretMiss();
        haptic(18);
        this.syncSecretHud();
        if (this.secret.status === "over") this.showSecretOver();
      } else if (step.spawned || step.dirty) {
        this.syncSecretHud();
      }
      this.drawSlots();
      this.bg.tick(this.time);
      this.transition.tick(dt);
      for (const view of this.secretFaces.values()) {
        if (view.root.visible) view.tick(this.time, 0.1);
      }
      return;
    }
    const pulse = this.audio.pulse;
    this.bg.tick(this.time);
    this.transition.tick(dt);
    for (const occ of this.occupants.values()) {
      const intensity = Math.max(...occ.stems.map((id) => pulse.intensity[id] ?? 0));
      occ.view.tick(this.time, intensity);
    }
    for (const [stem, icon] of this.trayIcons) {
      const used = this.stemInUse(stem);
      // Rock the art plate only — label stays upright and avoids rotation blur.
      icon.rocker.rotation = used ? 0 : idleRockAngle(this.time, stem);
      icon.view.tick(this.time, used ? 0 : 0.12);
    }
    if (this.phase === 1 && this.blackSeated() && !this.scareBusy) {
      void this.gotoPhase(2, "black");
    }
    if (
      this.phase === 2 &&
      this.fullMixAt &&
      !this.faceScareDone &&
      !this.scareBusy &&
      performance.now() - this.fullMixAt > 16000
    ) {
      this.faceScareDone = true;
      void this.gotoPhase(3, "auto");
    }
    // Idle glitch sway only when not mid-cinematic shake.
    if (!this.transition.busy) {
      if (this.phase >= 100000 && this.app) {
        this.world.x = Math.sin(this.time * 28) * 3;
        this.world.y = Math.cos(this.time * 22) * 2;
      } else if (!this.scareBusy) {
        this.world.x = 0;
        this.world.y = 0;
      }
    }
  }
}
