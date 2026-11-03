// toolchain.js: runs the WebFlash LLVM toolchain (clang, clang++, ld.lld,
// llvm-objcopy, llvm-objdump, llvm-readelf, llvm-ar, llvm-nm, llvm-strip,
// llvm-size, built to WebAssembly as one multicall module) in a Web Worker or
// in Node. ES module, no dependencies.
//
//   import { createToolchain } from "./toolchain.js";
//   const tc = await createToolchain({ manifestUrl: ".../toolchain/<id>/manifest.json" });
//   const r = await tc.run({
//     argv: ["clang", "--target=arm-none-eabi", "-mcpu=cortex-m0plus", "-mthumb", "-c", "src/a.c", "-o", "out/a.o"],
//     cwd: "/work",
//     files: new Map([["/work/src/a.c", bytes], ["/work/out/board", { symlink: "/work/src/stm32" }]]),
//   });
//   r.code, r.stdout, r.stderr, r.outputs (Map<absolute path, Uint8Array> of every file under cwd the tool created)
//
// Model (SPEC section 8.2): the WebAssembly.Module is compiled once; every
// run() instantiates it afresh, mounts the sysroot and the given files into
// the instance's MEMFS, calls main() with argv and reads the outputs back.
// LLVM's global state is not reusable across main() calls, which is why a
// fresh instance is the default; runReusing() keeps one instance alive so the
// two models can be measured against each other.
//
// Files given to run() are mounted read-only without copying (the instance
// keeps a view of your Uint8Array), so a tool cannot modify an input in place;
// every output is a new file. The sysroot tarball is mounted the same way and
// shared by all instances.
//
// Copyright (C) 2026 Isik's Tech. This file is GPL-3.0; the module it runs is
// LLVM (Apache-2.0 with LLVM exception) and the sysroot carries picolibc's
// and compiler-rt's licenses, listed in manifest.licenses.

const DEFAULT_PROGRAM = "/sysroot/bin/llvm";
const DEFAULT_CWD = "/work";
const EXIT_ABORT = 134;

/**
 * Load a toolchain release described by manifest.json.
 *
 * options.manifestUrl   URL (string or URL) of manifest.json; llvm.js, llvm.wasm.gz
 *                       and sysroot.tar.gz are fetched relative to it
 * options.fetch         fetch-compatible function (default: globalThis.fetch;
 *                       file: URLs are read from disk under Node)
 * options.importModule  async (url) => module, default dynamic import()
 * options.verify        check the sha256 of every downloaded file (default false;
 *                       sizes are always checked)
 * options.onProgress    ({file, loaded, total}) => void while downloading
 * options.prefetchCxx   also fetch the libc++ headers now (default: on first clang++ run)
 */
