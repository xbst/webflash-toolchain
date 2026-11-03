// The smoke test of SPEC section 8.5, run by `node --test tests/smoke.test.mjs`
// against a dist directory or an unpacked release:
//
//   WEBFLASH_TOOLCHAIN_DIR   directory holding manifest.json, llvm.js, llvm.wasm.gz, sysroot.tar.gz
//   WEBFLASH_TEST_SOURCES    output of scripts/fetch-test-sources.sh (optional: the
//                            Klipper and pico-sdk cases are skipped without it)
//   WEBFLASH_REPORT          where the timing and memory report is written
//
// Every tool invocation goes through toolchain.js exactly as the site's
// workers will use it. The test fails when a Klipper file takes more than
// 3 s to compile or an instance grows past 1 GB.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createToolchain, parseDriverCommands, normalizeCommand } from "../src/toolchain.js";
import {
  elfMachine, isElf, padChecksum, parseAutoconf, parseIhex, parseMemoryUsage, readTree, symbolAddress, u32,
} from "./support.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const DIR = process.env.WEBFLASH_TOOLCHAIN_DIR || "";
const SRC = process.env.WEBFLASH_TEST_SOURCES || "";
const REPORT = process.env.WEBFLASH_REPORT || join(HERE, "..", "build", "smoke-report.json");
const KLIPPER = join(SRC, "klipper");

const haveToolchain = !!DIR && existsSync(join(DIR, "manifest.json"));
const haveSources = !!SRC && existsSync(join(KLIPPER, "src", "sched.c"));
if (!haveToolchain && process.env.CI) {
  throw new Error("WEBFLASH_TOOLCHAIN_DIR is not set or has no manifest.json");
}
const skip = haveToolchain ? false : "WEBFLASH_TOOLCHAIN_DIR is not set; nothing to test";
const skipSources = haveSources ? false : "WEBFLASH_TEST_SOURCES has no Klipper clone (run scripts/fetch-test-sources.sh)";

const LIMIT_MS = 3000;
const LIMIT_MEMORY = 1 << 30;
const CWD = "/work";

// Klipper's CFLAGS (top-level Makefile) translated per SPEC section 9.4:
// -flto=auto -fwhole-program -fno-use-linker-plugin -> -flto -ffat-lto-objects, -ggdb3 -> -g,
// plus -mfloat-abi=soft: GCC's arm-none-eabi default is soft float, while clang
// without the flag enables the FPU instructions of cortex-m4/m7/m33 (soft ABI).
const KLIPPER_CFLAGS = [
  "-iquote", "out/", "-iquote", "src", "-iquote", "out/board-generic/", "-MD", "-Wall", "-Wtype-limits",
  "-ffunction-sections", "-fdata-sections", "-fno-delete-null-pointer-checks",
  "-flto", "-ffat-lto-objects", "-g", "-Os", "-mfloat-abi=soft",
];
const CONLYFLAGS = ["-std=gnu11", "-Wold-style-definition", "-Wno-unknown-warning-option"];
// src/stm32/Makefile for STM32G0B1 and src/rp2040/Makefile for RP2040.
const STM32G0_FLAGS = ["-mcpu=cortex-m0plus", "-Ilib/stm32g0/include", "-DSTM32G0B1xx", "-mthumb", "-Ilib/cmsis-core", "-Ilib/fast-hash"];
const RP2040_FLAGS = [
  "-mcpu=cortex-m0plus", "-DPICO_RP2040", "-mthumb", "-Ilib/cmsis-core", "-Ilib/pico-sdk/rp2040", "-Ilib/pico-sdk",
  "-Ilib/pico-sdk/rp2040/cmsis_include", "-Ilib/fast-hash", "-Ilib/can2040",
];

let tc;
let manifest;
let sysInc = [];
let sysIncCxx = [];
const report = {
  toolchain: null,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  klipper: haveSources && existsSync(join(SRC, "klipper-commit.txt")) ? readFileSync(join(SRC, "klipper-commit.txt"), "utf8").trim() : null,
  limits: { compileMs: LIMIT_MS, memoryBytes: LIMIT_MEMORY },
  runs: [],
  peakMemoryBytes: 0,
  driverSelectedMultilibs: {},
  linkCommands: {},
  reuse: null,
};
const objects = new Map();

