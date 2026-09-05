#!/usr/bin/env python3
"""Write original Sprunki Jam PNG icons without third-party image libs."""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
ICONS = PUBLIC / "icons"


def png(w: int, h: int, rgba: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + rgba[y * w * 4 : (y + 1) * w * 4] for y in range(h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def pixel(buf: bytearray, w: int, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if 0 <= x < w and 0 <= y < w:
        i = (y * w + x) * 4
        buf[i : i + 4] = bytes(color)


def blend(buf: bytearray, w: int, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if not (0 <= x < w and 0 <= y < w):
        return
    i = (y * w + x) * 4
    sr, sg, sb, sa = color
    dr, dg, db, da = buf[i], buf[i + 1], buf[i + 2], buf[i + 3]
    a = sa / 255
    pixel(buf, w, x, y, (int(dr * (1 - a) + sr * a), int(dg * (1 - a) + sg * a), int(db * (1 - a) + sb * a), max(da, sa)))


def fill_circle(buf: bytearray, w: int, cx: float, cy: float, r: float, color: tuple[int, int, int, int]) -> None:
    r2 = r * r
    x0, x1 = int(cx - r - 1), int(cx + r + 1)
    y0, y1 = int(cy - r - 1), int(cy + r + 1)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r2:
                blend(buf, w, x, y, color)


def fill_rect(buf: bytearray, w: int, x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int, int]) -> None:
    for y in range(y0, y1):
        for x in range(x0, x1):
            blend(buf, w, x, y, color)


def draw_icon(size: int) -> bytes:
    buf = bytearray(size * size * 4)
    fill_rect(buf, size, 0, 0, size, size, (20, 8, 16, 255))
    s = size / 64
    fill_circle(buf, size, 32 * s, 36 * s, 16 * s, (240, 138, 42, 255))
    fill_rect(buf, size, int(16 * s), int(28 * s), int(48 * s), int(36 * s), (44, 58, 68, 255))
    fill_circle(buf, size, 26 * s, 34 * s, 2.6 * s, (42, 26, 18, 255))
    fill_circle(buf, size, 38 * s, 34 * s, 2.6 * s, (42, 26, 18, 255))
    for i in range(int(10 * s)):
        y = 12 * s - i * 0.7
        fill_circle(buf, size, 32 * s + math.sin(i * 0.6) * s, y, 1.3 * s, (224, 122, 34, 255))
    fill_circle(buf, size, 32 * s, 4 * s, 2.4 * s, (255, 195, 106, 255))
    return png(size, size, bytes(buf))


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "apple-touch-icon.png").write_bytes(draw_icon(180))
    (ICONS / "pwa-192.png").write_bytes(draw_icon(192))
    (ICONS / "pwa-512.png").write_bytes(draw_icon(512))
    print("icons written")


if __name__ == "__main__":
    main()