export async function createToolchain(options = {}) {
  const {
    manifestUrl,
    fetch: fetchOption,
    importModule = defaultImport,
    verify = false,
    onProgress = null,
    prefetchCxx = false,
  } = options;
  if (!manifestUrl) throw new Error("createToolchain: manifestUrl is required");
  const base = new URL(String(manifestUrl), typeof location !== "undefined" ? location.href : undefined);
  const fetchFn = fetchOption || (await defaultFetch(base));
  const urlOf = (name) => new URL(name, base);

  const manifest = await fetchJson(fetchFn, base);
  if (manifest.schema !== 1) throw new Error(`toolchain manifest schema ${manifest.schema} is not supported`);
  const module = manifest.module || {};
  const jsName = module.js || "llvm.js";
  const wasmName = module.wasm || "llvm.wasm.gz";
  const program = module.program || DEFAULT_PROGRAM;
  const tools = new Set(manifest.tools || []);

  const download = async (name) => {
    const expected = manifest.files?.[name];
    const bytes = await fetchBytes(fetchFn, urlOf(name), name, onProgress, expected?.size);
    if (expected && bytes.length !== expected.size) {
      throw new Error(`${name}: downloaded ${bytes.length} bytes, manifest says ${expected.size}`);
    }
    if (verify && expected?.sha256) {
      const digest = await sha256Hex(bytes);
      if (digest !== expected.sha256) throw new Error(`${name}: sha256 mismatch`);
    }
    return bytes;
  };

  const [factory, wasmModule, sysroot] = await Promise.all([
    importModule(urlOf(jsName)).then((m) => {
      const f = m && (module.export && module.export !== "default" ? m[module.export] : m.default);
      if (typeof f !== "function") throw new Error(`${jsName} does not export the module factory`);
      return f;
    }),
    download(wasmName).then(gunzip).then((bytes) => WebAssembly.compile(bytes)),
    download("sysroot.tar.gz").then(gunzip).then(parseTar),
  ]);

  let cxxEntries = null;
  let cxxLoading = null;
  const loadCxx = () => {
    if (!manifest.sysroot_cxx) return Promise.resolve([]);
    cxxLoading ??= download(manifest.sysroot_cxx).then(gunzip).then(parseTar).then((entries) => (cxxEntries = entries));
    return cxxLoading;
  };
  if (prefetchCxx) await loadCxx();

  const needsCxx = (argv) => basename(argv[0]) === "clang++";

  /** Create a fresh instance with the environment and output sinks of one run. */
  async function instantiate(env) {
    const out = new ByteSink();
    const err = new ByteSink();
    let memoryRef = null;
    let failInstantiate;
    const failed = new Promise((_, reject) => (failInstantiate = reject));
    const moduleArgs = {
      thisProgram: program,
      noInitialRun: true,
      noExitRuntime: true,
      instantiateWasm(imports, receive) {
        WebAssembly.instantiate(wasmModule, imports).then(
          (instance) => {
            // Export names inside the wasm are minified, so the memory is found by kind.
            memoryRef = Object.values(instance.exports).find((v) => v instanceof WebAssembly.Memory) ?? imports.env?.memory ?? null;
            receive(instance, wasmModule);
          },
          (e) => failInstantiate(e),
        );
        return {};
      },
      // ENV must be complete before the C runtime builds environ.
      preRun: [() => {
        if (moduleArgs.ENV) Object.assign(moduleArgs.ENV, env);
        else if (Object.keys(env).length) throw new Error("llvm.js does not export ENV; rebuild with -sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV");
      }],
      stdin: () => null,
      stdout: (byte) => out.push(byte),
      stderr: (byte) => err.push(byte),
      print: (text) => out.line(text),
      printErr: (text) => err.line(text),
    };
    const instance = await Promise.race([factory(moduleArgs), failed]);
    if (!instance.FS || typeof instance.callMain !== "function") {
      throw new Error("llvm.js was not built with -sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV");
    }
    // The Module object carries the EXPORTED_FUNCTIONS under their real names.
    const flush = typeof instance._webflash_flush_streams === "function" ? () => instance._webflash_flush_streams() : null;
    return { instance, out, err, flush, memoryBytes: () => memoryRef?.buffer?.byteLength ?? 0 };
  }

  /** Mount the sysroot (and the libc++ headers when loaded) into an instance. */
  function mountSysroot(FS, dirs) {
    mountEntries(FS, sysroot, dirs);
    if (cxxEntries) mountEntries(FS, cxxEntries, dirs);
  }

  /** Write the caller's files (read-only, no copy) and symlinks. */
  function mountFiles(FS, files, cwd, dirs, unlinkExisting) {
    const inputs = new Set();
    for (const [key, value] of files instanceof Map ? files : Object.entries(files)) {
      const path = absolute(key, cwd);
      ensureDir(FS, dirname(path), dirs);
      if (unlinkExisting) {
        try { FS.unlink(path); } catch { /* did not exist */ }
      }
      if (value && typeof value === "object" && "symlink" in value && !(value instanceof Uint8Array)) {
        FS.symlink(String(value.symlink), path);
      } else {
        FS.createDataFile(path, null, toBytes(value), true, false, true);
      }
      inputs.add(path);
    }
    return inputs;
  }

  async function execute(state, { argv, cwd, files, mkdirs, unlinkExisting }) {
    const { instance, out, err, memoryBytes, flush } = state;
    const FS = instance.FS;
    const dirs = state.dirs ??= new Set(["/"]);
    const inputs = mountFiles(FS, files, cwd, dirs, unlinkExisting);
    ensureDir(FS, cwd, dirs);
    for (const dir of mkdirs) ensureDir(FS, absolute(dir, cwd), dirs);
    FS.chdir(cwd);

    const started = now();
    let code;
    try {
      const ret = instance.callMain([basename(argv[0]), ...argv.slice(1)]);
      code = typeof ret === "number" ? ret : 0;
    } catch (e) {
      if (e && typeof e.status === "number") code = e.status;
      else {
        code = EXIT_ABORT;
        err.line(`toolchain.js: ${describeError(e)}`);
      }
    }
    // A tool that ends through exit() (llvm-objcopy --version, for one) leaves
    // LLVM's buffered stdout behind: the module runs no destructors. The
    // build exports webflash_flush_streams() for exactly this.
    try { flush?.(); } catch { /* nothing to flush */ }
    const elapsed = now() - started;

    const outputs = collectOutputs(FS, cwd, inputs);
    if (unlinkExisting) {
      for (const path of inputs) { try { FS.unlink(path); } catch { /* symlink or gone */ } }
      for (const path of outputs.keys()) { try { FS.unlink(path); } catch { /* gone */ } }
    }
    return {
      code,
      stdout: out.text(),
      stderr: err.text(),
      outputs,
      time: elapsed,
      memory: memoryBytes(),
    };
  }

  function checkArgs(argv) {
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string") {
      throw new Error("run: argv must be a non-empty array of strings starting with the tool name");
    }
    const tool = basename(argv[0]);
    if (tools.size && !tools.has(tool)) {
      throw new Error(`run: unknown tool ${tool}; this release has ${[...tools].join(", ")}`);
    }
  }

  /**
   * One tool invocation in a fresh instance.
   *   argv    the tool name and its arguments
   *   cwd     working directory in the instance (created; default /work)
   *   env     environment variables
   *   files   Map or object of path -> Uint8Array | ArrayBuffer | string | {symlink}
   *           (relative paths are taken from cwd; parent directories are created)
   *   dirs    directories to create before the run, for outputs whose parent
   *           no input file creates (clang does not mkdir: -o out/a.o needs out/)
   */
  async function run({ argv, cwd = DEFAULT_CWD, env = {}, files = new Map(), dirs = [] } = {}) {
    checkArgs(argv);
    if (needsCxx(argv)) await loadCxx();
    const state = await instantiate(env);
    mountSysroot(state.instance.FS, (state.dirs = new Set(["/"])));
    return execute(state, { argv, cwd: absolute(cwd, "/"), files, mkdirs: dirs, unlinkExisting: false });
  }

  let reused = null;
  /**
   * One tool invocation on a long-lived instance (created on first use with the
   * env of that first call). Inputs and outputs are removed again after the
   * run, so the instance holds only the sysroot between calls. Use only if the
   * smoke test shows it stable and faster than run().
   */
  async function runReusing({ argv, cwd = DEFAULT_CWD, env = {}, files = new Map(), dirs = [] } = {}) {
    checkArgs(argv);
    if (needsCxx(argv)) await loadCxx();
    if (!reused) {
      reused = await instantiate(env);
      reused.dirs = new Set(["/"]);
      mountSysroot(reused.instance.FS, reused.dirs);
      reused.cxxMounted = !!cxxEntries;
    } else if (cxxEntries && !reused.cxxMounted) {
      mountEntries(reused.instance.FS, cxxEntries, reused.dirs);
      reused.cxxMounted = true;
    }
    reused.out.reset();
    reused.err.reset();
    return execute(reused, { argv, cwd: absolute(cwd, "/"), files, mkdirs: dirs, unlinkExisting: true });
  }

  /**
   * Link through the clang driver without a second process: runs
   * `clang -### <link line>`, takes the linker command it prints and runs
   * that (SPEC 9.4 option a). Returns the linker's result; the driver's own
   * stderr is prepended when the driver failed.
   */
  async function runLinkViaDriver({ argv, ...rest }) {
    const probe = await run({ argv: [argv[0], "-###", ...argv.slice(1)], ...rest });
    const commands = parseDriverCommands(probe.stderr).map(normalizeCommand);
    const link = commands.find((c) => c[0] === "ld.lld" || c[0] === "lld");
    if (probe.code !== 0 || !link) {
      return { ...probe, code: probe.code || 1, stderr: probe.stderr || "clang -### printed no linker command" };
    }
    return run({ argv: link, ...rest });
  }

  return {
    manifest,
    id: manifest.id,
    tools: [...tools],
    sysrootEntries: sysroot.length,
    run,
    runReusing,
    runLinkViaDriver,
    loadCxx,
    dispose() { reused = null; },
  };
}

