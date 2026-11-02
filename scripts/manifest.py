#!/usr/bin/env python3
"""Write manifest.json (WebFlash SPEC section 8.3) for a dist directory.

Usage: manifest.py --dist DIR [--build N] [--out FILE]

Everything but the file sizes and hashes comes from versions.toml. The manifest
is the only thing the WebFlash engine reads about the sysroot layout, so a
layout change here never touches the engine.
"""

import argparse
import datetime
import hashlib
import json
import pathlib
import struct
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Files the worker downloads, with their size and sha256 in the manifest.
FILES = ["llvm.wasm.gz", "llvm.js", "toolchain.js", "sysroot.tar.gz", "sysroot-cxx.tar.gz"]

# Licenses shipped in licenses/ of the release tar (the site shows them in About).
LICENSES = {
    "LLVM (Apache-2.0 with LLVM exception)": "licenses/LLVM-LICENSE.txt",
    "Clang": "licenses/CLANG-LICENSE.txt",
    "LLD": "licenses/LLD-LICENSE.txt",
    "compiler-rt builtins": "licenses/COMPILER-RT-LICENSE.txt",
    "libc++ headers": "licenses/LIBCXX-LICENSE.txt",
    "picolibc (BSD)": "licenses/PICOLIBC-LICENSE.txt",
    "Arm Toolchain for Embedded": "licenses/ATFE-LICENSE.txt",
    "Arm Toolchain for Embedded third-party notices": "licenses/ATFE-THIRD-PARTY-LICENSES.txt",
    "Emscripten runtime (MIT)": "licenses/EMSCRIPTEN-LICENSE.txt",
    "webflash-toolchain (GPL-3.0)": "licenses/WEBFLASH-TOOLCHAIN-LICENSE.txt",
}


def sha256_of(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def gzip_isize(path: pathlib.Path) -> int:
    """The uncompressed size recorded in a gzip trailer (modulo 2**32)."""
    with path.open("rb") as f:
        f.seek(-4, 2)
        return struct.unpack("<I", f.read(4))[0]


def build_manifest(dist: pathlib.Path, build: int) -> dict:
    pins = tomllib.loads((ROOT / "versions.toml").read_text(encoding="utf-8"))
    llvm, atfe, sysroot = pins["llvm"], pins["atfe"], pins["sysroot"]
    target = sysroot["target"]
    runtimes = f"sysroot/lib/clang-runtimes/{target}"

    files = {}
    for name in FILES:
        path = dist / name
        if not path.is_file():
            sys.exit(f"manifest.py: {path} is missing")
        entry = {"size": path.stat().st_size, "sha256": sha256_of(path)}
        if name.endswith(".gz"):
            entry["uncompressed"] = gzip_isize(path)
        files[name] = entry

    multilibs = {}
    seen = set()
    for variant, cpus in sysroot["multilibs"].items():
        for cpu in cpus:
            if cpu in seen:
                sys.exit(f"manifest.py: cpu {cpu} listed twice in versions.toml")
            seen.add(cpu)
        multilibs[variant] = {"cpus": list(cpus), "lib": f"{runtimes}/{variant}/lib"}

    return {
        "schema": 1,
        "id": f"llvm{llvm['version']}-atfe{atfe['version']}-build{build}",
        "llvm": llvm["version"],
        "atfe": atfe["version"],
        "emscripten": pins["emscripten"]["version"],
        "build": build,
        "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "target": target,
        "files": files,
        "module": {"js": "llvm.js", "wasm": "llvm.wasm.gz", "export": "default", "program": "/sysroot/bin/llvm"},
        "multilibs": multilibs,
        "libs": list(sysroot["libs"]),
        "include": [f"sysroot/lib/clang/{llvm['major']}/include", f"{runtimes}/include"],
        "include_cxx": [f"{runtimes}/include/c++/v1"],
        "sysroot_cxx": "sysroot-cxx.tar.gz",
        "tools": list(sysroot["tools"]),
        "licenses": LICENSES,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dist", required=True, type=pathlib.Path)
    ap.add_argument("--build", type=int, default=None, help="build number (default: versions.toml)")
    ap.add_argument("--out", type=pathlib.Path, default=None, help="default: <dist>/manifest.json")
    args = ap.parse_args()
    build = args.build
    if build is None:
        build = int(tomllib.loads((ROOT / "versions.toml").read_text(encoding="utf-8"))["build"]["number"])
    manifest = build_manifest(args.dist, build)
    out = args.out or (args.dist / "manifest.json")
    out.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out} ({manifest['id']})")


if __name__ == "__main__":
    main()
