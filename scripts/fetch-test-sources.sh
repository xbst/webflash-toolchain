#!/usr/bin/env bash
# Fetch what the smoke test compiles: a shallow clone of Klipper master and,
# for the configurations the test uses, the autoconf.h that Klipper's own
# kconfiglib generates from test/configs/<name>.config (olddefconfig then
# genconfig, as Klipper's CI does).
#
#   KLIPPER_REPO   override the repository URL (default: Klipper3d/klipper)
#   KLIPPER_REF    branch or tag to clone (default: the default branch)
source "$(dirname "$0")/common.sh"

K="$TEST_SOURCES/klipper"
mkdir -p "$TEST_SOURCES"
if [ ! -d "$K/.git" ]; then
  log "cloning Klipper"
  if [ -n "${KLIPPER_REF:-}" ]; then
    git clone --depth 1 --branch "$KLIPPER_REF" "${KLIPPER_REPO:-https://github.com/Klipper3d/klipper}" "$K"
  else
    git clone --depth 1 "${KLIPPER_REPO:-https://github.com/Klipper3d/klipper}" "$K"
  fi
fi
git -C "$K" log -1 --format='%H %cI' | tee "$TEST_SOURCES/klipper-commit.txt"

cd "$K"
for cfg in stm32g0b1 rp2040; do
  out="$TEST_SOURCES/out-$cfg"
  log "generating $out/autoconf.h"
  mkdir -p "$out"
  cp "test/configs/$cfg.config" "$out/.config"
  KCONFIG_CONFIG="$out/.config" python3 lib/kconfiglib/olddefconfig.py src/Kconfig
  KCONFIG_CONFIG="$out/.config" KCONFIG_AUTOHEADER="$out/autoconf.h" python3 lib/kconfiglib/genconfig.py src/Kconfig
  grep -c '^#define CONFIG_' "$out/autoconf.h"
done
