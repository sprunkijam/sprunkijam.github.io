/**
 * Detect the browser / OS and fill the title sound + full-screen guides so the
 * matching platform’s steps are always visible; other platforms sit in
 * “Other devices”. Edge-on-iPhone is the primary product target when the UA
 * looks like iPhone + EdgiOS/Edg.
 */

import { artUrl } from "../publicUrl";

export type PlatformId =
  | "ios-edge"
  | "ios-safari"
  | "ios-chrome"
  | "ios-firefox"
  | "ios-other"
  | "android"
  | "mac"
  | "windows"
  | "other";

export type PlatformFamily = "ios" | "android" | "mac" | "windows" | "other";

export interface DetectedPlatform {
  id: PlatformId;
  family: PlatformFamily;
  /** Short label for diagnostics, e.g. "iPhone · Edge". */
  label: string;
}

const TAP_MUSIC_NOTE = "Tap anywhere on this screen to turn the music on.";

/** Exported for Playwright / smoke hooks. */
export function detectPlatform(
  ua = typeof navigator !== "undefined" ? navigator.userAgent : "",
  opts?: { maxTouchPoints?: number; platform?: string },
): DetectedPlatform {
  const u = (ua || "").toLowerCase();
  const maxTouch =
    opts?.maxTouchPoints ??
    (typeof navigator !== "undefined" ? navigator.maxTouchPoints || 0 : 0);
  const navPlatform =
    opts?.platform ?? (typeof navigator !== "undefined" ? navigator.platform || "" : "");

  // iPadOS 13+ desktop-class Safari reports as MacIntel with touch.
  const iPadDesktop = navPlatform === "MacIntel" && maxTouch > 1;
  const isIos = /iphone|ipad|ipod/.test(u) || iPadDesktop;
  const isAndroid = /android/.test(u);
  const isMac = !isIos && /mac os x|macintosh/.test(u);
  const isWindows = /windows/.test(u);

  const isEdge = /edgios|edg\//.test(u);
  const isFirefox = /fxios|firefox\//.test(u);
  const isChrome = (/crios|chrome\//.test(u) || /chromium\//.test(u)) && !isEdge && !isFirefox;
  const isWebView = /\bwv\b/.test(u) || /; wv\)/.test(u);

  if (isIos) {
    if (isEdge) return { id: "ios-edge", family: "ios", label: "iPhone · Edge" };
    if (isChrome) return { id: "ios-chrome", family: "ios", label: "iPhone · Chrome" };
    if (isFirefox) return { id: "ios-firefox", family: "ios", label: "iPhone · Firefox" };
    if (/safari/.test(u) || iPadDesktop) {
      return { id: "ios-safari", family: "ios", label: "iPhone · Safari" };
    }
    return { id: "ios-other", family: "ios", label: "iPhone" };
  }

  if (isAndroid) {
    if (isEdge) return { id: "android", family: "android", label: "Android · Edge" };
    if (isFirefox) return { id: "android", family: "android", label: "Android · Firefox" };
    if (isWebView) return { id: "android", family: "android", label: "Android" };
    if (isChrome) return { id: "android", family: "android", label: "Android · Chrome" };
    return { id: "android", family: "android", label: "Android" };
  }

  if (isMac) {
    if (isEdge) return { id: "mac", family: "mac", label: "Mac · Edge" };
    if (isChrome) return { id: "mac", family: "mac", label: "Mac · Chrome" };
    if (isFirefox) return { id: "mac", family: "mac", label: "Mac · Firefox" };
    return { id: "mac", family: "mac", label: "Mac · Safari" };
  }

  if (isWindows) {
    if (isEdge) return { id: "windows", family: "windows", label: "Windows · Edge" };
    if (isChrome) return { id: "windows", family: "windows", label: "Windows · Chrome" };
    if (isFirefox) return { id: "windows", family: "windows", label: "Windows · Firefox" };
    return { id: "windows", family: "windows", label: "Windows" };
  }

  return { id: "other", family: "other", label: "Sound tips" };
}

type GuideBlock = { title: string; html: string; otherLine: string };

function iosSilentPrimaryHtml(): string {
  return `
    <ul class="sound-guide-steps">
      <li class="sound-guide-step">
        <span class="sound-guide-icons" aria-hidden="true">
          <img src="${artUrl("icon-iphone-silent.svg")}" alt="" width="56" height="56" decoding="async" />
          <span class="sound-guide-arrow">→</span>
          <img src="${artUrl("icon-iphone-sound.svg")}" alt="" width="56" height="56" decoding="async" />
        </span>
        <span class="sound-guide-text">
          Silent OFF — older: hide orange on the side switch. Newer: Action button, Control Center, or Settings.
        </span>
      </li>
      <li class="sound-guide-step">
        <img src="${artUrl("icon-volume-up.svg")}" alt="" width="56" height="56" decoding="async" />
        <span class="sound-guide-text">Then Volume up.</span>
      </li>
      <li class="sound-guide-step sound-guide-tap">
        <span class="sound-guide-text">${TAP_MUSIC_NOTE}</span>
      </li>
    </ul>`;
}

