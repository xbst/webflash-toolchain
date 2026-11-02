#!/usr/bin/env bash
# Stage 2: build clang, lld and the binutils-like tools as ONE WebAssembly
# multicall module (LLVM_TOOL_LLVM_DRIVER_BUILD) with the ARM backend, using
# Emscripten. Outputs llvm.js, llvm.wasm and llvm.wasm.gz plus the clang
# resource headers into $DIST.
#
# Environment knobs:
#   LTO=0        disable ThinLTO (faster link, bigger module)
#   JOBS=n       parallel compile jobs (default: nproc)
#   CCACHE_DIR   compiler cache (default: $ROOT/ccache)
source "$(dirname "$0")/common.sh"
emsdk_env

LTO="${LTO:-1}"

# ccache settings in the spirit of LuvHakii/llvm-wasm: emcc is a Python
# wrapper whose mtime says nothing about the compiler, so key on the version.
export CCACHE_COMPILERCHECK="string:emscripten-$EMSCRIPTEN_VERSION"
export CCACHE_COMPILERTYPE=clang
export CCACHE_SLOPPINESS=pch_defines,time_macros
export CCACHE_BASEDIR="$ROOT"
export CCACHE_MAXSIZE="${CCACHE_MAXSIZE:-4G}"
export CCACHE_NOHASHDIR=1

# Emscripten link settings (SPEC section 8.1). The module is an ES module
# exporting a factory (default export); toolchain.js instantiates it once per
# tool invocation on a WebAssembly.Module compiled once.
#   INVOKE_RUN=0      main() runs only through callMain(argv)
#   EXIT_RUNTIME=0    exit() unwinds back to callMain instead of tearing down
#   STACK_SIZE=8MB    clang/LLVM recurse deeply; Linux gives cc1 8 MB too
#   no pthreads       GitHub Pages has no COOP/COEP, so no SharedArrayBuffer
LINK_FLAGS="-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLlvm"
LINK_FLAGS="$LINK_FLAGS -sENVIRONMENT=web,worker,node"
LINK_FLAGS="$LINK_FLAGS -sINVOKE_RUN=0 -sEXIT_RUNTIME=0"
LINK_FLAGS="$LINK_FLAGS -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=64MB -sSTACK_SIZE=8MB"
LINK_FLAGS="$LINK_FLAGS -sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV -sEXPORTED_FUNCTIONS=_main"
LINK_FLAGS="$LINK_FLAGS -sFORCE_FILESYSTEM=1 -sNODEJS_CATCH_EXIT=0 -sNODEJS_CATCH_REJECTION=0"
LINK_FLAGS="$LINK_FLAGS -sASSERTIONS=0 -sSTACK_OVERFLOW_CHECK=0"

LTO_ARGS=""
if [ "$LTO" != 0 ]; then
  mkdir -p "$LTO_CACHE"
  LTO_ARGS="-DLLVM_ENABLE_LTO=Thin"
  LINK_FLAGS="$LINK_FLAGS -Wl,--thinlto-cache-dir=$LTO_CACHE -Wl,--thinlto-cache-policy=cache_size_bytes=3g:prune_after=0s"
fi

log "configuring stage 2 (Emscripten $EMSCRIPTEN_VERSION, MinSizeRel, LTO=$LTO)"
# Notes on the options:
#   -Dwait4=__syscall_wait4   Emscripten's libc has no wait4(); LLVM's
#                             Program.inc references it (LuvHakii, emception)
#   LLVM_NATIVE_TOOL_DIR      the stage 1 tablegen binaries
#   LLVM_DEFAULT_TARGET_TRIPLE  what clang targets without --target
#   LLVM_BUILD_TOOLS=OFF      targets still exist; only the ones named below
#                             are built
#   CLANG_DEFAULT_LINKER=lld  clang's link lines name ld.lld without -fuse-ld
# shellcheck disable=SC2046
emcmake cmake -G Ninja -S "$LLVM_SRC/llvm" -B "$STAGE2" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  $(ccache_args) \
  -DCMAKE_CXX_FLAGS="-Dwait4=__syscall_wait4" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINK_FLAGS" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_TARGETS_TO_BUILD=ARM \
  -DLLVM_DEFAULT_TARGET_TRIPLE=arm-none-eabi \
  -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten \
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
  -DLLVM_NATIVE_TOOL_DIR="$STAGE1/bin" \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_PIC=OFF \
  -DLLVM_BUILD_STATIC=ON \
  -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_TERMINFO=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_LIBPFM=OFF \
  -DLLVM_ENABLE_FFI=OFF \
  -DLLVM_ENABLE_HTTPLIB=OFF \
  -DLLVM_ENABLE_CURL=OFF \
  -DLLVM_ENABLE_ASSERTIONS=OFF \
  -DLLVM_ENABLE_BACKTRACES=OFF \
  -DLLVM_ENABLE_CRASH_OVERRIDES=OFF \
  -DLLVM_ENABLE_UNWIND_TABLES=OFF \
  -DLLVM_ENABLE_DUMP=OFF \
  -DLLVM_ENABLE_PLUGINS=OFF \
  -DLLVM_ENABLE_BINDINGS=OFF \
  -DLLVM_ENABLE_OCAMLDOC=OFF \
  -DLLVM_ENABLE_WARNINGS=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_DOCS=OFF \
  -DLLVM_INCLUDE_RUNTIMES=OFF \
  -DLLVM_BUILD_RUNTIME=OFF \
  -DLLVM_BUILD_UTILS=OFF \
  -DLLVM_BUILD_TOOLS=OFF \
  -DLLVM_PARALLEL_LINK_JOBS=1 \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_ENABLE_ARCMT=OFF \
  -DCLANG_ENABLE_OBJC_REWRITER=OFF \
  -DCLANG_INCLUDE_TESTS=OFF \
  -DCLANG_INCLUDE_DOCS=OFF \
  -DCLANG_PLUGIN_SUPPORT=OFF \
  -DCLANG_BUILD_TOOLS=OFF \
  -DCLANG_DEFAULT_LINKER=lld \
  -DCLANG_DEFAULT_RTLIB=compiler-rt \
  -DCLANG_DEFAULT_UNWINDLIB=none \
  $LTO_ARGS

log "building the llvm multicall module and the resource headers with $JOBS jobs"
cmake --build "$STAGE2" -- -j"$JOBS" \
  llvm-driver core-resource-headers arm-common-resource-headers arm-resource-headers

log "collecting outputs into $DIST"
mkdir -p "$DIST"
[ -f "$STAGE2/bin/llvm.js" ] && [ -f "$STAGE2/bin/llvm.wasm" ] || die "stage 2 did not produce bin/llvm.js and bin/llvm.wasm"
cp "$STAGE2/bin/llvm.js" "$DIST/llvm.js"
cp "$STAGE2/bin/llvm.wasm" "$DIST/llvm.wasm"
gzip -9 -n -k -f "$DIST/llvm.wasm"
rm -rf "$DIST/clang-headers"
cp -r "$STAGE2/lib/clang/$LLVM_MAJOR/include" "$DIST/clang-headers"

ls -l "$DIST"
echo "clang resource headers: $(find "$DIST/clang-headers" -type f | wc -l) files"
if command -v ccache >/dev/null 2>&1; then ccache -s | head -20; fi
