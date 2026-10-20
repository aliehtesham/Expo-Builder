'use strict';
/*
 * Expo Builder — icon generator.
 *
 * Renders the app logo (rounded tile, lavender→violet gradient, "E" monogram
 * whose short middle arm gives it a stacked/build feel) into:
 *   resources/icon.png   512×512 master raster
 *   resources/icon.ico   multi-size Windows icon (16..256)
 *   resources/icon.svg   vector master
 *
 * Pure Node: pixels come from signed-distance-field math with 4× supersampling,
 * PNG/ICO are encoded by hand (zlib + CRC32). Run: node tools/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── design tokens (24-unit grid, matches the in-app brand-mark) ──────────────
const TILE_RADIUS = 5.4;
const GRADIENT = [
  [0.0, 0xdc, 0xc9, 0xff],
  [0.52, 0x9d, 0x75, 0xff],
  [1.0, 0x6a, 0x3e, 0xf0],
];
const GLYPH = [0x24, 0x14, 0x47];
// "E" monogram: spine + three pill bars, middle arm shortened.
const BARS = [
  { cx: 7.3, cy: 12.0, hx: 1.8, hy: 8.0 },
  { cx: 12.0, cy: 5.8, hx: 6.5, hy: 1.8 },
  { cx: 10.0, cy: 12.0, hx: 4.5, hy: 1.8 },
  { cx: 12.0, cy: 18.2, hx: 6.5, hy: 1.8 },
];
const BAR_R = 1.8;
const SHEEN = { x: 7.2, y: 6.4, r: 14, a: 0.2 };

// ── geometry helpers ──────────────────────────────────────────────────────────
function roundedRectDist(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// 1 inside the shape, 0 outside; `aa` is the transition width in grid units
// (one supersample pixel — the box downsample finishes the anti-aliasing).
const cover = (d, aa) => clamp01(0.5 - d / aa);

function gradientColor(t) {
  let a = GRADIENT[0];
  let b = GRADIENT[GRADIENT.length - 1];
  for (let i = 0; i < GRADIENT.length - 1; i++) {
    if (t >= GRADIENT[i][0] && t <= GRADIENT[i + 1][0]) {
      a = GRADIENT[i];
      b = GRADIENT[i + 1];
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const k = clamp01((t - a[0]) / span);
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
}

// Color + alpha of the logo at a point on the 24-unit grid.
function sample(u, v, aa) {
  const dTile = roundedRectDist(u, v, 12, 12, 12, 12, TILE_RADIUS);
  const aTile = cover(dTile, aa);
  if (aTile <= 0) return [0, 0, 0, 0];

  const [tr, tg, tb] = gradientColor(clamp01((u + v) / 48));
  const ds = Math.hypot(u - SHEEN.x, v - SHEEN.y) / SHEEN.r;
  const sheen = ds < 1 ? SHEEN.a * Math.pow(1 - ds, 1.7) : 0;
  let r = tr + (255 - tr) * sheen;
  let g = tg + (255 - tg) * sheen;
  let b = tb + (255 - tb) * sheen;

  let dGlyph = Infinity;
  for (const bar of BARS) {
    const d = roundedRectDist(u, v, bar.cx, bar.cy, bar.hx, bar.hy, BAR_R);
    if (d < dGlyph) dGlyph = d;
  }
  const aGlyph = cover(dGlyph, aa);
  if (aGlyph > 0) {
    r += (GLYPH[0] - r) * aGlyph;
    g += (GLYPH[1] - g) * aGlyph;
    b += (GLYPH[2] - b) * aGlyph;
  }
  return [r, g, b, aTile * 255];
}

// ── rasterizer (4× supersampling, box downsample) ────────────────────────────
function render(size) {
  const SS = 4;
  const dim = size * SS;
  const aa = 24 / dim; // one supersample pixel, in 24-grid units
  const acc = new Float64Array(size * size * 4);
  for (let y = 0; y < dim; y++) {
    const v = ((y + 0.5) / dim) * 24;
    for (let x = 0; x < dim; x++) {
      const u = ((x + 0.5) / dim) * 24;
      const [r, g, b, a] = sample(u, v, aa);
      const oi = ((y / SS | 0) * size + (x / SS | 0)) * 4;
      acc[oi] += r;
      acc[oi + 1] += g;
      acc[oi + 2] += b;
      acc[oi + 3] += a;
    }
  }
  const n = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(acc[i * 4] / n);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / n);
  }
  return out;
}

// ── PNG encoding ─────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO packing (PNG-compressed entries, Vista+) ─────────────────────────────
function encodeICO(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const dirSize = 16 * pngs.length;
  const entries = [];
  let offset = 6 + dirSize;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

// ── SVG master ───────────────────────────────────────────────────────────────
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#dcc9ff"/>
      <stop offset=".52" stop-color="#9d75ff"/>
      <stop offset="1" stop-color="#6a3ef0"/>
    </linearGradient>
    <radialGradient id="sheen" cx=".3" cy=".27" r=".8">
      <stop offset="0" stop-color="#fff" stop-opacity=".2"/>
      <stop offset=".6" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="24" height="24" rx="5.4" fill="url(#tile)"/>
  <rect width="24" height="24" rx="5.4" fill="url(#sheen)"/>
  <g fill="#241447">
    <rect x="5.5" y="4" width="3.6" height="16" rx="1.8"/>
    <rect x="5.5" y="4" width="13" height="3.6" rx="1.8"/>
    <rect x="5.5" y="10.2" width="9" height="3.6" rx="1.8"/>
    <rect x="5.5" y="16.4" width="13" height="3.6" rx="1.8"/>
  </g>
</svg>
`;

// ── main ─────────────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'resources');
fs.mkdirSync(outDir, { recursive: true });

const master = 512;
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(master, render(master)));

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = icoSizes.map((s) => ({ size: s, png: encodePNG(s, render(s)) }));
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO(pngs));
fs.writeFileSync(path.join(outDir, 'icon.svg'), SVG);

console.log(`wrote icon.png (${master}px), icon.ico (${icoSizes.join(', ')}), icon.svg → ${outDir}`);