// ---------------------------------------------------------------------------
// clang -### output

/**
 * Parse the commands `clang -###` prints on stderr: one per line, every
 * argument double-quoted with backslash escapes. Lines that are not commands
 * (the version banner, "(in-process)" markers, diagnostics) are skipped.
 */
export function parseDriverCommands(text) {
  const commands = [];
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith('"')) continue;
    const args = [];
    let i = 0;
    while (i < line.length) {
      while (i < line.length && line[i] === " ") i++;
      if (i >= line.length) break;
      if (line[i] !== '"') { args.length = 0; break; }
      i++;
      let arg = "";
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) i++;
        arg += line[i++];
      }
      if (line[i] !== '"') { args.length = 0; break; }
      i++;
      args.push(arg);
    }
    if (args.length) commands.push(args);
  }
  return commands;
}

/**
 * Turn a printed command into the argv run() expects: drop a leading multicall
 * driver (".../llvm" tool ...) and reduce the tool to its basename.
 */
export function normalizeCommand(argv) {
  const args = [...argv];
  if (args.length > 1 && basename(args[0]) === "llvm") args.shift();
  args[0] = basename(args[0]);
  return args;
}

// ---------------------------------------------------------------------------
// MEMFS helpers

function mountEntries(FS, entries, dirs) {
  for (const entry of entries) {
    const path = "/" + entry.name;
    if (entry.type === "dir") {
      ensureDir(FS, path, dirs);
    } else if (entry.type === "symlink") {
      ensureDir(FS, dirname(path), dirs);
      FS.symlink(entry.linkname, path);
    } else if (entry.type === "file") {
      ensureDir(FS, dirname(path), dirs);
      FS.createDataFile(path, null, entry.data, true, false, true);
      if (entry.mode & 0o111) FS.chmod(path, 0o555);
    }
  }
}

