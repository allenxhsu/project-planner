/*
 * Renders macos/build/icon.png (1024×1024, transparent corners): the PJ badge
 * the app wears in its own header, as a Dock icon.
 *
 * The shapes are evaluated per pixel with 4×4 supersampling and written as a
 * PNG through zlib, with no dependencies — the same approach as Hypermail's
 * icon. Quick Look and sips cannot do this: they fill the corners white, which
 * shows as a white square behind the icon in the Dock.
 *
 *   node macos/scripts/make-icon.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const N = 1024
const SS = 4
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

// The app's identity green, from ui-kit/tokens/tokens.json, on the kit's panel dark.
const GREEN = hex('#55c364')
const GLOW = hex('#7fe08c')
const BG0 = hex('#222a33')
const BG1 = hex('#141a21')

// Rounded square on the macOS grid: 832 px body, 186 px corner radius.
const RX = 96, RW = 832, RR = 186
function sdRoundRect(x, y) {
  const c = RX + RW / 2, b = RW / 2
  const qx = Math.abs(x - c) - b + RR, qy = Math.abs(y - c) - b + RR
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RR
}

/**
 * The brand mark's hexagon: a point at the top and the bottom, flat sides —
 * `clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)` in
 * ui-kit's `.sc-brand-mark`, at the same 30:34 proportion.
 */
const HEX = [[512, 206], [764, 332], [764, 692], [512, 818], [260, 692], [260, 332]]
function inPoly(x, y, P) {
  let inside = false
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function distToPoly(x, y, P) {
  let d = Infinity
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ax, ay] = P[j], [bx, by] = P[i]
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
    d = Math.min(d, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))))
  }
  return d
}

// "PJ", drawn as bars the way a geometric display face draws them.
const T = 44                     // stroke
const TOP = 394, BOT = 638       // cap height
const BOWL = 152                 // how far down the P's bowl reaches
const rect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1
const P_L = 362, P_R = 498
const J_L = 534, J_R = 662
const inP = (x, y) =>
  rect(x, y, P_L, TOP, P_L + T, BOT) ||                 // stem
  rect(x, y, P_L, TOP, P_R, TOP + T) ||                 // top bar
  rect(x, y, P_R - T, TOP, P_R, TOP + BOWL) ||          // right shoulder
  rect(x, y, P_L, TOP + BOWL - T, P_R, TOP + BOWL)      // waist
const inJ = (x, y) =>
  rect(x, y, J_R - T, TOP, J_R, BOT) ||                 // stem
  rect(x, y, J_L, BOT - T, J_R, BOT) ||                 // foot
  rect(x, y, J_L, BOT - 72, J_L + T, BOT)               // hook
const inMark = (x, y) => inP(x, y) || inJ(x, y)

/** Colour and coverage of one sample point, or null outside the icon body. */
function sample(x, y) {
  const d = sdRoundRect(x, y)
  if (d > 0) return null
  // The plate: a soft diagonal, lighter at the top left, as the kit's panels are.
  let c = mix(BG0, BG1, (x + y) / (2 * N))
  const dHex = distToPoly(x, y, HEX)
  const inHex = inPoly(x, y, HEX)
  // A glow just outside the hexagon, the drop-shadow the brand mark carries.
  if (!inHex && dHex < 26) c = mix(c, GREEN, 0.22 * (1 - dHex / 26))
  // The hexagon's own face: the kit's 18% tint of the app colour.
  if (inHex) c = mix(c, GREEN, 0.18)
  // Its edge: the 1 px inset ring, thickened to read at icon sizes.
  if (inHex && dHex < 9) c = mix(GREEN, GLOW, 0.35)
  if (inHex && inMark(x, y)) c = mix(GREEN, GLOW, 0.5)
  return c
}

const raw = Buffer.alloc(N * (N * 4 + 1))
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0 // PNG filter: none
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, hits = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)
        if (c) { r += c[0]; g += c[1]; b += c[2]; hits++ }
      }
    }
    const o = y * (N * 4 + 1) + 1 + x * 4
    if (hits) {
      raw[o] = Math.round(r / hits); raw[o + 1] = Math.round(g / hits); raw[o + 2] = Math.round(b / hits)
      raw[o + 3] = Math.round((hits / (SS * SS)) * 255)
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4)
ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA

const out = new URL('../build/icon.png', import.meta.url)
mkdirSync(new URL('../build/', import.meta.url), { recursive: true })
writeFileSync(out, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]))
console.log('wrote macos/build/icon.png')
