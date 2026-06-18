// Generates the app/tray icons (PNG + ICO) with pure Node built-ins (no deps).
// A rounded blue gradient tile with three white "usage" bars.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

// ---- PNG encoder ----------------------------------------------------------
const crcTable = (() => {
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
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function pngToIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 0 => 256
  entry[1] = 0; // height 0 => 256
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, png]);
}

// ---- draw the icon --------------------------------------------------------
function draw(size) {
  const w = size, h = size;
  const px = Buffer.alloc(w * h * 4);
  const r = Math.round(size * 0.22);
  const set = (x, y, cr, cg, cb, ca) => {
    const i = (y * w + x) * 4;
    px[i] = cr; px[i + 1] = cg; px[i + 2] = cb; px[i + 3] = ca;
  };
  const inRound = (x, y) => {
    const cx = Math.min(Math.max(x, r), w - 1 - r);
    const cy = Math.min(Math.max(y, r), h - 1 - r);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inRound(x, y)) { set(x, y, 0, 0, 0, 0); continue; }
      const t = y / h;
      const cr = Math.round(58 + (22 - 58) * t);
      const cg = Math.round(160 + (101 - 160) * t);
      const cb = Math.round(255 + (216 - 255) * t);
      set(x, y, cr, cg, cb, 255);
    }
  }
  // three white bars
  const barCount = 3;
  const innerPad = size * 0.3;
  const barAreaW = w - innerPad * 2;
  const barW = barAreaW / (barCount * 2 - 1);
  const heights = [0.45, 0.82, 0.62];
  const baseY = h - innerPad;
  for (let b = 0; b < barCount; b++) {
    const bx = Math.round(innerPad + b * barW * 2);
    const bh = Math.round((baseY - innerPad) * heights[b]);
    const topY = Math.round(baseY - bh);
    for (let y = topY; y < baseY; y++) {
      for (let x = bx; x < bx + Math.round(barW); x++) {
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        if (!inRound(x, y)) continue;
        set(x, y, 255, 255, 255, 255);
      }
    }
  }
  return px;
}

const png256 = encodePNG(256, 256, draw(256));
fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
fs.writeFileSync(path.join(outDir, 'icon.ico'), pngToIco(png256));
fs.writeFileSync(path.join(outDir, 'tray.png'), encodePNG(32, 32, draw(32)));
console.log('assets generated ->', outDir);
