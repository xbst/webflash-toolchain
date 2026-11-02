#!/usr/bin/env bash
# Stage 1: build the TableGen tools natively. The Emscripten cross build of
# stage 2 cannot run its own tablegen (it would be WebAssembly), so it is
# pointed at these with LLVM_NATIVE_TOOL_DIR. The result depends only on the
# LLVM tag and is cached by the workflow.
source "$(dirname "$0")/common.sh"

NEEDED="llvm-tblgen llvm-min-tblgen clang-tblgen"

have_all=1
for tool in $NEEDED; do
  [ -x "$STAGE1/bin/$tool" ] || have_all=0
done
if [ "$have_all" = 1 ]; then
  log "stage 1 tools already present in $STAGE1/bin"
  exit 0
fi

log "configuring stage 1 (native, Release)"
# shellcheck disable=SC2046
cmake -G Ninja -S "$LLVM_SRC/llvm" -B "$STAGE1" \
  -DCMAKE_BUILD_TYPE=Release \
  $(ccache_args) \
  -DLLVM_ENABLE_PROJECTS="clang" \
  -DLLVM_TARGETS_TO_BUILD=ARM \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_DOCS=OFF \
  -DLLVM_ENABLE_ASSERTIONS=OFF \
  -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_TERMINFO=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_LIBPFM=OFF \
  -DLLVM_ENABLE_WARNINGS=OFF

log "building $NEEDED with $JOBS jobs"
# shellcheck disable=SC2086
ninja -C "$STAGE1" -j"$JOBS" $NEEDED
ls -l "$STAGE1"/bin/
