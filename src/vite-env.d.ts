/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __JAM_BUILD_VERSION__: string;

interface Window {
  __jamHeroRing?: string;
  __jamHeroDark?: string;
}

declare module "pixi.js/browser";

interface Window {
  /** Tiny hook for Playwright smoke tests (cold-load → TAP TO JAM → audio). */
  __sprunkiJamTest?: {
    audioState: () => AudioContextState | null;
    isReady: () => boolean;
    /** Title-screen JPEG warmup (Phase 1 first, then the rest). */
    warmupProgress?: () => { done: number; total: number; percent: number; complete: boolean };
    /** Seat a stem via the same path as a pad drop (tests place + unlock kick). */
    placeStem?: (stem: string, slot?: string) => void;
    /** Occupant stems on a slot (merge/stack-aware). */
    slotStems?: (slot: string) => string[] | null;
    /** CharacterView.stems on a slot (trio fan must list 3, not a 2-fuse). */
    occupantViewStems?: (slot: string) => string[] | null;
    /** Seated idle-rock radians (one per visible friend) + friend-colored glow alpha. */
    occupantLook?: (slot: string) => { rocks: number[]; glow: number } | null;
    isDragging?: () => boolean;
    trayInteractive?: (stem: string) => boolean;
    /** beginTrayDrag → near-miss move → cancel; must not leave a stuck ghost. */
    beginDragThenCancel?: (stem: string) => void;
    /** Lift a seated group and drop off every pad (returns all to the tray). */
    dragSeatOffPad?: (slot: string) => void;
    titleBedPlaying?: () => boolean;
    /** Configured tray/stage portrait path. Pass true for Phase 2 horror, or a phase number. */
    portraitUrl?: (stem: string, horrorOrPhase?: boolean | number) => string | null;
    /** Cover frame for tray/stage chips. Pass true for Phase 2 horror, or a phase number. */
    portraitFrame?: (
      stem: string,
      horrorOrPhase?: boolean | number,
    ) => { scale: number; offsetX: number; offsetY: number };
    /** True when a dedicated Phase 2 / 3 horror JPEG is wired for the stem. */
    hasHorrorPortrait?: (stem: string) => boolean;
    /** True when a dedicated Phase 10+ deep-horror JPEG is wired for the stem. */
    hasDeepHorrorPortrait?: (stem: string) => boolean;
    /** Detected title-guide platform id (e.g. ios-safari, ios-edge). */
    detectedPlatform?: () => string;
    /** Live stage pad ids (five DROP pads — no portal). */
    slotIds?: () => string[];
    /** Empty-pad labels drawn on the stage (DROP, never MR. BLACK). */
    padLabels?: () => string[];
    /** Title-gate sound guide: calm, post-gesture nudge, or blocked-audio emphasis. */
    soundGuideMode?: () => "calm" | "nudge" | "blocked";
    /** Mix duck gain (1 = full). Used to guard the iOS stacked-hop silence bug. */
    mixGain?: () => number;
    /** Seated stem is audible in the mix (guards against mute/solo-on-tap). */
    isAudible?: (stem: string) => boolean;
    /** Stage pad center in canvas coords. */
    slotCenter?: (slot: string) => { x: number; y: number } | null;
    /** Snap mix duck to near-silent (stuck-cue simulation). */
    silenceMix?: (on: boolean) => void;
    /** Fire a phase-hop duck cue without the cinematic overlay. */
    phaseTransitionCue?: (kind?: "cosmic-to-vortex" | "reverse-unwind") => void;
    /** Apply a phase (also restores mix gain). */
    setPhase?: (phase: number) => void;
    /** Cinematic phase hop (prepare → transition → finishReveal). */
    gotoPhase?: (phase: number) => Promise<void>;
    /** Cinematic overlay: busy while playing, visible only during the hop. */
    transitionState?: () => { busy: boolean; visible: boolean };
    /** Cinematic bloom budget (WebGL overlay Filter). */
    transitionFx?: () => { budget: string; bloom: boolean; paused: boolean };
    /** Ambient dust motes (capped by renderer). */
    dustState?: () => {
      count: number;
      live: number;
      dim: number;
      paused: boolean;
      phase: number;
      visible: boolean;
      particleChildren: number;
      w: number;
      h: number;
      updates?: number;
    };
    /** Pin cinematic progress for screenshots (null resumes). */
    freezeTransition?: (u: number | null) => void;
    /** Visible phase photo cover-fit vs stage (rotate + phase regression guard). */
    bgCoverage?: () => {
      stageW: number;
      stageH: number;
      hostW: number;
      hostH: number;
      orient: "portrait" | "landscape";
      src: string;
      spriteW: number;
      spriteH: number;
      covers: boolean;
      set: number;
      pivotX: number;
      pivotY: number;
      objectPosition: string;
      /** Giant Pixi phase numeral on the photo (must stay false). */
      phaseNumeral: boolean;
      /** Translucent Graphics bench/board on the photo (must stay false). */
      benchOverlay: boolean;
    };
    /** Title hero src + fit from the window box (not screen.orientation). */
    titleArt?: () => {
      orient: "portrait" | "landscape" | "";
      ringSrc: string;
      darkSrc: string;
      ringFit: string;
      darkFit: string;
      ringPos: string;
      darkPos: string;
      gateW: number;
      gateH: number;
      innerW: number;
      innerH: number;
    };
    /** Simulate orientation/viewport resize through the live relayout path. */
    forceStageSize?: (w: number, h: number) => void;
    /** Arm desktop snapshot teardown without a material host-size change. */
    forcePresentSnapshot?: () => void;
    /** Viewport / GPU resize counters (Windows maximize freeze guard). */
    layoutProbe?: () => {
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
      rendererName: string;
      presentMode: "webgl";
      webglContext: boolean;
      presentFreeze: boolean;
      devicePixelRatio: number;
      dustLive: number;
      dustCount: number;
      dustDim: number;
      dustPaused: boolean;
      dustPhase: number;
      dustVisible: boolean;
      snapshotUrlCount: number;
      filterResizeCount: number;
      dustUpdates: number;
    };
    /** Fullscreen kick guard (false on desktop/laptop; true on phones/tablets). */
    shouldKickFullscreen?: (hints?: {
      uaDataMobile?: boolean | null;
      maxTouchPoints?: number;
      pointerCoarse?: boolean;
      pointerFine?: boolean;
      hoverNone?: boolean;
      hoverHover?: boolean;
      shortSide?: number;
      ua?: string;
      platform?: string;
    }) => boolean;
    /** Invoke the TAP TO JAM fullscreen helper (no-ops on desktop/laptop). */
    kickFullscreen?: () => boolean;
    /** Snap mix duck to 1. */
    restoreMixGain?: () => void;
    /** Live Pixi object counts (Windows RAM-leak regression guard). */
    sceneStats?: () => {
      displayObjects: number;
      graphics: number;
      texts: number;
      graphicsInstructions: number;
      padLabels: number;
      slotChildren: number;
      dropLabelAllocs: number;
    };
    /** Hover-restyle pads many times without allocating new DROP Text. */
    pumpDrawSlots?: (times: number) => void;
    /** Repeat relayout (same size must not grow the scene graph). */
    pumpRelayout?: (times: number) => void;
    /** Silent HTMLAudio keep-alive is currently playing (iOS session lock). */
    keepAlivePlaying?: () => boolean;
    /** Pause the keep-alive without touching AudioContext (iOS zombie-running). */
    pauseKeepAlive?: () => void;
    /** Suspend the jam AudioContext (background / interrupt simulation). */
    suspendAudio?: () => Promise<void>;
    /** Suspend the title-bed AudioContext if it exists. */
    suspendTitleBed?: () => Promise<void>;
    /** Secret reflex mode (in-jam HUD). */
    secretState?: () => {
      status: "idle" | "playing" | "over";
      score: number;
      lives: number;
      streak: number;
      highScore: number;
      target: string | null;
      targets: string[];
      decoy: string | null;
      windowMs: number;
      elapsedMs: number;
    };
    startSecret?: () => void;
    exitSecret?: () => void;
    secretSpawn?: (slots: string | string[], windowMs?: number) => void;
    secretTap?: (slot: string) => "hit" | "clear" | "miss" | "ignore";
    secretFaces?: () => Partial<Record<string, string>>;
    secretPadLook?: () => Record<
      string,
      { stem: string | null; glow: "green" | "red" | "none" }
    >;
    secretEnd?: () => void;
    secretCurve?: (elapsedMs: number) => {
      windowMs: number;
      padSlackMs: number;
      gapMs: number;
      decoyChance: number;
      targetCount: number;
    };
    /** Title/gate (or post-Reset) is a safe moment to apply a PWA reload. */
    pwaSafeToReload?: () => boolean;
    pwaReloadPending?: () => boolean;
    pwaRequestReload?: () => void;
    bindPwaUpdateChecks?: (
      check: () => void,
      options?: { intervalMs?: number; debounceMs?: number },
    ) => { dispose: () => void; checkNow: () => void };
    pwaBuildVersion?: () => string;
    pwaVersionChanged?: (local: string, remote: string | null) => boolean;
  };
}
