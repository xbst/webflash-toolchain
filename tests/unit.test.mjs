// Unit tests of the parts of toolchain.js and the test helpers that run
// without a built toolchain: the gzip decoder, the tar parser, the
// `clang -###` parser and the pad_checksum port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip, inflateGzip, parseTar, parseDriverCommands, normalizeCommand } from "../src/toolchain.js";
import { padChecksum, parseIhex, parseMemoryUsage, symbolAddress } from "./support.mjs";

function pseudoRandom(n, seed = 1) {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

const samples = {
  empty: new Uint8Array(0),
  text: new TextEncoder().encode("hello hello hello hello, WebFlash toolchain\n".repeat(200)),
  random: pseudoRandom(300 * 1024),
  mixed: (() => {
    const a = pseudoRandom(100 * 1024, 7);
    const b = new Uint8Array(400 * 1024);
    for (let i = 0; i < b.length; i++) b[i] = (i * 7) & 0xff;
    const out = new Uint8Array(a.length + b.length + a.length);
    out.set(a); out.set(b, a.length); out.set(a, a.length + b.length);
    return out;
  })(),
};

for (const [name, data] of Object.entries(samples)) {
  for (const level of [1, 6, 9]) {
    test(`inflateGzip decodes ${name} at level ${level}`, () => {
      const gz = gzipSync(data, { level });
      const out = inflateGzip(gz);
      assert.equal(out.length, data.length);
      assert.ok(Buffer.compare(Buffer.from(out), Buffer.from(data)) === 0);
    });
  }
}

test("inflateGzip handles a stored (level 0) stream and gzip header fields", () => {
  const data = samples.mixed;
  const gz = gzipSync(data, { level: 0 });
  // Add an FNAME field by rewriting the header: set FLG.FNAME and insert a name.
  const withName = new Uint8Array(gz.length + 5);
  withName.set(gz.subarray(0, 10));
  withName[3] |= 8;
  withName.set(new TextEncoder().encode("x.gz\0"), 10);
  withName.set(gz.subarray(10), 15);
  const out = inflateGzip(withName);
  assert.ok(Buffer.compare(Buffer.from(out), Buffer.from(data)) === 0);
});

test("gunzip agrees with inflateGzip", async () => {
  const gz = gzipSync(samples.mixed, { level: 9 });
  const a = await gunzip(gz);
  const b = inflateGzip(gz);
  assert.ok(Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0);
});

test("inflateGzip rejects garbage", () => {
  assert.throws(() => inflateGzip(new Uint8Array(40)), /not a gzip stream/);
});

function tarFlavor() {
  const r = spawnSync("tar", ["--version"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  if (/GNU tar/.test(r.stdout)) return "gnu";
  if (/bsdtar/.test(r.stdout)) return "bsd";
  return null;
}

function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), "wf-tar-"));
  const root = join(dir, "sysroot");
  const deep = join(root, "lib", "clang-runtimes", "arm-none-eabi", "armv8m.main_soft_nofp_unaligned_size", "a-directory-name-that-is-long-enough-to-push-the-whole-path-past-one-hundred-characters", "lib");
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(deep, "libc.a"), pseudoRandom(5000, 3));
  writeFileSync(join(root, "lib", "picolibc.h"), "#pragma once\n");
  writeFileSync(join(root, "bin", "clang"), "");
  chmodSync(join(root, "bin", "clang"), 0o755);
  writeFileSync(join(root, "lib", "empty"), "");
  try { symlinkSync("clang", join(root, "bin", "clang++")); } catch { /* no symlink permission on Windows */ }
  return { dir, root };
}

