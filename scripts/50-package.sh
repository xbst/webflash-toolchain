#!/usr/bin/env bash
# Stage 4: manifest.json and the release tar. The tar is flat: manifest.json,
# llvm.js, llvm.wasm.gz, toolchain.js, sysroot.tar.gz, sysroot-cxx.tar.gz and
# licenses/ at its root, so the Pages deploy of the main repository unpacks it
# straight into _site/toolchain/<id>/. toolchain.tar is the same file under
# the stable name that releases/latest/download/toolchain.tar serves.
source "$(dirname "$0")/common.sh"

for f in llvm.js llvm.wasm.gz sysroot.tar.gz sysroot-cxx.tar.gz licenses/LLVM-LICENSE.txt; do
  [ -f "$DIST/$f" ] || die "$DIST/$f is missing"
done

cp "$REPO/src/toolchain.js" "$DIST/toolchain.js"

log "writing manifest.json for $TOOLCHAIN_ID"
python3 "$REPO/scripts/manifest.py" --dist "$DIST" --build "$BUILD_NUMBER"
python3 "$REPO/scripts/check_manifest.py" "$DIST/manifest.json" --dist "$DIST"
cat "$DIST/manifest.json"

log "packing toolchain-$TOOLCHAIN_ID.tar"
rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR/stage"
for f in manifest.json llvm.js llvm.wasm.gz toolchain.js sysroot.tar.gz sysroot-cxx.tar.gz; do
  cp "$DIST/$f" "$PACKAGE_DIR/stage/$f"
done
cp -r "$DIST/licenses" "$PACKAGE_DIR/stage/licenses"
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --format=gnu \
  -C "$PACKAGE_DIR/stage" -cf "$PACKAGE_DIR/toolchain-$TOOLCHAIN_ID.tar" .
cp "$PACKAGE_DIR/toolchain-$TOOLCHAIN_ID.tar" "$PACKAGE_DIR/toolchain.tar"
rm -rf "$PACKAGE_DIR/stage"
ls -l "$PACKAGE_DIR"
tar -tf "$PACKAGE_DIR/toolchain.tar"