function fixture(name) {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

function autoconf(cfg) {
  const generated = join(SRC, `out-${cfg}`, "autoconf.h");
  return haveSources && existsSync(generated) ? new Uint8Array(readFileSync(generated)) : fixture(`autoconf-${cfg}.h`);
}

function libDirFor(cpu) {
  for (const [variant, entry] of Object.entries(manifest.multilibs)) {
    if (entry.cpus.includes(cpu)) return { variant, lib: "/" + entry.lib };
  }
  throw new Error(`no multilib for ${cpu}`);
}

/** Run a tool, record its time and memory, assert it succeeded. */
async function ok(name, spec, { reuse = false } = {}) {
  const r = await (reuse ? tc.runReusing(spec) : tc.run(spec));
  report.runs.push({ name, tool: spec.argv[0], ms: Math.round(r.time), memoryBytes: r.memory, reuse });
  report.peakMemoryBytes = Math.max(report.peakMemoryBytes, r.memory);
  assert.equal(r.code, 0, `${name}: ${spec.argv.join(" ")}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  assert.ok(r.memory < LIMIT_MEMORY, `${name}: instance memory ${r.memory} bytes exceeds the 1 GB limit`);
  return r;
}

function expectOutput(r, path) {
  const data = r.outputs.get(path);
  assert.ok(data, `expected ${path} in outputs, got ${[...r.outputs.keys()].join(", ") || "nothing"}`);
  return data;
}

before(async () => {
  if (!haveToolchain) return;
  tc = await createToolchain({ manifestUrl: pathToFileURL(join(DIR, "manifest.json")).href, verify: true });
  manifest = tc.manifest;
  sysInc = manifest.include.flatMap((p) => ["-isystem", "/" + p]);
  sysIncCxx = (manifest.include_cxx || []).flatMap((p) => ["-isystem", "/" + p]);
  report.toolchain = { id: manifest.id, llvm: manifest.llvm, atfe: manifest.atfe, emscripten: manifest.emscripten };
});

after(() => {
  if (!haveToolchain) return;
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
  console.log(`report written to ${REPORT}`);
});

test("manifest is complete and matches SPEC 8.3", { skip }, () => {
  assert.equal(manifest.schema, 1);
  assert.match(manifest.id, /^llvm\d+\.\d+\.\d+-atfe\d+\.\d+\.\d+-build\d+$/);
  assert.equal(manifest.id, `llvm${manifest.llvm}-atfe${manifest.atfe}-build${manifest.build}`);
  for (const name of ["llvm.wasm.gz", "llvm.js", "toolchain.js", "sysroot.tar.gz"]) {
    assert.ok(manifest.files[name]?.size > 0, `${name} listed with a size`);
    assert.match(manifest.files[name].sha256, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(manifest.tools, ["clang", "clang++", "ld.lld", "llvm-objcopy", "llvm-objdump", "llvm-readelf", "llvm-ar", "llvm-nm", "llvm-strip", "llvm-size"]);
  const served = Object.values(manifest.multilibs).flatMap((m) => m.cpus);
  for (const cpu of ["cortex-m0", "cortex-m0plus", "cortex-m3", "cortex-m4", "cortex-m7", "cortex-m33"]) {
    assert.ok(served.includes(cpu), `${cpu} has a multilib`);
  }
  assert.ok(manifest.include.length >= 2);
  assert.ok(Object.keys(manifest.licenses).length >= 3);
  assert.ok(tc.sysrootEntries > 100, "the sysroot tar has entries");
});

test("every tool answers --version", { skip }, async () => {
  const expected = {
    "clang": `clang version ${manifest.llvm}`,
    "clang++": `clang version ${manifest.llvm}`,
    "ld.lld": `LLD ${manifest.llvm}`,
  };
  for (const tool of manifest.tools) {
    const r = await ok(`${tool} --version`, { argv: [tool, "--version"] });
    const text = r.stdout + r.stderr;
    const want = expected[tool] || manifest.llvm;
    assert.ok(text.includes(want), `${tool} --version should mention ${want}:\n${text}`);
  }
});

test("clang finds its resource directory and ld.lld by itself", { skip }, async () => {
  const r = await ok("clang -print-resource-dir", { argv: ["clang", "-print-resource-dir"] });
  assert.equal(r.stdout.trim(), `/sysroot/lib/clang/${manifest.llvm.split(".")[0]}`);
  const l = await ok("clang -print-prog-name=ld.lld", { argv: ["clang", "-print-prog-name=ld.lld"] });
  assert.equal(l.stdout.trim(), "/sysroot/bin/ld.lld");
  // Which ATfE library variant clang's own multilib.yaml logic selects per CPU
  // (informational: the engine passes -L and -isystem from the manifest).
  for (const cpu of ["cortex-m0plus", "cortex-m3", "cortex-m4", "cortex-m7", "cortex-m33"]) {
    const p = await tc.run({
      argv: ["clang", "--target=arm-none-eabi", `-mcpu=${cpu}`, "-mthumb", "-mfloat-abi=soft", "-###", "-c", "x.c", "-o", "x.o"],
      cwd: CWD, files: new Map([["/work/x.c", "int x;\n"]]),
    });
    const m = /clang-runtimes\/arm-none-eabi\/([^/"]+)\/include/.exec(p.stderr);
    report.driverSelectedMultilibs[cpu] = m ? m[1] : null;
  }
});

for (const cpu of ["cortex-m0plus", "cortex-m4", "cortex-m33"]) {
  for (const lto of [false, true]) {
    const label = `${cpu}${lto ? " with LTO" : ""}`;
    test(`compile vectors.c for ${label}`, { skip }, async () => {
      const out = `out/vectors-${cpu}${lto ? "-lto" : ""}.o`;
      const argv = [
        "clang", "--target=arm-none-eabi", `-mcpu=${cpu}`, "-mthumb", "-mfloat-abi=soft", "-Os", "-g", "-ffunction-sections", "-fdata-sections",
        ...(lto ? ["-flto", "-ffat-lto-objects"] : []), ...CONLYFLAGS, ...sysInc, "-c", "vectors.c", "-o", out,
      ];
      const r = await ok(`compile vectors.c ${label}`, { argv, cwd: CWD, files: new Map([["/work/vectors.c", fixture("vectors.c")]]), dirs: ["out"] });
      const obj = expectOutput(r, `${CWD}/${out}`);
      assert.ok(isElf(obj) && elfMachine(obj) === 0x28, "an ARM ELF object");
      objects.set(`${cpu}:${lto}`, obj);
    });
  }
}

test("clang -E -P preprocesses Klipper's armcm_link.lds.S", { skip }, async () => {
  const files = new Map([["/work/src/generic/armcm_link.lds.S", fixture("armcm_link.lds.S")], ["/work/out/autoconf.h", autoconf("stm32g0b1")]]);
  const r = await ok("preprocess armcm_link.lds.S", {
    argv: ["clang", "--target=arm-none-eabi", "-E", "-P", "-x", "assembler-with-cpp", "-Iout", "src/generic/armcm_link.lds.S", "-o", "out/src/generic/armcm_link.ld"],
    cwd: CWD, files, dirs: ["out/src/generic"],
  });
  const ld = new TextDecoder().decode(expectOutput(r, "/work/out/src/generic/armcm_link.ld"));
  assert.match(ld, /rom \(rx\) : ORIGIN = 0x8002000 , LENGTH = 0x20000/);
  assert.ok(!ld.includes("#include"), "no preprocessor lines remain");
  objects.set("armcm_link.ld", new TextEncoder().encode(ld));
});

for (const lto of [false, true]) {
  const label = lto ? "with LTO" : "without LTO";
  test(`link ${label} through clang -### and directly with ld.lld, then objcopy`, { skip }, async () => {
    const cpu = "cortex-m0plus";
    const obj = objects.get(`${cpu}:${lto}`);
    const ld = objects.get("armcm_link.ld");
    assert.ok(obj && ld, "earlier tests produced the object and the linker script");
    const config = parseAutoconf(new TextDecoder().decode(autoconf("stm32g0b1")));
    const stackEnd = (config.CONFIG_RAM_START + config.CONFIG_RAM_SIZE) >>> 0;
    const { lib, variant } = libDirFor(cpu);
    const files = new Map([["/work/out/vectors.o", obj], ["/work/out/armcm_link.ld", ld]]);

    // (a) the GCC-style link line of Klipper's Makefile translated per 9.4,
    //     given to clang -###, whose printed ld.lld command is then run.
    const driverArgv = [
      "clang", "--target=arm-none-eabi", `-mcpu=${cpu}`, "-mthumb", "-mfloat-abi=soft", "-nostdlib",
      ...(lto ? ["-flto", "-ffat-lto-objects"] : []),
      "out/vectors.o", "-T", "out/armcm_link.ld", "-Wl,--gc-sections", "-Wl,--print-memory-usage",
      `-L${lib}`, "-lc", "-lclang_rt.builtins", "-lc", "-Wl,-u,VectorTable", "-o", "out/a.elf",
    ];
    const probe = await ok(`clang -### link ${label}`, { argv: [driverArgv[0], "-###", ...driverArgv.slice(1)], cwd: CWD, files });
    const commands = parseDriverCommands(probe.stderr).map(normalizeCommand);
    const link = commands.find((c) => c[0] === "ld.lld");
    assert.ok(link, `clang -### printed an ld.lld command:\n${probe.stderr}`);
    report.linkCommands[lto ? "lto" : "plain"] = link;
    if (lto) {
      assert.ok(link.includes("--fat-lto-objects"), "LTO link uses the bitcode of the fat objects");
      assert.ok(link.some((a) => a.startsWith("-plugin-opt=mcpu=")), "LTO link carries the cpu");
    }
    const a = await ok(`ld.lld (from -###) ${label}`, { argv: link, cwd: CWD, files });
    const elfA = expectOutput(a, "/work/out/a.elf");
    const usage = parseMemoryUsage(a.stdout);
    assert.ok(usage.rom?.used > 0 && usage.ram?.used > 0, `--print-memory-usage table:\n${a.stdout}`);

    // (b) a directly constructed ld.lld line (what the engine may use instead).
    const direct = [
      "ld.lld", "-m", "armelf", "-EL", "-Bstatic",
      ...(lto ? ["--fat-lto-objects", `-plugin-opt=mcpu=${cpu}`, "--lto-O2"] : []),
      "out/vectors.o", "-T", "out/armcm_link.ld", "--gc-sections", "--print-memory-usage",
      `-L${lib}`, "-lc", "-lclang_rt.builtins", "-lc", "-u", "VectorTable", "--target2=rel", "-o", "out/b.elf",
    ];
    const b = await ok(`ld.lld (direct) ${label}`, { argv: direct, cwd: CWD, files });
    const elfB = expectOutput(b, "/work/out/b.elf");
    assert.equal(elfB.length, elfA.length, "both link forms give the same size");

    // The vector table: word 0 is the initial stack pointer, word 1 the reset
    // handler with the Thumb bit; objcopy to binary and to Intel HEX agree.
    const elfFiles = new Map([["/work/out/a.elf", elfA]]);
    const nm = await ok(`llvm-nm ${label}`, { argv: ["llvm-nm", "out/a.elf"], cwd: CWD, files: elfFiles });
    const reset = symbolAddress(nm.stdout, "ResetHandler");
    assert.ok(reset !== undefined, `ResetHandler in nm output:\n${nm.stdout}`);
    assert.equal(symbolAddress(nm.stdout, "_stack_end"), stackEnd);
    const bin = expectOutput(await ok(`objcopy -O binary ${label}`, { argv: ["llvm-objcopy", "-O", "binary", "out/a.elf", "out/a.bin"], cwd: CWD, files: elfFiles }), "/work/out/a.bin");
    assert.equal(u32(bin, 0), stackEnd, "word 0 is the stack address");
    assert.equal(u32(bin, 4), (reset | 1) >>> 0, "word 1 is ResetHandler with the Thumb bit");
    assert.ok(bin.length < config.CONFIG_FLASH_SIZE);
    const hexText = new TextDecoder().decode(expectOutput(await ok(`objcopy -O ihex ${label}`, { argv: ["llvm-objcopy", "-O", "ihex", "out/a.elf", "out/a.hex"], cwd: CWD, files: elfFiles }), "/work/out/a.hex"));
    const segments = parseIhex(hexText);
    const first = segments.get(config.CONFIG_FLASH_APPLICATION_ADDRESS);
    assert.ok(first, `ihex starts at the application address: ${[...segments.keys()].map((k) => k.toString(16))}`);
    assert.equal(u32(first, 0), stackEnd);

    // The remaining tools on the same ELF.
    const size = await ok(`llvm-size ${label}`, { argv: ["llvm-size", "out/a.elf"], cwd: CWD, files: elfFiles });
    assert.match(size.stdout, /text\s+data\s+bss/);
    const readelf = await ok(`llvm-readelf ${label}`, { argv: ["llvm-readelf", "-h", "-S", "out/a.elf"], cwd: CWD, files: elfFiles });
    assert.match(readelf.stdout, /Machine:\s+ARM/);
    // Klipper's script folds .vector_table into .text at the application address.
    assert.match(readelf.stdout, new RegExp(String.raw`\.text\s+PROGBITS\s+0*${config.CONFIG_FLASH_APPLICATION_ADDRESS.toString(16)}\b`));
    const objdump = await ok(`llvm-objdump ${label}`, { argv: ["llvm-objdump", "-d", "out/a.elf"], cwd: CWD, files: elfFiles });
    assert.match(objdump.stdout, /<ResetHandler>:/);
    const stripped = expectOutput(await ok(`llvm-strip ${label}`, { argv: ["llvm-strip", "out/a.elf", "-o", "out/a.stripped.elf"], cwd: CWD, files: elfFiles }), "/work/out/a.stripped.elf");
    assert.ok(stripped.length < elfA.length, "stripping removed the debug info");
    const ar = await ok(`llvm-ar ${label}`, { argv: ["llvm-ar", "rcs", "out/libvectors.a", "out/vectors.o"], cwd: CWD, files });
    const archive = expectOutput(ar, "/work/out/libvectors.a");
    assert.ok(new TextDecoder().decode(archive.subarray(0, 8)) === "!<arch>\n");
    report.linkCommands[`${lto ? "lto" : "plain"}-variant`] = variant;
  });
}

