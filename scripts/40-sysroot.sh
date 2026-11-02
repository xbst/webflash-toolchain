#!/usr/bin/env bash
# Stage 3: the sysroot. Downloads the pinned Arm Toolchain for Embedded
# release, takes its picolibc headers, its multilib.yaml and the soft-float
# Cortex-M libraries listed in versions.toml, adds the clang resource headers
# of our own build (they must match the compiler) and packs two tarballs:
#   sysroot.tar.gz      everything a C build needs; mounted at / by toolchain.js
#   sysroot-cxx.tar.gz  the libc++ headers, mounted on demand for clang++
# Both are sorted with mtime 0 so that the same inputs give the same bytes.
#
# Layout inside the tar (mirrors an ATfE install so that clang's bare-metal
# driver finds everything by itself when run as /sysroot/bin/<tool>):
#   sysroot/bin/<tool>                             empty executable placeholders
#   sysroot/lib/clang/<major>/include/             clang resource headers
#   sysroot/lib/clang-runtimes/multilib.yaml       ATfE's variant selection table
#   sysroot/lib/clang-runtimes/arm-none-eabi/include/        picolibc headers
#   sysroot/lib/clang-runtimes/arm-none-eabi/<variant>/lib/  libc.a, libm.a, libclang_rt.builtins.a
source "$(dirname "$0")/common.sh"

[ -d "$DIST/clang-headers" ] || die "$DIST/clang-headers is missing; run scripts/30-build-llvm.sh first"

mkdir -p "$ATFE_DIR"
cd "$ATFE_DIR"
if [ ! -f "$ATFE_ASSET" ]; then
  log "downloading $ATFE_ASSET"
  curl -fL --retry 3 -o "$ATFE_ASSET" "https://github.com/arm/arm-toolchain/releases/download/$ATFE_TAG/$ATFE_ASSET"
fi
echo "$ATFE_SHA256  $ATFE_ASSET" | sha256sum -c -

PREFIX="${ATFE_ASSET%.tar.xz}"
RUNTIMES="lib/clang-runtimes/$SYSROOT_TARGET"
wanted=(
  "$PREFIX/LICENSE.txt"
  "$PREFIX/THIRD-PARTY-LICENSES.txt"
  "$PREFIX/VERSION.txt"
  "$PREFIX/third-party-licenses/*"
  "$PREFIX/lib/clang-runtimes/multilib.yaml"
  "$PREFIX/$RUNTIMES/include/*"
)
for variant in $MULTILIB_DIRS; do
  for lib in $SYSROOT_LIBS; do
    wanted+=("$PREFIX/$RUNTIMES/$variant/lib/$lib")
  done
done

log "extracting the parts we ship"
rm -rf extracted
mkdir extracted
tar -xJf "$ATFE_ASSET" -C extracted --wildcards "${wanted[@]}"
X="$ATFE_DIR/extracted/$PREFIX"
[ -f "$X/VERSION.txt" ] && head -1 "$X/VERSION.txt"
for variant in $MULTILIB_DIRS; do
  for lib in $SYSROOT_LIBS; do
    [ -f "$X/$RUNTIMES/$variant/lib/$lib" ] || die "missing $RUNTIMES/$variant/lib/$lib in $ATFE_ASSET"
  done
done
[ -f "$X/lib/clang-runtimes/multilib.yaml" ] || die "missing multilib.yaml"
[ -f "$X/$RUNTIMES/include/picolibc.h" ] || die "missing picolibc headers"

STAGE="$ROOT/sysroot-stage"
rm -rf "$STAGE"
S="$STAGE/main/sysroot"
mkdir -p "$S/bin" "$S/lib/clang/$LLVM_MAJOR" "$S/lib/clang-runtimes/$SYSROOT_TARGET"

log "assembling sysroot/"
# Placeholders that make argv[0] = /sysroot/bin/<tool> resolve to an existing
# executable file: clang derives its resource and runtimes directories from it.
for tool in llvm $TOOLS; do
  : > "$S/bin/$tool"
  chmod 755 "$S/bin/$tool"
done
cp -r "$DIST/clang-headers" "$S/lib/clang/$LLVM_MAJOR/include"
cp "$X/lib/clang-runtimes/multilib.yaml" "$S/lib/clang-runtimes/multilib.yaml"
cp -r "$X/$RUNTIMES/include" "$S/lib/clang-runtimes/$SYSROOT_TARGET/include"
rm -rf "$S/lib/clang-runtimes/$SYSROOT_TARGET/include/c++"
for variant in $MULTILIB_DIRS; do
  mkdir -p "$S/lib/clang-runtimes/$SYSROOT_TARGET/$variant/lib"
  for lib in $SYSROOT_LIBS; do
    cp "$X/$RUNTIMES/$variant/lib/$lib" "$S/lib/clang-runtimes/$SYSROOT_TARGET/$variant/lib/$lib"
  done
done

log "assembling the libc++ headers"
C="$STAGE/cxx/sysroot/lib/clang-runtimes/$SYSROOT_TARGET/include"
mkdir -p "$C"
cp -r "$X/$RUNTIMES/include/c++" "$C/c++"

log "collecting licenses"
L="$DIST/licenses"
rm -rf "$L"
mkdir -p "$L"
cp "$X/third-party-licenses/LLVM-LICENSE.txt" "$L/LLVM-LICENSE.txt"
cp "$X/third-party-licenses/CLANG-LICENSE.txt" "$L/CLANG-LICENSE.txt"
cp "$X/third-party-licenses/LLD-LICENSE.txt" "$L/LLD-LICENSE.txt"
cp "$X/third-party-licenses/COMPILER-RT-LICENSE.txt" "$L/COMPILER-RT-LICENSE.txt"
cp "$X/third-party-licenses/LIBCXX-LICENSE.txt" "$L/LIBCXX-LICENSE.txt"
cp "$X/third-party-licenses/picolibc/COPYING.picolibc" "$L/PICOLIBC-LICENSE.txt"
cp "$X/LICENSE.txt" "$L/ATFE-LICENSE.txt"
cp "$X/THIRD-PARTY-LICENSES.txt" "$L/ATFE-THIRD-PARTY-LICENSES.txt"
cp "$X/VERSION.txt" "$L/ATFE-VERSION.txt"
curl -fL --retry 3 -o "$L/EMSCRIPTEN-LICENSE.txt" \
  "https://raw.githubusercontent.com/emscripten-core/emscripten/$EMSCRIPTEN_VERSION/LICENSE"
cp "$REPO/LICENSE" "$L/WEBFLASH-TOOLCHAIN-LICENSE.txt"

log "packing"
mkdir -p "$DIST"
pack() { # pack <stage dir> <output .tar.gz>
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --format=gnu \
    -C "$1" -cf "${2%.gz}" sysroot
  gzip -9 -n -f "${2%.gz}"
}
pack "$STAGE/main" "$DIST/sysroot.tar.gz"
pack "$STAGE/cxx" "$DIST/sysroot-cxx.tar.gz"

ls -l "$DIST/sysroot.tar.gz" "$DIST/sysroot-cxx.tar.gz"
echo "sysroot.tar.gz entries: $(tar -tzf "$DIST/sysroot.tar.gz" | wc -l)"
echo "sysroot-cxx.tar.gz entries: $(tar -tzf "$DIST/sysroot-cxx.tar.gz" | wc -l)"
