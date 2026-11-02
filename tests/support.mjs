// Helpers for the smoke test: reading source trees into the files Map,
// Klipper's pad_checksum ported to JavaScript, and small ELF, Intel HEX and
// linker-output parsers.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Read every file under dir into map as <prefix>/<relative path> (POSIX separators). */
export function readTree(map, dir, prefix, filter = () => true) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    const key = `${prefix}/${name}`;
    if (st.isDirectory()) readTree(map, path, key, filter);
    else if (st.isFile() && filter(key)) map.set(key, new Uint8Array(readFileSync(path)));
  }
  return map;
}

/** Little-endian 32-bit read. */
export function u32(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

export function isElf(bytes) {
  return bytes.length > 52 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

/** e_machine of an ELF32 little-endian file (0x28 is ARM). */
export function elfMachine(bytes) {
  return bytes[18] | (bytes[19] << 8);
}

/** The address of a symbol in `llvm-nm` output, or undefined. */
export function symbolAddress(nmText, name) {
  for (const line of nmText.split("\n")) {
    const m = /^([0-9a-fA-F]+)\s+\S\s+(\S+)$/.exec(line.trim());
    if (m && m[2] === name) return parseInt(m[1], 16);
  }
  return undefined;
}

/** Parse lld's --print-memory-usage table into {region: {used, size}}. */
export function parseMemoryUsage(text) {
  const regions = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(\S+):\s+(\d+)\s+(\w+)\s+(\d+)\s+(\w+)\s+([\d.]+)%/.exec(line);
    if (m) regions[m[1]] = { used: scale(m[2], m[3]), size: scale(m[4], m[5]) };
  }
  return regions;
}

function scale(value, unit) {
  const n = Number(value);
  switch (unit.toUpperCase()) {
    case "B": return n;
    case "KB": return n * 1024;
    case "MB": return n * 1024 * 1024;
    case "GB": return n * 1024 * 1024 * 1024;
    default: return n;
  }
}

/** Parse Intel HEX into a Map of start address -> bytes (contiguous segments merged). */
export function parseIhex(text) {
  const segments = new Map();
  let upper = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(":")) continue;
    const bytes = Buffer.from(line.slice(1), "hex");
    const len = bytes[0];
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    if (sum !== 0) throw new Error(`ihex checksum error in ${line}`);
    const data = bytes.subarray(4, 4 + len);
    if (type === 0x04) upper = ((data[0] << 8) | data[1]) << 16;
    else if (type === 0x02) upper = ((data[0] << 8) | data[1]) << 4;
    else if (type === 0x00) {
      const start = (upper + addr) >>> 0;
      const prev = [...segments.entries()].find(([s, d]) => s + d.length === start);
      if (prev) segments.set(prev[0], Buffer.concat([prev[1], Buffer.from(data)]));
      else segments.set(start, Buffer.from(data));
    }
  }
  return segments;
}

/** Klipper's CONFIG_ values from an autoconf.h (numbers parsed, strings unquoted). */
export function parseAutoconf(text) {
  const config = {};
  for (const line of text.split("\n")) {
    const m = /^#define (CONFIG_\w+) (.*)$/.exec(line.trim());
    if (!m) continue;
    const value = m[2];
    if (/^"/.test(value)) config[m[1]] = value.slice(1, -1);
    else if (/^0x[0-9a-fA-F]+$/.test(value)) config[m[1]] = parseInt(value, 16);
    else if (/^-?\d+$/.test(value)) config[m[1]] = Number(value);
    else config[m[1]] = value;
  }
  return config;
}

// ---------------------------------------------------------------------------
// pad_checksum (lib/pico-sdk/rp2040/boot_stage2/pad_checksum), ported.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** binascii.crc32(data, value) */
function crc32(data, value) {
  let crc = (value ^ 0xffffffff) >>> 0;
  for (const b of data) crc = (CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function bitrev8(b) {
  let r = 0;
  for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1);
  return r;
}

function bitrev32(v) {
  let r = 0;
  for (let i = 0; i < 32; i++) r = ((r << 1) | ((v >>> i) & 1)) >>> 0;
  return r >>> 0;
}

/**
 * Pad a stage2 binary to `pad` bytes including a 4-byte checksum computed the
 * way the RP2040 boot ROM expects, and return {bytes, asm} where asm is the
 * assembly file pad_checksum writes (Klipper compiles it to stage2.o).
 */
export function padChecksum(input, inputName, pad = 256, seed = 0) {
  if (input.length > pad - 4) throw new Error(`stage2 is ${input.length} bytes, the limit is ${pad - 4}`);
  const padded = new Uint8Array(pad - 4);
  padded.set(input);
  const reversed = padded.map(bitrev8);
  const checksum = bitrev32((crc32(reversed, (seed ^ 0xffffffff) >>> 0) ^ 0xffffffff) >>> 0);
  const bytes = new Uint8Array(pad);
  bytes.set(padded);
  bytes[pad - 4] = checksum & 0xff;
  bytes[pad - 3] = (checksum >>> 8) & 0xff;
  bytes[pad - 2] = (checksum >>> 16) & 0xff;
  bytes[pad - 1] = (checksum >>> 24) & 0xff;
  let asm = `// Padded and checksummed version of: ${inputName}\n\n.cpu cortex-m0plus\n.thumb\n\n.section .boot2, "ax"\n\n`;
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = [...bytes.subarray(off, Math.min(off + 16, bytes.length))];
    asm += `.byte ${chunk.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", ")}\n`;
  }
  return { bytes, asm, checksum };
}