test("rp2040 stage2: boot2_w25q080.S through boot_stage2.ld, pad_checksum, and a link with rpxxxx_link.lds.S", { skip: skip || skipSources }, async () => {
  const files = new Map();
  readTree(files, join(KLIPPER, "lib", "pico-sdk"), "/work/lib/pico-sdk");
  readTree(files, join(KLIPPER, "lib", "cmsis-core"), "/work/lib/cmsis-core");
  readTree(files, join(KLIPPER, "src", "rp2040"), "/work/src/rp2040");
  readTree(files, join(KLIPPER, "src", "generic"), "/work/src/generic");
  files.set("/work/out/autoconf.h", autoconf("rp2040"));
  files.set("/work/out/board", { symlink: "/work/src/rp2040" });
  files.set("/work/out/board-generic/board", { symlink: "/work/src/generic" });
  files.set("/work/vectors.c", fixture("vectors.c"));
  const config = parseAutoconf(new TextDecoder().decode(autoconf("rp2040")));
  const cflags = ["clang", "--target=arm-none-eabi", ...KLIPPER_CFLAGS, ...RP2040_FLAGS, ...sysInc];
  const stage2Src = `lib/pico-sdk/rp2040/boot_stage2/${config.CONFIG_RP2040_STAGE2_FILE}`;

  // The five commands of src/rp2040/Makefile's $(OUT)stage2.o rule.
  const c1 = await ok("stage2: assemble boot2", {
    argv: [...cflags, "-Ilib/pico-sdk/rp2040/boot_stage2", "-Ilib/pico-sdk/rp2040/boot_stage2/asminclude",
      `-DPICO_FLASH_SPI_CLKDIV=${config.CONFIG_RP2040_STAGE2_CLKDIV}`, "-c", stage2Src, "-o", "out/stage2raw1.o"],
    cwd: CWD, files,
  });
  files.set("/work/out/stage2raw1.o", expectOutput(c1, "/work/out/stage2raw1.o"));
  const c2 = await ok("stage2: ld.lld --script boot_stage2.ld", {
    argv: ["ld.lld", "out/stage2raw1.o", "--script=lib/pico-sdk/rp2040/boot_stage2/boot_stage2.ld", "-o", "out/stage2raw.o"], cwd: CWD, files,
  });
  files.set("/work/out/stage2raw.o", expectOutput(c2, "/work/out/stage2raw.o"));
  const c3 = await ok("stage2: objcopy -O binary", { argv: ["llvm-objcopy", "-O", "binary", "out/stage2raw.o", "out/stage2raw.bin"], cwd: CWD, files });
  const raw = expectOutput(c3, "/work/out/stage2raw.bin");
  assert.ok(raw.length > 0 && raw.length <= 252, `stage2 is ${raw.length} bytes (limit 252)`);
  const padded = padChecksum(raw, "out/stage2raw.bin", 256, 0xffffffff);
  files.set("/work/out/stage2.S", new TextEncoder().encode(padded.asm));
  const c5 = await ok("stage2: assemble stage2.S", { argv: [...cflags, "-c", "out/stage2.S", "-o", "out/stage2.o"], cwd: CWD, files });
  files.set("/work/out/stage2.o", expectOutput(c5, "/work/out/stage2.o"));
  const sections = await ok("stage2: readelf -S", { argv: ["llvm-readelf", "-S", "out/stage2.o"], cwd: CWD, files });
  assert.match(sections.stdout, /\.boot2\s+PROGBITS\s+\S+\s+\S+\s+000100/);

  // A whole image: the stage2 plus a vector-table program through rpxxxx_link.lds.S.
  const ldr = await ok("rp2040: preprocess rpxxxx_link.lds.S", {
    argv: ["clang", "--target=arm-none-eabi", "-E", "-P", "-x", "assembler-with-cpp", "-Iout", "src/rp2040/rpxxxx_link.lds.S", "-o", "out/src/rp2040/rpxxxx_link.ld"],
    cwd: CWD, files, dirs: ["out/src/rp2040"],
  });
  files.set("/work/out/src/rp2040/rpxxxx_link.ld", expectOutput(ldr, "/work/out/src/rp2040/rpxxxx_link.ld"));
  const vo = await ok("rp2040: compile vectors.c", { argv: [...cflags, ...CONLYFLAGS, "-c", "vectors.c", "-o", "out/vectors.o"], cwd: CWD, files });
  files.set("/work/out/vectors.o", expectOutput(vo, "/work/out/vectors.o"));
  const { lib } = libDirFor("cortex-m0plus");
  const link = await tc.runLinkViaDriver({
    argv: ["clang", "--target=arm-none-eabi", "-mcpu=cortex-m0plus", "-mthumb", "-mfloat-abi=soft", "-nostdlib", "-flto", "-ffat-lto-objects",
      "out/vectors.o", "out/stage2.o", "-T", "out/src/rp2040/rpxxxx_link.ld", "-Wl,--gc-sections", "-Wl,--print-memory-usage",
      `-L${lib}`, "-lc", "-lclang_rt.builtins", "-lc", "-Wl,-u,VectorTable", "-o", "out/klipper.elf"],
    cwd: CWD, files,
  });
  report.runs.push({ name: "rp2040: link via driver", tool: "ld.lld", ms: Math.round(link.time), memoryBytes: link.memory });
  assert.equal(link.code, 0, `rp2040 link:\n${link.stdout}\n${link.stderr}`);
  files.set("/work/out/klipper.elf", expectOutput(link, "/work/out/klipper.elf"));
  const bin = expectOutput(await ok("rp2040: objcopy -O binary", { argv: ["llvm-objcopy", "-O", "binary", "out/klipper.elf", "out/klipper.bin"], cwd: CWD, files }), "/work/out/klipper.bin");
  assert.deepEqual([...bin.subarray(0, 256)], [...padded.bytes], "the image starts with the padded, checksummed stage2");
  const stackEnd = (config.CONFIG_RAM_START + config.CONFIG_RAM_SIZE) >>> 0;
  assert.equal(u32(bin, 256), stackEnd, "the vector table follows the stage2");
  assert.equal(u32(bin, 260) & 1, 1, "reset handler has the Thumb bit");
});

