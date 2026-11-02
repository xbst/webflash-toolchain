# Shared setup for the stage scripts. Sourced, not executed.
#
# Layout under $ROOT (default: <repo>/build):
#   emsdk/          the pinned Emscripten SDK
#   llvm-project/   sparse shallow clone at the pinned tag, patched
#   stage1/         native llvm-tblgen, llvm-min-tblgen, clang-tblgen
#   stage2/         the Emscripten build of the llvm multicall module
#   ccache/         compiler cache (stage 1 and 2)
#   lto.cache/      ThinLTO cache of the stage 2 link
#   atfe/           the Arm Toolchain for Embedded download and extraction
#   dist/           everything the release ships, plus clang-headers/
#   package/        toolchain-<id>.tar and toolchain.tar
#   test-sources/   the Klipper clone and generated autoconf.h files
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$REPO/build}"
JOBS="${JOBS:-$(nproc)}"
mkdir -p "$ROOT"

eval "$(python3 "$REPO/scripts/versions.py")"

EMSDK_DIR="${EMSDK_DIR:-$ROOT/emsdk}"
LLVM_SRC="$ROOT/llvm-project"
STAGE1="$ROOT/stage1"
STAGE2="$ROOT/stage2"
DIST="$ROOT/dist"
PACKAGE_DIR="$ROOT/package"
ATFE_DIR="$ROOT/atfe"
TEST_SOURCES="$ROOT/test-sources"
LTO_CACHE="$ROOT/lto.cache"
export CCACHE_DIR="${CCACHE_DIR:-$ROOT/ccache}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Activate the Emscripten SDK in the current shell.
emsdk_env() {
  [ -f "$EMSDK_DIR/emsdk_env.sh" ] || die "emsdk is not installed; run scripts/00-setup-emsdk.sh"
  # shellcheck disable=SC1091
  EMSDK_QUIET=1 source "$EMSDK_DIR/emsdk_env.sh"
}

# CMake arguments that enable ccache when it is installed.
ccache_args() {
  if command -v ccache >/dev/null 2>&1; then
    echo "-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache"
  fi
}
