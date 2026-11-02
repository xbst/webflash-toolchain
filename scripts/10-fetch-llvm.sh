#!/usr/bin/env bash
# Stage 1a: a sparse, shallow clone of llvm-project at the pinned tag, with
# the patches of patches/ applied. Only the subtrees the build reads are
# checked out (cmake, llvm, clang, lld, third-party), which keeps the clone
# under a gigabyte.
source "$(dirname "$0")/common.sh"

SUBTREES="cmake llvm clang lld third-party"

if [ ! -d "$LLVM_SRC/.git" ]; then
  log "cloning llvm-project $LLVM_TAG (sparse, depth 1)"
  git clone --depth 1 --filter=blob:none --sparse --branch "$LLVM_TAG" \
    https://github.com/llvm/llvm-project "$LLVM_SRC"
  # shellcheck disable=SC2086
  git -C "$LLVM_SRC" sparse-checkout set $SUBTREES
fi

cd "$LLVM_SRC"
actual="$(git describe --tags --exact-match 2>/dev/null || true)"
[ "$actual" = "$LLVM_TAG" ] || die "llvm-project is at '$actual', expected $LLVM_TAG (delete $LLVM_SRC)"

log "resetting the tree and applying patches"
git checkout -q -- .
git clean -fdq
for patch in "$REPO"/patches/*.patch; do
  [ -e "$patch" ] || continue
  echo "applying $(basename "$patch")"
  git apply --verbose "$patch"
done
git diff --stat