test("real Klipper files for stm32g0b1 compile within the limits", { skip: skip || skipSources }, async () => {
  const files = new Map();
  readTree(files, join(KLIPPER, "src"), "/work/src");
  readTree(files, join(KLIPPER, "lib", "cmsis-core"), "/work/lib/cmsis-core");
  readTree(files, join(KLIPPER, "lib", "stm32g0", "include"), "/work/lib/stm32g0/include");
  readTree(files, join(KLIPPER, "lib", "fast-hash"), "/work/lib/fast-hash");
  files.set("/work/out/autoconf.h", autoconf("stm32g0b1"));
  files.set("/work/out/board", { symlink: "/work/src/stm32" });
  files.set("/work/out/board-generic/board", { symlink: "/work/src/generic" });
  const slow = [];
  for (const src of ["src/sched.c", "src/command.c", "src/generic/armcm_boot.c", "src/stm32/stm32g0.c"]) {
    const obj = `out/${src.replace(/\.c$/, ".o")}`;
    const r = await ok(`klipper: ${src}`, {
      argv: ["clang", "--target=arm-none-eabi", ...KLIPPER_CFLAGS, ...STM32G0_FLAGS, ...CONLYFLAGS, ...sysInc, "-c", src, "-o", obj],
      cwd: CWD, files, dirs: [obj.slice(0, obj.lastIndexOf("/"))],
    });
    const o = expectOutput(r, `/work/${obj}`);
    assert.ok(isElf(o), `${obj} is an ELF object`);
    expectOutput(r, `/work/${obj.replace(/\.o$/, ".d")}`);
    if (r.time > LIMIT_MS) slow.push(`${src}: ${Math.round(r.time)} ms`);
    // Klipper reads the .compile_time_request section of every fat object.
    const ctr = await ok(`klipper: ${src} .compile_time_request`, {
      argv: ["llvm-objcopy", "-j", ".compile_time_request", "-O", "binary", obj, `${obj}.ctr`], cwd: CWD,
      files: new Map([[`/work/${obj}`, o]]),
    });
    assert.ok(expectOutput(ctr, `/work/${obj}.ctr`).length > 0, `${src} has compile-time requests`);
  }
  assert.deepEqual(slow, [], `files over the ${LIMIT_MS} ms limit`);
});

