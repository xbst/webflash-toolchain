#!/usr/bin/env python3
"""Print the pins of versions.toml as shell assignments.

Usage (from the stage scripts): eval "$(python3 scripts/versions.py)"

WEBFLASH_BUILD_NUMBER in the environment overrides [build].number, which is how
the release workflow applies the number of a pushed build-<n> tag.
"""

import os
import pathlib
import shlex
import sys
import tomllib

root = pathlib.Path(__file__).resolve().parent.parent
pins = tomllib.loads((root / "versions.toml").read_text(encoding="utf-8"))

build = os.environ.get("WEBFLASH_BUILD_NUMBER", "").strip() or str(pins["build"]["number"])
if not build.isdigit() or int(build) < 1:
    sys.exit(f"versions.py: bad build number {build!r}")

values = {
    "LLVM_TAG": pins["llvm"]["tag"],
    "LLVM_VERSION": pins["llvm"]["version"],
    "LLVM_MAJOR": str(pins["llvm"]["major"]),
    "EMSCRIPTEN_VERSION": pins["emscripten"]["version"],
    "ATFE_TAG": pins["atfe"]["tag"],
    "ATFE_VERSION": pins["atfe"]["version"],
    "ATFE_ASSET": pins["atfe"]["asset"],
    "ATFE_SHA256": pins["atfe"]["sha256"],
    "BUILD_NUMBER": build,
    "TOOLCHAIN_ID": f"llvm{pins['llvm']['version']}-atfe{pins['atfe']['version']}-build{build}",
    "SYSROOT_TARGET": pins["sysroot"]["target"],
    "SYSROOT_LIBS": " ".join(pins["sysroot"]["libs"]),
    "TOOLS": " ".join(pins["sysroot"]["tools"]),
    "MULTILIB_DIRS": " ".join(pins["sysroot"]["multilibs"]),
}
for key, value in values.items():
    print(f"{key}={shlex.quote(value)}")