function simpleSoundPrimaryHtml(lines: string[]): string {
  const items = lines
    .map((line) => `<li class="sound-guide-step"><span class="sound-guide-text">${line}</span></li>`)
    .join("");
  return `<ul class="sound-guide-steps">${items}
    <li class="sound-guide-step sound-guide-tap">
      <span class="sound-guide-text">${TAP_MUSIC_NOTE}</span>
    </li>
  </ul>`;
}

function soundCatalog(): Record<"ios" | "android" | "windows" | "mac", GuideBlock> {
  return {
    ios: {
      title: "iPhone / iPad",
      html: iosSilentPrimaryHtml(),
      otherLine:
        "Silent OFF (side switch, Action button, Control Center, or Settings), then Volume up. Tap the screen to turn music on.",
    },
    android: {
      title: "Android",
      html: simpleSoundPrimaryHtml([
        "Volume up for <strong>Media</strong> while the jam plays.",
        "If still quiet, turn off Silent / Do Not Disturb.",
      ]),
      otherLine:
        "Volume up for Media. If still quiet, turn off Silent / Do Not Disturb. Tap the screen to turn music on.",
    },
    windows: {
      title: "Windows",
      html: simpleSoundPrimaryHtml([
        "Taskbar speaker → unmute.",
        "Volume Mixer → unmute the browser if needed.",
      ]),
      otherLine:
        "Taskbar speaker → unmute. Volume Mixer → unmute the browser if needed. Tap the page to turn music on.",
    },
    mac: {
      title: "Mac",
      html: simpleSoundPrimaryHtml([
        "Volume up / unmute.",
        "If the tab shows a mute icon, unmute the tab.",
      ]),
      otherLine:
        "Volume up / unmute. If the tab shows a mute icon, unmute the tab. Tap the page to turn music on.",
    },
  };
}

function playCatalog(): Record<string, GuideBlock> {
  return {
    "ios-edge": {
      title: "iPhone / iPad · Edge",
      html: `<p class="play-guide-body"><strong>iPhone / iPad · Edge:</strong> three dots → Share → scroll to the bottom → Add to Home Screen. Then open the new Home Screen icon.</p>`,
      otherLine:
        "three dots → Share → scroll to the bottom → Add to Home Screen. Then open the new Home Screen icon.",
    },
    "ios-safari": {
      title: "iPhone / iPad · Safari",
      html: `<p class="play-guide-body"><strong>Safari:</strong> Share (square with the up arrow) → Add to Home Screen. Old iPads often use Safari.</p>`,
      otherLine:
        "Share (square with the up arrow) → Add to Home Screen. Old iPads often use Safari.",
    },
    "ios-chrome": {
      title: "iPhone / iPad · Chrome",
      html: `<p class="play-guide-body"><strong>Chrome:</strong> Share → Add to Home Screen (or open in Safari, then Share → Add to Home Screen).</p>`,
      otherLine:
        "Share → Add to Home Screen (or open in Safari, then Share → Add to Home Screen).",
    },
    "ios-firefox": {
      title: "iPhone / iPad · Firefox",
      html: `<p class="play-guide-body"><strong>Firefox:</strong> menu → Share → Add to Home Screen (or open in Safari for Add to Home Screen).</p>`,
      otherLine:
        "menu → Share → Add to Home Screen (or open in Safari for Add to Home Screen).",
    },
    android: {
      title: "Android",
      html: `<p class="play-guide-body"><strong>Android:</strong> Chrome or Edge → three dots → Add to Home screen or Install app → open the icon.</p>`,
      otherLine:
        "Chrome or Edge → three dots → Add to Home screen or Install app → open the icon.",
    },
    windows: {
      title: "Windows",
      html: `<p class="play-guide-body"><strong>Windows:</strong> Optional — Edge → three dots → Apps → Install this site as an app (or the install icon in the address bar). Chrome → three dots → Cast, save and share → Install page as app. Then open that app. The jam stays in a normal window and will not jump to fullscreen by itself.</p>`,
      otherLine:
        "Optional: Edge → Apps → Install this site as an app. Chrome → Install page as app. The jam does not force fullscreen.",
    },
    mac: {
      title: "Mac",
      html: `<p class="play-guide-body"><strong>Mac:</strong> Safari (Sonoma+) File → Add to Dock, or Share → Add to Dock. Chrome / Edge → install icon in the address bar, or three dots → Install this site as an app / Install page as app. Open from the Dock.</p>`,
      otherLine:
        "Safari Add to Dock, or Chrome / Edge install as an app. Open from the Dock.",
    },
  };
}

function soundLeadFor(family: PlatformFamily): string {
  if (family === "ios") return "iPhone sound";
  if (family === "android") return "Android sound";
  if (family === "windows") return "Windows sound";
  if (family === "mac") return "Mac sound";
  return "Sound tips";
}

