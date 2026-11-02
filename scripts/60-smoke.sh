#!/usr/bin/env bash
# Stage 5: the Node smoke test (SPEC section 8.5) against a dist directory or
# an unpacked release.
#
#   WEBFLASH_TOOLCHAIN_DIR   directory with manifest.json (default: $ROOT/dist)
#   WEBFLASH_REPORT          where the timing report is written
source "$(dirname "$0")/common.sh"

"$REPO/scripts/fetch-test-sources.sh"

export WEBFLASH_TOOLCHAIN_DIR="${WEBFLASH_TOOLCHAIN_DIR:-$DIST}"
export WEBFLASH_TEST_SOURCES="$TEST_SOURCES"
export WEBFLASH_REPORT="${WEBFLASH_REPORT:-$ROOT/smoke-report.json}"

[ -f "$WEBFLASH_TOOLCHAIN_DIR/manifest.json" ] || die "no manifest.json in $WEBFLASH_TOOLCHAIN_DIR"
log "node $(node --version), toolchain $(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['id'])" "$WEBFLASH_TOOLCHAIN_DIR/manifest.json")"

cd "$REPO"
node --test tests/
log "report"
cat "$WEBFLASH_REPORT"
