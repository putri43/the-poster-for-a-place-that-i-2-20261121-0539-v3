// VESPERA — a travel poster for a place that does not exist.
// Renders a 1200x1600 poster with Node stdlib only (own PNG encoder).
// Deterministic: identical SHA-256 on every run.
// Usage: node main.ts   -> writes /output/entry.png and output/entry.png

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const W = 1200;
const H = 1600;
const BAND_Y = 1080; // poster band starts here

// ---------- deterministic PRNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261121);

// ---------- canvas ----------
const buf = Buffer.alloc(W * H * 3);
function rgb(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}
function setPx(x, y, c) {
  x |= 0; y |= 0;
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}
function blendPx(x, y, c, a) {
  x |= 0; y |= 0;
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = Math.round(buf[i] * (1 - a) + c[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + c[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + c[2] * a);
}
function fillRect(x, y, w, h, c) {
  for (let j = Math.max(0, y); j < Math.min(H, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(W, x + w); i++) setPx(i, j, c);
}
function vgrad(x, y, w, h, cTop, cBot) {
  for (let j = 0; j < h; j++) {
    const t = h <= 1 ? 0 : j / (h - 1);
    const c = [
      Math.round(cTop[0] + (cBot[0] - cTop[0]) * t),
      Math.round(cTop[1] + (cBot[1] - cTop[1]) * t),
      Math.round(cTop[2] + (cBot[2] - cTop[2]) * t),
    ];
    fillRect(x, y + j, w, 1, c);
  }
}
function disc(cx, cy, r, c) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) setPx(x, y, c);
    }
}
function ellipse(cx, cy, rx, ry, c) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPx(x, y, c);
    }
}
function ellipseA(cx, cy, rx, ry, c, a) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) blendPx(x, y, c, a);
    }
}
// parametric line (safe for float endpoints)
function line(x1, y1, x2, y2, c, w) {
  const dx = x2 - x1, dy = y2 - y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  const half = Math.floor(w / 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(x1 + dx * t), y = Math.round(y1 + dy * t);
    for (let oy = -half; oy <= half; oy++)
      for (let ox = -half; ox <= half; ox++) setPx(x + ox, y + oy, c);
  }
}
function lineA(x1, y1, x2, y2, c, w, a) {
  const dx = x2 - x1, dy = y2 - y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  const half = Math.floor(w / 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(x1 + dx * t), y = Math.round(y1 + dy * t);
    for (let oy = -half; oy <= half; oy++)
      for (let ox = -half; ox <= half; ox++) blendPx(x + ox, y + oy, c, a);
  }
}
// scanline polygon fill
function poly(points, c) {
  let minY = H, maxY = 0;
  for (const p of points) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(H - 1, Math.ceil(maxY)); y++) {
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        const t = (y - a[1]) / (b[1] - a[1]);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++)
        setPx(x, y, c);
  }
}

// ---------- 5x7 bitmap font (all-caps poster font) ----------
// each glyph: 7 rows, each a 5-bit number (bit 4 = leftmost pixel)
const FONT = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 27, 17], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 6, 8, 16, 31], "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12],
  " ": [0, 0, 0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12],
  ",": [0, 0, 0, 0, 12, 4, 8], "'": [4, 4, 8, 0, 0, 0, 0],
  "-": [0, 0, 0, 14, 0, 0, 0], "·": [0, 0, 12, 12, 0, 0, 0],
  ":": [0, 12, 0, 0, 0, 12, 0], "!": [4, 4, 4, 4, 4, 0, 4],
  "/": [1, 1, 2, 4, 8, 16, 16], "°": [14, 17, 17, 14, 0, 0, 0],
};
function textWidth(s, scale) {
  return s.length * 6 * scale - scale;
}
function drawText(s, x, y, scale, c) {
  let cx = x;
  for (const ch of s.toUpperCase()) {
    const g = FONT[ch] || FONT[" "];
    for (let r = 0; r < 7; r++)
      for (let col = 0; col < 5; col++)
        if (g[r] & (1 << (4 - col)))
          fillRect(cx + col * scale, y + r * scale, scale, scale, c);
    cx += 6 * scale;
  }
}
function drawTextCentered(s, y, scale, c) {
  drawText(s, Math.round((W - textWidth(s, scale)) / 2), y, scale, c);
}

// ---------- palette ----------
const INK = rgb(0x23204a);
const RED = rgb(0xa03a28);
const CREAM = rgb(0xf5ecd7);
const GOLD = rgb(0xe8c87a);
const MOON = rgb(0xf7e8b0);
const LAMP = rgb(0xffd970);

// ---------- sky ----------
vgrad(0, 0, W, BAND_Y, rgb(0x191238), rgb(0x4b2a63));
vgrad(0, 620, W, BAND_Y - 620, rgb(0x4b2a63), rgb(0xe8873c));