function playLeadFor(platform: DetectedPlatform): string {
  // Windows: optional install tip only — the jam must not imply it will force fullscreen.
  if (platform.family === "windows") return "Optional: install as an app";
  return "Best played in full screen";
}

function helpSummaryFor(platform: DetectedPlatform): string {
  if (platform.family === "windows") return "Sound & install help";
  return "Sound & full screen help";
}

function soundSelection(platform: DetectedPlatform): { primary: GuideBlock; others: GuideBlock[] } {
  const cat = soundCatalog();
  if (platform.family === "ios") {
    return { primary: { ...cat.ios, title: platform.label }, others: [cat.android, cat.windows, cat.mac] };
  }
  if (platform.family === "android") {
    return { primary: { ...cat.android, title: platform.label }, others: [cat.ios, cat.windows, cat.mac] };
  }
  if (platform.family === "windows") {
    return { primary: { ...cat.windows, title: platform.label }, others: [cat.ios, cat.android, cat.mac] };
  }
  if (platform.family === "mac") {
    return { primary: { ...cat.mac, title: platform.label }, others: [cat.ios, cat.android, cat.windows] };
  }
  // Unknown — keep iPhone (product primary) prominent.
  return { primary: { ...cat.ios, title: "iPhone · Edge" }, others: [cat.android, cat.windows, cat.mac] };
}

function playSelection(platform: DetectedPlatform): { primary: GuideBlock; others: GuideBlock[] } {
  const cat = playCatalog();
  const iosKeys = ["ios-edge", "ios-safari", "ios-chrome", "ios-firefox"] as const;

  if (platform.id === "ios-edge") {
    return {
      primary: cat["ios-edge"],
      others: [cat["ios-safari"], cat["ios-chrome"], cat.android, cat.windows, cat.mac],
    };
  }
  if (platform.id === "ios-safari" || platform.id === "ios-other") {
    return {
      primary: cat["ios-safari"],
      others: [cat["ios-edge"], cat["ios-chrome"], cat.android, cat.windows, cat.mac],
    };
  }
  if (platform.id === "ios-chrome") {
    return {
      primary: cat["ios-chrome"],
      others: [cat["ios-edge"], cat["ios-safari"], cat.android, cat.windows, cat.mac],
    };
  }
  if (platform.id === "ios-firefox") {
    return {
      primary: cat["ios-firefox"],
      others: [cat["ios-edge"], cat["ios-safari"], cat.android, cat.windows, cat.mac],
    };
  }
  if (platform.family === "android") {
    return {
      primary: cat.android,
      others: [cat["ios-edge"], cat["ios-safari"], cat.windows, cat.mac],
    };
  }
  if (platform.family === "windows") {
    return {
      primary: cat.windows,
      others: [cat["ios-edge"], cat["ios-safari"], cat.android, cat.mac],
    };
  }
  if (platform.family === "mac") {
    return {
      primary: cat.mac,
      others: [cat["ios-edge"], cat["ios-safari"], cat.android, cat.windows],
    };
  }
  void iosKeys;
  // Default unknown → Edge-on-iPhone primary.
  return {
    primary: cat["ios-edge"],
    others: [cat["ios-safari"], cat.android, cat.windows, cat.mac],
  };
}

function fillOtherList(ul: HTMLElement, blocks: GuideBlock[]): void {
  ul.replaceChildren();
  for (const block of blocks) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${block.title}:</strong> ${block.otherLine}`;
    ul.appendChild(li);
  }
}

/**
 * Fill `#sound-guide` and `#play-guide` for the current UA.
 * Safe to call once at boot; returns the detected platform.
 */
export function applyPlatformGuides(ua?: string): DetectedPlatform {
  const platform = detectPlatform(ua);
  const sound = soundSelection(platform);
  const play = playSelection(platform);

  const soundGuide = document.getElementById("sound-guide");
  const soundLead = document.getElementById("sound-guide-lead");
  const soundPrimary = document.getElementById("sound-guide-primary");
  const soundOtherList = document.getElementById("sound-guide-other-list");

  if (soundLead) soundLead.textContent = soundLeadFor(platform.family);
  if (soundPrimary) soundPrimary.innerHTML = sound.primary.html;
  if (soundOtherList) fillOtherList(soundOtherList, sound.others);
  if (soundGuide) soundGuide.dataset.platform = platform.id;

  const playGuide = document.getElementById("play-guide");
  const playLead = document.getElementById("play-guide-lead");
  const playPrimary = document.getElementById("play-guide-primary");
  const playOtherList = document.getElementById("play-guide-other-list");

  if (playLead) playLead.textContent = playLeadFor(platform);
  if (playPrimary) playPrimary.innerHTML = play.primary.html;
  if (playOtherList) fillOtherList(playOtherList, play.others);
  if (playGuide) playGuide.dataset.platform = platform.id;

  const helpSummary = document.getElementById("gate-help-summary");
  if (helpSummary) helpSummary.textContent = helpSummaryFor(platform);

  return platform;
}

export function tapMusicNoteText(): string {
  return TAP_MUSIC_NOTE;
}