const flavor = tarFlavor();
const formats = flavor === "gnu" ? ["gnu", "ustar", "posix"] : flavor === "bsd" ? ["ustar", "pax"] : [];
for (const format of formats) {
  test(`parseTar reads a ${flavor} tar in ${format} format`, () => {
    const { dir } = makeTree();
    try {
      // Relative paths: GNU tar on Windows reads "C:..." as a remote host.
      const args = flavor === "gnu"
        ? ["--format=" + format, "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", "t.tar", "sysroot"]
        : ["--format", format, "-cf", "t.tar", "sysroot"];
      const r = spawnSync("tar", args, { encoding: "utf8", cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      const entries = parseTar(new Uint8Array(readFileSync(join(dir, "t.tar"))));
      const byName = new Map(entries.map((e) => [e.name, e]));
      const lib = [...byName.keys()].find((n) => n.endsWith("/libc.a"));
      assert.ok(lib && lib.length > 100, "long path survives");
      assert.equal(byName.get(lib).type, "file");
      assert.equal(byName.get(lib).data.length, 5000);
      assert.ok(Buffer.compare(Buffer.from(byName.get(lib).data), Buffer.from(pseudoRandom(5000, 3))) === 0);
      assert.equal(byName.get("sysroot/lib/picolibc.h").type, "file");
      assert.equal(new TextDecoder().decode(byName.get("sysroot/lib/picolibc.h").data), "#pragma once\n");
      assert.equal(byName.get("sysroot/lib/empty").data.length, 0);
      assert.equal(byName.get("sysroot/bin").type, "dir");
      if (process.platform !== "win32") {
        assert.ok(byName.get("sysroot/bin/clang").mode & 0o111, "executable bit kept");
        const link = byName.get("sysroot/bin/clang++");
        assert.equal(link?.type, "symlink");
        assert.equal(link.linkname, "clang");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("parseTar handles an archive built by hand with a pax path record", () => {
  const block = (fields) => {
    const h = new Uint8Array(512);
    const put = (off, s) => h.set(new TextEncoder().encode(s), off);
    put(0, fields.name);
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, fields.size.toString(8).padStart(11, "0") + "\0");
    put(136, "00000000000\0");
    put(156, fields.type);
    put(257, "ustar\0");
    put(263, "00");
    let sum = 0;
    for (let i = 148; i < 156; i++) h[i] = 0x20;
    for (const b of h) sum += b;
    put(148, sum.toString(8).padStart(6, "0") + "\0 ");
    return h;
  };
  const longName = "sysroot/" + "d/".repeat(60) + "file.txt";
  const record = ` path=${longName}\n`;
  const paxBody = new TextEncoder().encode(`${record.length + String(record.length + 2).length} path=${longName}\n`);
  const paxData = new Uint8Array(512);
  paxData.set(paxBody);
  const content = new TextEncoder().encode("payload");
  const contentBlock = new Uint8Array(512);
  contentBlock.set(content);
  const tar = new Uint8Array(512 * 6);
  tar.set(block({ name: "PaxHeader/file.txt", size: paxBody.length, type: "x" }), 0);
  tar.set(paxData, 512);
  tar.set(block({ name: "sysroot/truncated", size: content.length, type: "0" }), 1024);
  tar.set(contentBlock, 1536);
  const entries = parseTar(tar);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, longName);
  assert.equal(new TextDecoder().decode(entries[0].data), "payload");
});

test("parseDriverCommands reads clang -### output with escapes", () => {
  const text = [
    "clang version 23.1.4",
    "Target: arm-none-unknown-eabi",
    " (in-process)",
    ' "/sysroot/bin/llvm" clang -cc1 -triple thumbv6m-none-unknown-eabi "-D" "A=\\"q\\"" "x.c"',
    ' "/sysroot/bin/ld.lld" "-m" "armelf" "-EL" "-Bstatic" "--fat-lto-objects" "-plugin-opt=mcpu=cortex-m0plus" "-o" "a b.elf"',
    "",
  ].join("\n");
  const commands = parseDriverCommands(text);
  assert.equal(commands.length, 1, "only fully quoted lines are commands");
  assert.deepEqual(normalizeCommand(commands[0]), ["ld.lld", "-m", "armelf", "-EL", "-Bstatic", "--fat-lto-objects", "-plugin-opt=mcpu=cortex-m0plus", "-o", "a b.elf"]);
  const quoted = parseDriverCommands(' "/sysroot/bin/llvm" "clang" "-cc1" "-D" "A=\\"q\\"" "x\\\\y.c"');
  assert.deepEqual(normalizeCommand(quoted[0]), ["clang", "-cc1", "-D", 'A="q"', "x\\y.c"]);
});

test("padChecksum matches Klipper's pad_checksum -s 0xffffffff", () => {
  // Reference: pad_checksum -s 0xffffffff on the bytes 0..99 ends in b2 40 4c fe.
  const input = new Uint8Array(100).map((_, i) => i);
  const { bytes, asm } = padChecksum(input, "sample.bin", 256, 0xffffffff);
  assert.equal(bytes.length, 256);
  assert.deepEqual([...bytes.subarray(252)], [0xb2, 0x40, 0x4c, 0xfe]);
  assert.ok(asm.startsWith("// Padded and checksummed version of: sample.bin\n\n.cpu cortex-m0plus\n.thumb\n\n.section .boot2, \"ax\"\n\n.byte 0x00, 0x01"));
  assert.ok(asm.trimEnd().endsWith("0xb2, 0x40, 0x4c, 0xfe"));
  assert.throws(() => padChecksum(new Uint8Array(253), "x"), /limit is 252/);
});

test("the small parsers", () => {
  assert.equal(symbolAddress("20024000 A _stack_end\n08002194 T ResetHandler\n", "ResetHandler"), 0x08002194);
  const usage = parseMemoryUsage("Memory region         Used Size  Region Size  %age Used\n             rom:        1256 B       128 KB      0.96%\n             ram:         832 B       144 KB      0.56%\n");
  assert.deepEqual(usage, { rom: { used: 1256, size: 131072 }, ram: { used: 832, size: 147456 } });
  const hex = ":020000040800F2\n:1020000000400220952100089D21000800000000EA\n:00000001FF\n";
  const segments = parseIhex(hex);
  const seg = segments.get(0x08002000);
  assert.ok(seg, "segment at the application address");
  assert.equal(seg.readUInt32LE(0), 0x20024000);
});