// stars (upper sky only)
for (let i = 0; i < 130; i++) {
  const x = Math.floor(rnd() * W), y = Math.floor(rnd() * 480);
  const s = rnd();
  if (s > 0.85) { disc(x, y, 2, rgb(0xfff6d8)); }
  else if (s > 0.6) { setPx(x, y, rgb(0xfff6d8)); setPx(x + 1, y, rgb(0xfff6d8)); }
  else setPx(x, y, rgb(0xe8dcff));
}

// moon + halo (top right)
ellipseA(955, 175, 120, 120, MOON, 0.10);
ellipseA(955, 175, 102, 102, MOON, 0.14);
disc(955, 175, 84, MOON);
disc(925, 150, 14, rgb(0xe8d48f));
disc(985, 205, 10, rgb(0xe8d48f));
disc(970, 140, 7, rgb(0xe8d48f));
disc(930, 205, 6, rgb(0xe8d48f));

// shooting star (top left)
lineA(150, 110, 330, 205, rgb(0xfff6d8), 3, 0.95);
lineA(150, 110, 240, 158, rgb(0xfff6d8), 2, 0.5);
disc(330, 205, 5, rgb(0xfff6d8));

// birds
function bird(x, y, s) {
  line(x - 8 * s, y, x, y - 5 * s, rgb(0x2a2140), 2);
  line(x, y - 5 * s, x + 8 * s, y, rgb(0x2a2140), 2);
}
bird(620, 210, 1); bird(700, 260, 1); bird(560, 300, 1); bird(830, 180, 1);

// ---------- floating isles ----------
// helper: one isle = grassy top slab + tapering rock + waterfall
function isle(x1, x2, topY, tipY, rockC, grassC, fallX, fallW) {
  // rock body: wide top, tapering to a point
  const midX = (x1 + x2) / 2;
  poly([[x1, topY], [x2, topY], [midX + (x2 - x1) * 0.12, tipY], [midX - (x2 - x1) * 0.12, tipY]], rockC);
  // warm rim light on the right edge
  line(x2 - 6, topY + 4, midX + (x2 - x1) * 0.12, tipY - 4, rgb(0x8a5a6a), 4);
  // grassy top slab
  poly([[x1 - 8, topY], [x2 + 8, topY], [x2 - 4, topY + 16], [x1 + 4, topY + 16]], grassC);
  // waterfall pouring off the underside
  if (fallX !== null) {
    const top = tipY - 30;
    const bot = BAND_Y - 60;
    for (let y = top; y < bot; y += 2) {
      const wob = Math.sin((y - top) * 0.05) * 3;
      const w = fallW + Math.sin((y - top) * 0.11) * 2;
      fillRect(Math.round(fallX + wob - w / 2), y, Math.round(w), 2, rgb(0xcfe8f0));
      if (y % 7 === 0) setPx(Math.round(fallX + wob), y, rgb(0xffffff));
    }
    // foam where it meets the clouds
    ellipse(fallX, bot + 6, fallW + 16, 10, rgb(0xeaf6fa));
    ellipse(fallX - 14, bot + 12, 12, 7, rgb(0xffffff));
    ellipse(fallX + 16, bot + 12, 12, 7, rgb(0xffffff));
  }
}

// far small isle, high right (behind the moon side)
isle(930, 1120, 430, 600, rgb(0x4a3560), rgb(0x7c8a3f), 1000, 12);
// flag on the far isle
line(1010, 430, 1010, 372, rgb(0x2a2140), 3);
poly([[1010, 372], [1048, 382], [1010, 394]], RED);

// big left isle with the lighthouse
isle(90, 470, 560, 830, rgb(0x3a2a4a), rgb(0x7c8a3f), 300, 22);
// lighthouse on the big isle
const LX = 185, LTOP = 452, LBOT = 560;
fillRect(LX - 26, LTOP + 30, 52, LBOT - LTOP - 30, rgb(0xf4ead8));
fillRect(LX - 26, LTOP + 58, 52, 14, RED);
fillRect(LX - 26, LTOP + 92, 52, 14, RED);
fillRect(LX - 30, LTOP + 22, 60, 10, rgb(0x2a2140)); // gallery
fillRect(LX - 16, LTOP, 32, 24, rgb(0x2a2140)); // lamp room
disc(LX, LTOP + 12, 10, LAMP);
ellipseA(LX, LTOP + 12, 26, 18, LAMP, 0.35);
// light beam sweeping right
for (let i = 0; i < 3; i++) {
  const yy = LTOP + 12 + (i - 1) * 7;
  lineA(LX + 18, LTOP + 12, 760, yy + (i - 1) * 26, LAMP, 5, 0.16 - i * 0.03);
}

