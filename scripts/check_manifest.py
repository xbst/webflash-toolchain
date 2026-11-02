#!/usr/bin/env python3
"""Validate a manifest.json against WebFlash SPEC section 8.3.

Usage: check_manifest.py MANIFEST [--dist DIR]

With --dist, every file listed in "files" must exist there with the recorded
size and sha256. Exit status 1 and one line per problem otherwise.
"""

import argparse
import hashlib
import json
import pathlib
import re
import sys

REQUIRED_TOOLS = [
    "clang", "clang++", "ld.lld", "llvm-objcopy", "llvm-objdump", "llvm-readelf",
    "llvm-ar", "llvm-nm", "llvm-strip", "llvm-size",
]
REQUIRED_FILES = ["llvm.wasm.gz", "llvm.js", "toolchain.js", "sysroot.tar.gz"]
ID_RE = re.compile(r"^llvm(\d+\.\d+\.\d+)-atfe(\d+\.\d+\.\d+)-build(\d+)$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def check(manifest: dict, dist: pathlib.Path | None) -> list[str]:
    problems = []

    def need(cond, msg):
        if not cond:
            problems.append(msg)

    need(manifest.get("schema") == 1, "schema must be 1")
    m = ID_RE.match(str(manifest.get("id", "")))
    need(m is not None, f"id {manifest.get('id')!r} is not llvm<ver>-atfe<ver>-build<n>")
    if m:
        need(manifest.get("llvm") == m.group(1), "llvm does not match the id")
        need(manifest.get("atfe") == m.group(2), "atfe does not match the id")
    need(isinstance(manifest.get("emscripten"), str) and manifest["emscripten"], "emscripten version missing")

    files = manifest.get("files")
    need(isinstance(files, dict), "files must be an object")
    if isinstance(files, dict):
        for name in REQUIRED_FILES:
            need(name in files, f"files lacks {name}")
        for name, entry in files.items():
            ok = isinstance(entry, dict) and isinstance(entry.get("size"), int) and entry["size"] > 0 \
                and SHA_RE.match(str(entry.get("sha256", "")))
            need(ok, f"files[{name}] needs a positive size and a sha256")
            if ok and dist is not None:
                path = dist / name
                if not path.is_file():
                    problems.append(f"{name} is missing from {dist}")
                    continue
                need(path.stat().st_size == entry["size"], f"{name}: size differs from the manifest")
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                need(digest == entry["sha256"], f"{name}: sha256 differs from the manifest")

    multilibs = manifest.get("multilibs")
    need(isinstance(multilibs, dict) and multilibs, "multilibs must be a non-empty object")
    if isinstance(multilibs, dict):
        seen = set()
        for variant, entry in multilibs.items():
            cpus = entry.get("cpus") if isinstance(entry, dict) else None
            need(isinstance(cpus, list) and cpus and all(isinstance(c, str) for c in cpus),
                 f"multilibs[{variant}].cpus must be a non-empty list of strings")
            need(isinstance(entry, dict) and isinstance(entry.get("lib"), str) and entry["lib"].startswith("sysroot/"),
                 f"multilibs[{variant}].lib must be a sysroot/ path")
            for cpu in cpus or []:
                need(cpu not in seen, f"cpu {cpu} served by two multilibs")
                seen.add(cpu)
        for cpu in ["cortex-m0", "cortex-m0plus", "cortex-m3", "cortex-m4", "cortex-m7", "cortex-m33"]:
            need(cpu in seen, f"no multilib serves {cpu}")

    include = manifest.get("include")
    need(isinstance(include, list) and include and all(isinstance(p, str) and p.startswith("sysroot/") for p in include),
         "include must be a non-empty list of sysroot/ paths")
    need(manifest.get("tools") == REQUIRED_TOOLS, f"tools must be exactly {REQUIRED_TOOLS}")
    licenses = manifest.get("licenses")
    need(isinstance(licenses, dict) and licenses, "licenses must be a non-empty object")
    return problems


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("manifest", type=pathlib.Path)
    ap.add_argument("--dist", type=pathlib.Path, default=None)
    args = ap.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    problems = check(manifest, args.dist)
    for p in problems:
        print(f"manifest: {p}")
    if problems:
        sys.exit(1)
    print(f"manifest {manifest['id']} is valid")


if __name__ == "__main__":
    main()
