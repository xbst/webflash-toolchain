# webflash-toolchain

The compiler of [WebFlash](https://github.com/xbst/webflash): clang, lld and the LLVM binutils built to WebAssembly with the ARM backend, plus a picolibc sysroot for Cortex-M, so that Klipper, Kalico and Katapult firmware can be compiled in the browser. No server, no virtual machine: one `llvm.wasm` module runs `clang`, `clang++`, `ld.lld`, `llvm-objcopy`, `llvm-objdump`, `llvm-readelf`, `llvm-ar`, `llvm-nm`, `llvm-strip` and `llvm-size`, dispatching on `argv[0]`.

Status: the first release is pending the first GitHub Actions run (the build takes hours and only runs there). The numbers and the lld notes below are filled in from the smoke test report of that run.

## What a release contains

Every release `llvm<ver>-atfe<ver>-build<n>` carries `toolchain-<id>.tar` and the same file as `toolchain.tar` (the stable name `releases/latest/download/toolchain.tar`). The tar is flat:

| File | What |
|---|---|
| `manifest.json` | the contract the WebFlash engine reads: file sizes and hashes, the multilib map, include paths, tools, licenses (schema 1, SPEC 8.3) |
| `llvm.js` | the Emscripten ES module (default export: the module factory) |
| `llvm.wasm.gz` | the multicall module, pre-gzipped because GitHub Pages serves `.wasm` uncompressed |
| `toolchain.js` | the runner: `createToolchain({manifestUrl})` and `run({argv, cwd, env, files})` for Web Workers and Node |
| `sysroot.tar.gz` | clang's resource headers, picolibc's headers, ATfE's `multilib.yaml`, and `libc.a`, `libm.a`, `libclang_rt.builtins.a` for the three Cortex-M soft-float variants |
| `sysroot-cxx.tar.gz` | the libc++ headers, mounted only when `clang++` runs (Kalico's `.c++` sources include `<optional>` and `<cmath>`) |
| `licenses/` | LLVM, Clang, LLD, compiler-rt, libc++, picolibc, ATfE, Emscripten and this repository's licenses, as listed in `manifest.licenses` |

The WebFlash Pages deploy downloads `toolchain.tar`, reads `manifest.json` from it (`tar -xOf toolchain.tar manifest.json`), unpacks it into `_site/toolchain/<id>/` and writes `toolchain/current.json`. The site's toolchain workers then load `toolchain/<id>/manifest.json` with `toolchain.js`.

## Pins

| What | Pinned | Where |
|---|---|---|
| LLVM | `llvmorg-23.1.4` | `versions.toml` |
| Emscripten | 6.0.10 | `versions.toml` |
| Arm Toolchain for Embedded | `release-23.1.0-ATfE` (`ATfE-23.1.0-Linux-x86_64.tar.xz`, sha256 pinned) | `versions.toml` |
| Build number | `[build].number`, overridden by a pushed `build-<n>` tag | `versions.toml`, the workflow |

Six patches are applied to LLVM; the ones that touch code are guarded by `__EMSCRIPTEN__`. `patches/0001-main-executable-under-emscripten.patch`: under Emscripten `getMainExecutable()` trusts `argv[0]` when it names an existing file, so that clang run as `/sysroot/bin/llvm` finds its resource directory (`/sysroot/lib/clang/23`), `ld.lld` and the `multilib.yaml` of the sysroot by itself. `patches/0002-driver-tool-symlinks.patch`: in a multicall driver build, `llvm_add_tool_symlink` must not evaluate `$<TARGET_FILE>` of a tool that became a custom target (the aliases such as `llvm-strip` and `llvm-readelf` are generated against the driver anyway); without it CMake's generate step fails for llvm-ar, llvm-objcopy, llvm-objdump and llvm-readobj. `patches/0003-flush-streams-under-emscripten.patch`: the driver exports `webflash_flush_streams()`, which `toolchain.js` calls after every `main()`; the module runs with `EXIT_RUNTIME=0`, so a tool that ends through `exit()` (`llvm-objcopy --version` does) would otherwise leave its output in the buffer of `llvm::outs()`. `patches/0004-in-process-cc1-for-every-job.patch`: clang's driver keeps every cc1 and cc1as job in process even when a compilation has several (a `.S` file is preprocessed, then assembled), where upstream falls back to spawning, which WebAssembly cannot do. `patches/0005-no-signal-handlers-under-emscripten.patch`: `InitLLVM` registers no signal callbacks; there are no signals, and LLVM's table of eight entries, two per `main()`, limited a reused instance to four runs. `patches/0006-export-the-flush-function.patch`: the driver target alone gets `-sEXPORTED_FUNCTIONS=_main,_webflash_flush_streams`; in `CMAKE_EXE_LINKER_FLAGS` the same flag makes CMake's configure checks fail, because emcc refuses to link a test program that lacks an exported function. The driver holds exactly the ten tools of the manifest; the other tools that would join it (`dsymutil`, `llvm-symbolizer`, `llvm-rc` and so on) are switched off with their `LLVM_TOOL_<NAME>_BUILD` options.

## The sysroot and the multilib map

The sysroot mirrors an ATfE installation under `/sysroot` in the instance's MEMFS:

```
/sysroot/bin/<tool>                                  empty executable placeholders (argv[0] targets)
/sysroot/lib/clang/23/include/                       clang resource headers (core + Arm)
/sysroot/lib/clang-runtimes/multilib.yaml            ATfE's variant selection table, minus its IncludeDirs keys
/sysroot/lib/clang-runtimes/arm-none-eabi/include/   picolibc headers (shared by all variants)
/sysroot/lib/clang-runtimes/arm-none-eabi/<variant>/lib/{libc.a,libm.a,libclang_rt.builtins.a}
```

Klipper builds every Cortex-M as soft float without FPU flags (`-mcpu=X -mthumb`), so only the `soft_nofp` variants are shipped. ATfE 23 has no `armv7em` library: Cortex-M4 and Cortex-M7 use the `armv7m` one (v7E-M is a superset of v7-M, and ATfE's own `multilib.yaml` maps `thumbv7em` to `thumbv7m`). The `unaligned` variants are what clang selects for v7-M and v8-M Mainline, whose default is `-munaligned-access`; v6-M has no unaligned access.

Always pass `-mfloat-abi=soft` to clang. GCC's `arm-none-eabi` default is soft float, but clang without the flag enables the FPU instructions of Cortex-M4, M7 and M33 with the soft calling convention (`-###` shows `+vfp4d16sp`), and Klipper never turns the FPU on. With the flag, clang's own variant choice is the `soft_nofp` family too (its `exn_rtti` sibling, since a C compile says nothing about exceptions; the engine passes `-L` from the manifest, so the choice only shows in `-###` output).

ATfE's `multilib.yaml` carries an `IncludeDirs` key per variant that clang 23.1.4 does not know; it would reject the whole file and fail every compile. `scripts/multilib_yaml.py` drops those blocks and keeps the rest verbatim; clang adds the `<variant>/include` directory on its own.

| `-mcpu` | manifest `multilibs` key | library directory |
|---|---|---|
| `cortex-m0`, `cortex-m0plus` | `armv6m_soft_nofp_size` | `sysroot/lib/clang-runtimes/arm-none-eabi/armv6m_soft_nofp_size/lib` |
| `cortex-m3`, `cortex-m4`, `cortex-m7` | `armv7m_soft_nofp_unaligned_size` | `sysroot/lib/clang-runtimes/arm-none-eabi/armv7m_soft_nofp_unaligned_size/lib` |
| `cortex-m33` | `armv8m.main_soft_nofp_unaligned_size` | `sysroot/lib/clang-runtimes/arm-none-eabi/armv8m.main_soft_nofp_unaligned_size/lib` |

`manifest.include` lists the system include directories in the order to pass them (`-isystem` each): the clang resource headers first, then picolibc. `manifest.include_cxx` lists the libc++ directory, to be passed before `include` when compiling C++. Read the paths from the manifest, never hard-code them; a layout change here must never touch the engine.

## Invocation forms for the engine

`toolchain.js` runs one tool per call: `argv[0]` is the tool name, the remaining arguments are passed through unchanged, relative paths resolve against `cwd`. The engine translates GCC command lines per SPEC section 9.4; these are the shapes this toolchain expects and the smoke test exercises.

Compile (Klipper's `CFLAGS` with `-flto=auto -fwhole-program -fno-use-linker-plugin -ggdb3` translated to `-flto -ffat-lto-objects -g`, plus `-mfloat-abi=soft`):

```
clang --target=arm-none-eabi -iquote out/ -iquote src -iquote out/board-generic/ -MD -Wall -Wtype-limits
      -ffunction-sections -fdata-sections -fno-delete-null-pointer-checks -flto -ffat-lto-objects -g -Os -mfloat-abi=soft
      -mcpu=cortex-m0plus -Ilib/stm32g0/include -DSTM32G0B1xx -mthumb -Ilib/cmsis-core -Ilib/fast-hash
      -std=gnu11 -Wold-style-definition -Wno-unknown-warning-option
      -isystem /sysroot/lib/clang/23/include -isystem /sysroot/lib/clang-runtimes/arm-none-eabi/include
      -c src/sched.c -o out/src/sched.o
```

`clang -c` runs cc1 in process (the build has `CLANG_SPAWN_CC1` off and `-fintegrated-cc1` is the default); a `.S` file takes two jobs, the preprocessor and then cc1as, which patch 0004 keeps in process as well. The tools create no directories: the parent of every output must exist, either because an input lives there or through the `dirs` option of `run()`. `-MD` writes `out/src/sched.d` next to the object, which comes back as an output. `clang++` with `-std=c++20 -fno-rtti -fno-exceptions` works the same way for Kalico's `.c++` files, with `include_cxx` in front of `include`.

Preprocess a linker script (`cpp -I<out> -P -MD -MT x x.lds.S -o x.ld`):

```
clang --target=arm-none-eabi -E -P -x assembler-with-cpp -Iout src/generic/armcm_link.lds.S -o out/src/generic/armcm_link.ld
```

Link, option (a): give clang the translated GCC link line with `-###`; clang prints the commands it would run on stderr; the last fully quoted line is the `ld.lld` command. Run that. There is no second process: `clang` cannot spawn `ld.lld` under WebAssembly, so a plain `clang ... -o klipper.elf` link fails with "unable to execute command".

```
clang --target=arm-none-eabi -mcpu=cortex-m0plus -mthumb -mfloat-abi=soft -nostdlib -flto -ffat-lto-objects -###
      out/src/sched.o ... out/compile_time_request.o -T out/src/generic/armcm_link.ld
      -Wl,--gc-sections -Wl,--print-memory-usage
      -L/sysroot/lib/clang-runtimes/arm-none-eabi/armv6m_soft_nofp_size/lib -lc -lclang_rt.builtins -lc
      -Wl,-u,VectorTable -o out/klipper.elf
```

Parsing rule for the printed line: split it with shell quoting (every argument is double-quoted, `\"` and `\\` are escapes); if the first word's basename is `llvm`, drop it; the first remaining word's basename is the tool (`ld.lld`). `toolchain.js` exports `parseDriverCommands()` and `normalizeCommand()` that do exactly this, and `runLinkViaDriver()` that runs both steps.

Link, option (b): a directly constructed `ld.lld` line, which is what clang prints, with `-m armelf -EL -Bstatic` in front and `--target2=rel` at the end (clang's bare-metal driver adds those). For an LTO link of fat objects the three LTO arguments are required, otherwise lld links the native code of the objects and ignores their bitcode:

```
ld.lld -m armelf -EL -Bstatic --fat-lto-objects -plugin-opt=mcpu=cortex-m0plus --lto-O2
       out/src/sched.o ... -T out/src/generic/armcm_link.ld --gc-sections --print-memory-usage
       -L/sysroot/lib/clang-runtimes/arm-none-eabi/armv6m_soft_nofp_size/lib -lc -lclang_rt.builtins -lc
       -u VectorTable --target2=rel -o out/klipper.elf
```

`--fat-lto-objects` is what clang adds to the linker line when `-ffat-lto-objects` is given at link time; pass `-flto -ffat-lto-objects` (not just `-flto`) on the clang link line of option (a) for the same effect. `-u VectorTable` (one per `__visible` symbol of `compile_time_request.c`) keeps the vector table alive through LTO internalization. `--print-memory-usage` prints the region table on stdout.

The RP2040 stage2 path of `src/rp2040/Makefile` maps one to one: `clang <CFLAGS> -c boot2_w25q080.S -o stage2raw1.o`, `ld.lld stage2raw1.o --script=lib/pico-sdk/rp2040/boot_stage2/boot_stage2.ld -o stage2raw.o`, `llvm-objcopy -O binary stage2raw.o stage2raw.bin`, `pad_checksum` (Python, the engine's job), `clang <CFLAGS> -c stage2.S -o stage2.o`.

Other binutils: `llvm-objcopy -O binary|ihex in out`, `llvm-objcopy -j .compile_time_request -O binary in out`, `llvm-nm`, `llvm-size`, `llvm-readelf -h -S`, `llvm-objdump -d`, `llvm-strip in -o out`, `llvm-ar rcs lib.a objs...` take the GNU arguments unchanged.

What lld accepts in Klipper's linker scripts: the smoke test links `src/generic/armcm_link.lds.S` (`OUTPUT_FORMAT` with three arguments, `MEMORY`, `AT`, `NOLOAD`, `KEEP`, `/DISCARD/`), `src/rp2040/rpxxxx_link.lds.S` (`PHDRS` with `FLAGS`, `LONG`) and pico-sdk's `boot_stage2.ld` unchanged, and checks the resulting images. The release run of build 1 needed no workaround for any of them. Note that `armcm_link.lds.S` places the vector table inside the `.text` output section, so `llvm-readelf -S` shows no `.vector_table` section in the linked image.

For the record, this is the line clang 23.1.4 printed for the smoke test's LTO link of option (a) (the `-L` directories of the variant clang selected by itself do not exist in the sysroot and are harmless; the manifest's `-L` comes first and wins):

```
ld.lld -Bstatic -m armelf -EL -L/sysroot/lib/clang-runtimes/arm-none-eabi/armv6m_soft_nofp_size/lib
       -L/sysroot/bin/../lib/clang-runtimes/arm-none-eabi/armv6m_soft_nofp_exn_rtti_size
       -L/sysroot/bin/../lib/clang-runtimes/arm-none-eabi/armv6m_soft_nofp_exn_rtti_size/lib -T out/armcm_link.ld
       -L/sysroot/lib/clang/23/lib/arm-unknown-none-eabi/arm-none-eabi/armv6m_soft_nofp_exn_rtti_size
       -L/sysroot/lib/clang/23/lib/arm-unknown-none-eabi
       -L/sysroot/bin/../lib/clang-runtimes/arm-none-eabi/armv6m_soft_nofp_exn_rtti_size/lib
       --fat-lto-objects -plugin-opt=mcpu=cortex-m0plus out/vectors.o --gc-sections --print-memory-usage
       -lc -lclang_rt.builtins -lc -u VectorTable --target2=rel -o out/a.elf
```

## Using toolchain.js

```js
import { createToolchain } from "./toolchain.js";

const tc = await createToolchain({ manifestUrl: "https://webflash.isiks.tech/toolchain/<id>/manifest.json" });
const r = await tc.run({
  argv: ["clang", "--target=arm-none-eabi", "-mcpu=cortex-m0plus", "-mthumb", "-mfloat-abi=soft", "-Os", "-c", "src/a.c", "-o", "out/a.o"],
  cwd: "/work",
  env: {},
  files: new Map([
    ["/work/src/a.c", bytes],                         // Uint8Array, ArrayBuffer or string
    ["/work/out/board", { symlink: "/work/src/stm32" }],
  ]),
  dirs: ["out"],                                      // created before the run: -o out/a.o needs out/ to exist
});
r.code      // the tool's exit status (134 when the instance aborted; the reason is in stderr)
r.stdout    // text
r.stderr    // text
r.outputs   // Map<absolute path, Uint8Array>: every file under cwd the tool created
r.time      // milliseconds spent in main()
r.memory    // bytes of linear memory the instance ended with
```

`createToolchain` fetches `manifest.json`, imports `llvm.js`, decompresses `llvm.wasm.gz` (`DecompressionStream("gzip")`, or the bundled inflate where that API is missing) and compiles it once, and parses `sysroot.tar.gz`. Every `run()` instantiates the compiled module afresh, mounts the sysroot and the given files into the instance's MEMFS without copying (inputs are read-only views of your arrays; a tool cannot change an input in place), changes to `cwd`, calls `main()` and reads back every file under `cwd` that did not exist before. Relative `files` keys and `dirs` entries are taken from `cwd`; parent directories of `files` are created, nothing else is. `runReusing()` keeps one instance alive between calls, which saves the instantiation and sysroot mount of every run. In the release run of build 1 one instance compiled 100 files in a row with no failure and byte-identical outputs, at 40 ms per compile against 56 ms with a fresh instance, while its memory grew from 64 MB to 191 MB (cc1 runs with `-disable-free`, so every compile leaks a little); `dispose()` drops the instance. `run()` stays the default for its isolation; `runReusing()` is a measured option for long builds, worth a `dispose()` after each one. `loadCxx()` fetches the libc++ headers early (otherwise the first `clang++` run does). Options: `fetch` (a fetch-compatible function; `file:` URLs are read from disk under Node without one), `importModule`, `verify` (check every sha256), `onProgress({file, loaded, total})`.

`llvm.js` is an ES module: in a browser load `toolchain.js` from a module worker (`new Worker(url, { type: "module" })`); under Node import it from a directory without a `package.json` that says `commonjs`. There are no threads: parallelism comes from several workers, each with its own `createToolchain()`.

## Reproducing the build

The release workflow (`.github/workflows/build.yml`) runs the scripts of `scripts/` in order on `ubuntu-24.04`; the same scripts run anywhere with git, curl, python3, cmake, ninja, ccache and a C++ compiler:

```
scripts/00-setup-emsdk.sh      the pinned Emscripten SDK into build/emsdk
scripts/10-fetch-llvm.sh       sparse shallow clone of llvm-project at the tag, patches applied
scripts/20-build-tablegen.sh   stage 1: native llvm-tblgen, llvm-min-tblgen, clang-tblgen
scripts/30-build-llvm.sh       stage 2: emcmake build of the llvm multicall module (LTO=0 skips ThinLTO)
scripts/40-sysroot.sh          download ATfE, assemble and pack sysroot.tar.gz and sysroot-cxx.tar.gz
scripts/50-package.sh          manifest.json and toolchain-<id>.tar
scripts/60-smoke.sh            clone Klipper, generate autoconf.h, node --test on tests/*.test.mjs
```

`ROOT` sets the build root (default `build/`), `JOBS` the parallelism. The `Dockerfile` runs the same stages in an Ubuntu image (`docker build -t webflash-toolchain .`). `node --test tests/unit.test.mjs` runs the parts that need no build.

Stage 2 configures LLVM with `LLVM_TARGETS_TO_BUILD=ARM`, `LLVM_ENABLE_PROJECTS=clang;lld`, `LLVM_TOOL_LLVM_DRIVER_BUILD=ON`, `LLVM_ENABLE_THREADS=OFF`, no zlib, zstd, libxml2, terminfo, backtraces or crash overrides, `MinSizeRel`, ThinLTO, and links with `-sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=web,worker,node -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV`. See `scripts/30-build-llvm.sh` for the full list and the reasons.

## Releasing

Push a tag `build-<n>` (or run the workflow by hand; `[build].number` of `versions.toml` is the default number). The workflow builds, packages, runs the smoke test on the packed release and creates the GitHub Release `llvm<ver>-atfe<ver>-build<n>` marked latest, with `toolchain-<id>.tar` and `toolchain.tar`. It refuses to rebuild an existing release: bump the number. ccache and the ThinLTO cache are kept in the Actions cache, so a second run of the same pins takes minutes rather than hours.

## Smoke test numbers

Measured by `tests/smoke.test.mjs` under Node 24.22.1 on the `ubuntu-24.04` runner (2 vCPUs) in the release run of build 1 on 2026-11-03, from its `smoke-report` artifact. Times are `main()` only; a fresh instance adds its instantiation and sysroot mount, which the last row measures. The first compile in a process pays about 1 s more for Node's lazy compilation of the module; the table shows later runs.

| Measurement | Value |
|---|---|
| `llvm.wasm.gz` | 21,103,163 bytes (59,603,584 uncompressed) |
| `sysroot.tar.gz` | 1,475,624 bytes, 238 entries (`sysroot-cxx.tar.gz`: 1,731,714 bytes, 1,786 entries) |
| Klipper `src/sched.c` (stm32g0b1, LTO, fat objects) | 435 ms (`src/command.c`, the slowest: 553 ms; limit 3,000 ms) |
| Klipper `src/stm32/stm32g0.c` | 278 ms (`src/generic/armcm_boot.c`: 192 ms) |
| Link of the vector-table program with LTO | 44 ms with the direct `ld.lld` line, 149 ms with the line taken from `clang -###` (11 ms and 75 ms without LTO) |
| Peak instance memory | 64 MB for every single-run instance; 191 MB after 100 compiles on one reused instance (limit 1,024 MB) |
| Fresh instance per compile versus a reused instance (average) | 56 ms against 40 ms per compile of the vector-table file with LTO over three CPUs; 100 reused runs, 0 failures, 0 output differences |

## License

This repository is GPL-3.0 (see `LICENSE`). The artifacts it builds carry their own licenses, shipped in `licenses/` of every release and listed in `manifest.licenses`: LLVM, Clang, LLD and compiler-rt under Apache-2.0 with LLVM exception, picolibc under its BSD-style licenses, libc++ under Apache-2.0 with LLVM exception, the Emscripten runtime under MIT, and the Arm Toolchain for Embedded's own license file.

If you would like to support the development of this and other open-source projects, you can donate on [GitHub Sponsors](https://github.com/sponsors/xbst/) or [Patreon](https://patreon.com/isikstech).