// centre-right isle with a tree cluster
isle(560, 900, 690, 950, rgb(0x41304e), rgb(0x7c8a3f), 720, 16);
// little trees
function tree(x, y, s) {
  fillRect(x - 2 * s, y, 4 * s, 10 * s, rgb(0x5a3a2a));
  poly([[x, y - 22 * s], [x - 12 * s, y], [x + 12 * s, y]], rgb(0x3f6a3a));
  poly([[x, y - 34 * s], [x - 9 * s, y - 12 * s], [x + 9 * s, y - 12 * s]], rgb(0x4a7a42));
}
tree(640, 690, 1); tree(700, 690, 1); tree(820, 690, 1); tree(760, 690, 1);

// ---------- skyferry airship ----------
// drifting between the isles, centre-left of the sky
const AX = 430, AY = 330;
ellipse(AX, AY, 175, 56, rgb(0xe8c87a));
ellipse(AX, AY - 6, 175, 50, rgb(0xf0d79a));
poly([[AX + 120, AY - 30], [AX + 185, AY - 44], [AX + 185, AY - 6], [AX + 120, AY + 2]], RED); // tail fin
poly([[AX + 120, AY + 24], [AX + 180, AY + 40], [AX + 180, AY + 6], [AX + 120, AY + 2]], rgb(0x8a5a3a));
fillRect(AX - 150, AY - 8, 300, 10, RED); // stripe
fillRect(AX - 60, AY + 44, 120, 26, rgb(0x5a3a2a)); // gondola
fillRect(AX - 60, AY + 44, 120, 4, rgb(0x2a2140));
for (let i = 0; i < 6; i++) disc(AX - 44 + i * 18, AY + 57, 5, LAMP); // gondola windows
line(AX - 40, AY + 44, AX - 30, AY + 30, rgb(0x2a2140), 2);
line(AX + 40, AY + 44, AX + 30, AY + 30, rgb(0x2a2140), 2);
disc(AX - 165, AY - 2, 4, rgb(0x2a2140)); // nose cap

// ---------- sea of clouds (bottom of the sky) ----------
const CLOUD_CREAM = rgb(0xf2d9b0), CLOUD_ROSE = rgb(0xe59a7c), CLOUD_SHADOW = rgb(0x9c6b8a);
function cloud(cx, cy, s) {
  ellipse(cx, cy, 150 * s, 42 * s, CLOUD_SHADOW);
  ellipse(cx - 60 * s, cy - 14 * s, 110 * s, 36 * s, CLOUD_ROSE);
  ellipse(cx + 70 * s, cy - 10 * s, 120 * s, 38 * s, CLOUD_CREAM);
  ellipse(cx, cy - 26 * s, 120 * s, 34 * s, CLOUD_CREAM);
  ellipse(cx - 30 * s, cy - 40 * s, 70 * s, 24 * s, rgb(0xfff0d0));
}
cloud(180, 1000, 1.1); cloud(520, 1030, 1.3); cloud(880, 1005, 1.2);
cloud(60, 1050, 0.9); cloud(1120, 1040, 1.0); cloud(340, 1060, 0.9);
cloud(760, 1060, 1.0); cloud(980, 1075, 0.8);

// ---------- poster band ----------
fillRect(0, BAND_Y, W, H - BAND_Y, CREAM);
fillRect(0, BAND_Y, W, 4, INK);
fillRect(0, BAND_Y + 10, W, 2, RED);

// title
drawTextCentered("VESPERA", BAND_Y + 52, 18, INK);
// red rule under the title
const tw = textWidth("VESPERA", 18);
fillRect(Math.round((W - tw) / 2), BAND_Y + 52 + 7 * 18 + 18, tw, 6, RED);

// tagline
drawTextCentered("THE ISLES THAT NEVER TOUCH THE SEA", BAND_Y + 250, 5, INK);

// ornament divider: diamond + lines
const DY = BAND_Y + 330;
line(300, DY, 520, DY, INK, 2);
line(680, DY, 900, DY, INK, 2);
poly([[600, DY - 12], [614, DY], [600, DY + 12], [586, DY]], RED);

// small print (scale 3 so the whole line fits the 1200px width)
drawTextCentered("SKYFERRY DEPARTS DAILY · NO PASSPORT REQUIRED FOR DREAMERS", BAND_Y + 372, 3, RED);

// footer
drawTextCentered("VISIT VESPERA · ISSUED BY THE SKYFERRY COMPANY", BAND_Y + 440, 3, INK);
drawText("N° 07", 60, H - 56, 3, INK);

// ---------- PNG encoder (stdlib zlib) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    buf.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = encodePNG();
fs.mkdirSync("/output", { recursive: true });
fs.writeFileSync("/output/entry.png", png);
fs.mkdirSync(path.join(__dirname, "output"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "output", "entry.png"), png);
console.log("wrote /output/entry.png + output/entry.png, bytes:", png.length);
