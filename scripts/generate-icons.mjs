import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const iconsDir = path.resolve(__dirname, "..", "src-tauri", "icons");
fs.mkdirSync(iconsDir, { recursive: true });

function crc32(buf) {
  let table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

function createPng(width, height) {
  // Create circular gradient router icon with cyan/magenta cyberpunk vibe
  const scanlines = [];
  const cx = width / 2;
  const cy = height / 2;
  const radius = width * 0.45;
  const innerRadius = width * 0.28;

  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const offset = 1 + x * 4;

      if (dist <= radius) {
        // Outer ring / disc
        const angle = Math.atan2(dy, dx);
        const t = (angle + Math.PI) / (2 * Math.PI);
        // Cyan to Magenta gradient: Cyan (0, 220, 255) to Magenta (255, 40, 160)
        const r = Math.round(20 + 235 * t);
        const g = Math.round(180 * (1 - t) + 30);
        const b = Math.round(255 * (1 - t) + 180 * t);
        
        if (dist >= innerRadius) {
          // Ring border accent
          row[offset] = r;
          row[offset + 1] = g;
          row[offset + 2] = b;
          row[offset + 3] = 255;
        } else {
          // Dark core with electric router dot
          const coreDist = dist / innerRadius;
          if (coreDist < 0.35) {
            row[offset] = 0;
            row[offset + 1] = 255;
            row[offset + 2] = 200; // Bright mint green localhost dot
            row[offset + 3] = 255;
          } else {
            row[offset] = 18;
            row[offset + 1] = 20;
            row[offset + 2] = 30; // Dark ink
            row[offset + 3] = 240;
          }
        }
      } else {
        // Transparent background
        row[offset] = 0;
        row[offset + 1] = 0;
        row[offset + 2] = 0;
        row[offset + 3] = 0;
      }
    }
    scanlines.push(row);
  }

  const rawData = Buffer.concat(scanlines);
  const compressed = zlib.deflateSync(rawData);

  // PNG Signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk("IHDR", ihdr);

  // IDAT chunk
  const idatChunk = makeChunk("IDAT", compressed);

  // IEND chunk
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Generate standard PNG sizes
const sizes = [
  { name: "32x32.png", size: 32 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 }
];

for (const s of sizes) {
  const png = createPng(s.size, s.size);
  fs.writeFileSync(path.join(iconsDir, s.name), png);
  console.log(`✓ Generated ${s.name} (${s.size}x${s.size})`);
}

// Minimal valid ICO wrapping 32x32 PNG
const png32 = fs.readFileSync(path.join(iconsDir, "32x32.png"));
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0); // reserved
icoHeader.writeUInt16LE(1, 2); // type 1 = icon
icoHeader.writeUInt16LE(1, 4); // 1 image

const icoDir = Buffer.alloc(16);
icoDir[0] = 32; // width
icoDir[1] = 32; // height
icoDir[2] = 0;  // palette count
icoDir[3] = 0;  // reserved
icoDir.writeUInt16LE(1, 4); // color planes
icoDir.writeUInt16LE(32, 6); // bpp
icoDir.writeUInt32LE(png32.length, 8); // size
icoDir.writeUInt32LE(22, 12); // offset (6 + 16 = 22)

const icoFile = Buffer.concat([icoHeader, icoDir, png32]);
fs.writeFileSync(path.join(iconsDir, "icon.ico"), icoFile);
console.log("✓ Generated icon.ico");

// Minimal valid ICNS wrapping 128x128 PNG (ic07 tag)
const png128 = fs.readFileSync(path.join(iconsDir, "128x128.png"));
const icnsTag = Buffer.from("ic07", "ascii");
const chunkLen = Buffer.alloc(4);
chunkLen.writeUInt32BE(8 + png128.length, 0);
const icnsChunk = Buffer.concat([icnsTag, chunkLen, png128]);

const icnsHeader = Buffer.from("icns", "ascii");
const totalLen = Buffer.alloc(4);
totalLen.writeUInt32BE(8 + icnsChunk.length, 0);
const icnsFile = Buffer.concat([icnsHeader, totalLen, icnsChunk]);
fs.writeFileSync(path.join(iconsDir, "icon.icns"), icnsFile);
console.log("✓ Generated icon.icns");