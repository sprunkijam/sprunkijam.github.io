/**
 * One revocable snapshot URL for desktop resize storms.
 * Detach the live WebGL canvas first, then show this still. Recapturing the
 * frozen buffer on remount is how idle RAM used to climb — keep one JPEG, idle only.
 */

export const SNAPSHOT_JPEG_QUALITY = 0.72;

/**
 * Frozen desktop keeps GC on so leaked RTs cannot sit immortal, but the
 * default ~600-frame / 10s scan used to unload and recreate large sources.
 * Check ~once a minute; max idle ~10 min.
 */
export const FROZEN_TEXTURE_GC_CHECK_COUNT_MAX = 3600;
export const FROZEN_TEXTURE_GC_MAX_IDLE = 36000;

export function isObjectSnapshotUrl(url: string | null | undefined): boolean {
  return Boolean(url && url.startsWith("blob:"));
}

export function revokeSnapshotUrl(url: string | null | undefined): void {
  if (!isObjectSnapshotUrl(url)) return;
  try {
    URL.revokeObjectURL(url!);
  } catch {
    /* ignore */
  }
}

/** Replace a held snapshot URL. Revokes the previous object URL. */
export function adoptSnapshotUrl(prev: string | null, next: string | null): string | null {
  if (prev && prev !== next) revokeSnapshotUrl(prev);
  return next;
}

/**
 * Sync JPEG data-URL. Last-resort only (no cache, canvas already detached).
 * Callers must adopt/replace so these strings never accumulate.
 */
export function captureCanvasDataUrl(canvas: HTMLCanvasElement): string | null {
  try {
    return canvas.toDataURL("image/jpeg", SNAPSHOT_JPEG_QUALITY);
  } catch {
    return null;
  }
}

/**
 * Idle JPEG as an object URL (revocable). Never call this mid-storm or on
 * every remount — one still is enough to letterbox during the next drag.
 */
export function captureCanvasBlobUrl(
  canvas: HTMLCanvasElement,
  onUrl: (url: string) => void,
): void {
  try {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          try {
            onUrl(URL.createObjectURL(blob));
          } catch {
            /* private mode / revoked document */
          }
        },
        "image/jpeg",
        SNAPSHOT_JPEG_QUALITY,
      );
      return;
    }
  } catch {
    /* fall through */
  }
  const data = captureCanvasDataUrl(canvas);
  if (data) onUrl(data);
}
