#!/usr/bin/env bash
# Stage 0: install the pinned Emscripten SDK into $ROOT/emsdk.
source "$(dirname "$0")/common.sh"

if [ ! -d "$EMSDK_DIR/.git" ]; then
  log "cloning emsdk"
  git clone --depth 1 https://github.com/emscripten-core/emsdk "$EMSDK_DIR"
else
  log "updating the emsdk release list"
  git -C "$EMSDK_DIR" fetch --depth 1 origin main && git -C "$EMSDK_DIR" reset -q --hard origin/main
fi

log "installing Emscripten $EMSCRIPTEN_VERSION"
"$EMSDK_DIR/emsdk" install "$EMSCRIPTEN_VERSION"
"$EMSDK_DIR/emsdk" activate "$EMSCRIPTEN_VERSION"

emsdk_env
log "emcc: $(emcc --version | head -1)"