function ensureDir(FS, path, dirs) {
  if (dirs.has(path)) return;
  FS.mkdirTree(path);
  let p = path;
  while (p && !dirs.has(p)) {
    dirs.add(p);
    p = dirname(p);
  }
}

function collectOutputs(FS, cwd, inputs) {
  const outputs = new Map();
  const walk = (dir) => {
    let names;
    try { names = FS.readdir(dir); } catch { return; }
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const path = dir === "/" ? "/" + name : dir + "/" + name;
      const st = FS.lstat(path);
      if (FS.isDir(st.mode)) walk(path);
      else if (FS.isFile(st.mode) && !inputs.has(path)) outputs.set(path, FS.readFile(path));
    }
  };
  walk(cwd);
  return outputs;
}

function absolute(path, cwd) {
  let p = String(path).replace(/\\/g, "/");
  if (!p.startsWith("/")) p = (cwd.endsWith("/") ? cwd : cwd + "/") + p;
  const parts = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function dirname(path) {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function basename(path) {
  const p = String(path);
  return p.slice(p.lastIndexOf("/") + 1);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("files: values must be Uint8Array, ArrayBuffer, string or {symlink}");
}

function describeError(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Collects bytes written to stdout or stderr and runtime messages. */
class ByteSink {
  constructor() { this.reset(); }
  reset() {
    this.buf = new Uint8Array(4096);
    this.len = 0;
    this.lines = [];
  }
  push(byte) {
    if (this.len === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.len++] = byte;
  }
  line(text) { this.lines.push(String(text)); }
  text() {
    let s = new TextDecoder().decode(this.buf.subarray(0, this.len));
    if (this.lines.length) s += (s && !s.endsWith("\n") ? "\n" : "") + this.lines.join("\n") + "\n";
    return s;
  }
}

// ---------------------------------------------------------------------------
// Fetching

async function defaultFetch(base) {
  if (base.protocol === "file:" && typeof process !== "undefined" && process.versions?.node) {
    const fs = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    return async (url) => {
      const data = await fs.readFile(fileURLToPath(new URL(url)));
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return {
        ok: true,
        status: 200,
        body: null,
        arrayBuffer: async () => bytes.slice().buffer,
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    };
  }
  if (typeof globalThis.fetch !== "function") throw new Error("no fetch available; pass options.fetch");
  return globalThis.fetch.bind(globalThis);
}

function defaultImport(url) {
  return import(/* @vite-ignore */ /* webpackIgnore: true */ url.href);
}

async function fetchJson(fetchFn, url) {
  const r = await fetchFn(url.href);
  if (!r.ok) throw new Error(`${url.href}: HTTP ${r.status}`);
  return r.json();
}

async function fetchBytes(fetchFn, url, name, onProgress, total) {
  const r = await fetchFn(url.href);
  if (!r.ok) throw new Error(`${url.href}: HTTP ${r.status}`);
  if (onProgress && r.body && typeof r.body.getReader === "function") {
    const size = total || Number(r.headers?.get?.("content-length")) || 0;
    const chunks = [];
    let loaded = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress({ file: name, loaded, total: size });
    }
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (onProgress) onProgress({ file: name, loaded: bytes.length, total: bytes.length });
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// gzip

/** Decompress a gzip stream: DecompressionStream where available, else the bundled inflate. */
export async function gunzip(bytes) {
  if (typeof DecompressionStream === "function" && typeof Blob === "function" && typeof Response === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return inflateGzip(bytes);
}

/** Pure JavaScript gzip decoder (RFC 1952 + RFC 1951), the fallback of gunzip(). */
export function inflateGzip(src) {
  if (src.length < 18 || src[0] !== 0x1f || src[1] !== 0x8b || src[2] !== 8) throw new Error("not a gzip stream");
  const flags = src[3];
  let p = 10;
  if (flags & 4) p += 2 + (src[p] | (src[p + 1] << 8));
  if (flags & 8) { while (src[p++] !== 0); }
  if (flags & 16) { while (src[p++] !== 0); }
  if (flags & 2) p += 2;
  const n = src.length;
  const isize = (src[n - 4] | (src[n - 3] << 8) | (src[n - 2] << 16) | (src[n - 1] << 24)) >>> 0;
  return inflateRaw(src.subarray(p, n - 8), isize);
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Build a lookup table for canonical Huffman codes: entry = (length << 16) | symbol. */
function huffmanTable(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  if (maxLen === 0) return { table: new Int32Array(1), bits: 1 };
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  const next = new Uint16Array(16);
  for (let len = 1, code = 0; len <= 15; len++) {
    code = (code + counts[len - 1]) << 1;
    next[len] = code;
  }
  const size = 1 << maxLen;
  const table = new Int32Array(size).fill(-1);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    let code = next[len]++;
    let rev = 0;
    for (let i = 0; i < len; i++) { rev = (rev << 1) | (code & 1); code >>= 1; }
    for (let i = rev; i < size; i += 1 << len) table[i] = (len << 16) | sym;
  }
  return { table, bits: maxLen };
}

function inflateRaw(src, sizeHint) {
  let out = new Uint8Array(sizeHint > 0 ? sizeHint : Math.max(1024, src.length * 4));
  let outLen = 0;
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  const need = (n) => {
    while (bitCnt < n) {
      bitBuf |= (pos < src.length ? src[pos] : 0) << bitCnt;
      pos++;
      bitCnt += 8;
    }
  };
  const bits = (n) => {
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h) => {
    need(h.bits);
    const entry = h.table[bitBuf & ((1 << h.bits) - 1)];
    if (entry < 0) throw new Error("inflate: bad Huffman code");
    const len = entry >>> 16;
    bitBuf >>>= len;
    bitCnt -= len;
    return entry & 0xffff;
  };
  const ensure = (n) => {
    if (outLen + n <= out.length) return;
    let size = out.length * 2;
    while (size < outLen + n) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(out.subarray(0, outLen));
    out = bigger;
  };

  let fixedLit = null;
  let fixedDist = null;
  for (;;) {
    const last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored block: drop to a byte boundary, rewinding whole bytes we pre-read.
      pos -= bitCnt >> 3;
      bitBuf = 0;
      bitCnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      const nlen = src[pos + 2] | (src[pos + 3] << 8);
      if ((len ^ nlen) !== 0xffff) throw new Error("inflate: bad stored block length");
      pos += 4;
      ensure(len);
      out.set(src.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
    } else {
      let lit;
      let dist;
      if (type === 1) {
        if (!fixedLit) {
          const l = new Uint8Array(288);
          l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
          fixedLit = huffmanTable(l);
          fixedDist = huffmanTable(new Uint8Array(32).fill(5));
        }
        lit = fixedLit;
        dist = fixedDist;
      } else if (type === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
        const clTable = huffmanTable(cl);
        const lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decode(clTable);
          if (sym < 16) lengths[i++] = sym;
          else if (sym === 16) {
            if (i === 0) throw new Error("inflate: repeat with no previous length");
            const prev = lengths[i - 1];
            for (let r = bits(2) + 3; r > 0; r--) lengths[i++] = prev;
          } else if (sym === 17) i += bits(3) + 3;
          else i += bits(7) + 11;
        }
        lit = huffmanTable(lengths.subarray(0, hlit));
        dist = huffmanTable(lengths.subarray(hlit));
      } else {
        throw new Error("inflate: reserved block type");
      }
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          ensure(1);
          out[outLen++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= 29) throw new Error("inflate: bad length code");
          const length = LEN_BASE[li] + bits(LEN_EXTRA[li]);
          const di = decode(dist);
          if (di >= 30) throw new Error("inflate: bad distance code");
          const distance = DIST_BASE[di] + bits(DIST_EXTRA[di]);
          if (distance > outLen) throw new Error("inflate: distance too far back");
          ensure(length);
          let from = outLen - distance;
          for (let i = 0; i < length; i++) out[outLen++] = out[from++];
        }
      }
    }
    if (last) break;
  }
  return out.length === outLen ? out : out.subarray(0, outLen);
}

// ---------------------------------------------------------------------------
// tar

/**
 * Parse a tar archive (POSIX ustar, GNU long names, pax extended headers) into
 * entries {name, type: "file"|"dir"|"symlink", mode, data, linkname}. Data is a
 * view into the archive, not a copy.
 */
export function parseTar(bytes) {
  const entries = [];
  const decoder = new TextDecoder();
  const str = (off, len) => {
    let end = off;
    const lim = Math.min(off + len, bytes.length);
    while (end < lim && bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(off, end));
  };
  const octal = (off, len) => {
    if (bytes[off] & 0x80) {
      // base-256 encoding for large values
      let v = 0;
      for (let i = 1; i < len; i++) v = v * 256 + bytes[off + i];
      return v;
    }
    const s = str(off, len).trim();
    return s ? parseInt(s, 8) : 0;
  };
  let longName = null;
  let longLink = null;
  let pax = null;
  let off = 0;
  while (off + 512 <= bytes.length) {
    if (bytes[off] === 0 && isZeroBlock(bytes, off)) break;
    let name = str(off, 100);
    const mode = octal(off + 100, 8);
    let size = octal(off + 124, 12);
    const typeflag = bytes[off + 156] || 0x30;
    let linkname = str(off + 157, 100);
    const posixUstar = str(off + 257, 6) === "ustar" && bytes[off + 262] === 0;
    if (posixUstar) {
      const prefix = str(off + 345, 155);
      if (prefix) name = prefix + "/" + name;
    }
    const dataStart = off + 512;
    if (pax && pax.size !== undefined) size = pax.size;
    const dataEnd = dataStart + size;
    off = dataStart + Math.ceil(size / 512) * 512;
    const data = bytes.subarray(dataStart, dataEnd);
    if (typeflag === 0x4c) { longName = decoder.decode(stripNul(data)); continue; }      // 'L'
    if (typeflag === 0x4b) { longLink = decoder.decode(stripNul(data)); continue; }      // 'K'
    if (typeflag === 0x78) { pax = parsePax(decoder.decode(data)); continue; }           // 'x'
    if (typeflag === 0x67) continue;                                                     // 'g'
    if (pax) {
      if (pax.path !== undefined) name = pax.path;
      if (pax.linkpath !== undefined) linkname = pax.linkpath;
      pax = null;
    }
    if (longName !== null) { name = longName; longName = null; }
    if (longLink !== null) { linkname = longLink; longLink = null; }
    name = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (!name) continue;
    let type;
    if (typeflag === 0x35) type = "dir";                                  // '5'
    else if (typeflag === 0x32) type = "symlink";                         // '2'
    else if (typeflag === 0x30 || typeflag === 0 || typeflag === 0x37) type = "file"; // '0', NUL, '7'
    else continue;                                                        // hard links, devices, fifos
    entries.push({ name, type, mode, data, linkname });
  }
  return entries;
}

function isZeroBlock(bytes, off) {
  for (let i = 0; i < 512; i++) if (bytes[off + i] !== 0) return false;
  return true;
}

function stripNul(data) {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return data.subarray(0, end);
}

function parsePax(text) {
  const result = {};
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space < 0) break;
    const length = parseInt(text.slice(i, space), 10);
    if (!(length > 0)) break;
    const record = text.slice(space + 1, i + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (key === "size") result.size = parseInt(value, 10);
      else result[key] = value;
    }
    i += length;
  }
  return result;
}