test("clang++ compiles with the libc++ headers", { skip }, async () => {
  const source = "#include <optional>\n#include <cmath>\n#include <cstdint>\n#include <numbers>\n"
    + "extern \"C\" int probe(float x) { std::optional<float> v = x; return v ? (int)(std::sqrt(*v) * std::numbers::pi) : 0; }\n";
  const r = await ok("clang++ with <optional>", {
    argv: ["clang++", "--target=arm-none-eabi", "-mcpu=cortex-m4", "-mthumb", "-mfloat-abi=soft", "-Os", "-std=c++20", "-fno-rtti", "-fno-exceptions",
      "-ffunction-sections", "-fdata-sections", ...sysIncCxx, ...sysInc, "-c", "probe.c++", "-o", "out/probe.o"],
    cwd: CWD, files: new Map([["/work/probe.c++", source]]), dirs: ["out"],
  });
  assert.ok(isElf(expectOutput(r, "/work/out/probe.o")));
});

test("100 consecutive compiles on one instance versus fresh instances", { skip }, async () => {
  const files = new Map([["/work/vectors.c", fixture("vectors.c")]]);
  const argvFor = (cpu) => ["clang", "--target=arm-none-eabi", `-mcpu=${cpu}`, "-mthumb", "-mfloat-abi=soft", "-Os", "-g", "-ffunction-sections", "-fdata-sections", "-flto", "-ffat-lto-objects", ...CONLYFLAGS, ...sysInc, "-c", "vectors.c", "-o", "out/v.o"];
  const cpus = ["cortex-m0plus", "cortex-m4", "cortex-m33"];
  const reference = {};
  const freshTimes = [];
  for (let i = 0; i < 12; i++) {
    const cpu = cpus[i % 3];
    const r = await tc.run({ argv: argvFor(cpu), cwd: CWD, files, dirs: ["out"] });
    assert.equal(r.code, 0, r.stderr);
    freshTimes.push(r.time);
    reference[cpu] ??= r.outputs.get("/work/out/v.o");
  }
  let failures = 0;
  let mismatches = 0;
  const reuseTimes = [];
  let memory = 0;
  for (let i = 0; i < 100; i++) {
    const cpu = cpus[i % 3];
    try {
      const r = await tc.runReusing({ argv: argvFor(cpu), cwd: CWD, files, dirs: ["out"] });
      reuseTimes.push(r.time);
      memory = Math.max(memory, r.memory);
      if (r.code !== 0) failures++;
      else if (Buffer.compare(Buffer.from(r.outputs.get("/work/out/v.o") || []), Buffer.from(reference[cpu])) !== 0) mismatches++;
    } catch (e) {
      failures++;
      reuseTimes.push(NaN);
    }
  }
  const avg = (xs) => Math.round(xs.filter(Number.isFinite).reduce((a, b) => a + b, 0) / Math.max(1, xs.filter(Number.isFinite).length));
  report.reuse = { runs: 100, failures, mismatches, avgMsReused: avg(reuseTimes), avgMsFresh: avg(freshTimes), memoryBytesReused: memory, stable: failures === 0 && mismatches === 0 };
  report.peakMemoryBytes = Math.max(report.peakMemoryBytes, memory);
  console.log(`reuse: ${JSON.stringify(report.reuse)}`);
  tc.dispose();
  assert.ok(true, "measured; see the report (a long-lived instance is optional)");
});
