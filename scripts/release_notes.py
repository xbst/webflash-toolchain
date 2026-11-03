#!/usr/bin/env python3
"""Release notes for a toolchain release, as Markdown on stdout.

Usage: release_notes.py <manifest.json> [smoke-report.json]

The pins and file sizes come from the manifest; with the smoke test report
(tests/smoke.test.mjs writes it), a few of its numbers are added.
"""
import json
import sys


def main() -> None:
    if len(sys.argv) not in (2, 3):
        sys.exit("usage: release_notes.py <manifest.json> [smoke-report.json]")
    with open(sys.argv[1], encoding="utf-8") as f:
        m = json.load(f)
    out = [
        f"WebFlash toolchain `{m['id']}`: clang, lld and the LLVM binutils built to WebAssembly "
        "with the ARM backend, plus a picolibc sysroot from the Arm Toolchain for Embedded.",
        "",
        "| Pin | Version |",
        "|---|---|",
        f"| LLVM | {m['llvm']} |",
        f"| Arm Toolchain for Embedded | {m['atfe']} |",
        f"| Emscripten | {m['emscripten']} |",
        "",
        "| File | Bytes | Uncompressed |",
        "|---|---|---|",
    ]
    for name, entry in m["files"].items():
        raw = f"{entry['uncompressed']:,}" if "uncompressed" in entry else ""
        out.append(f"| `{name}` | {entry['size']:,} | {raw} |")

    if len(sys.argv) == 3:
        with open(sys.argv[2], encoding="utf-8") as f:
            r = json.load(f)
        runs = r.get("runs", [])
        klipper = [x for x in runs if x.get("tool") in ("clang", "clang++") and x.get("name", "").startswith("klipper: ")]
        limits = r.get("limits", {})
        out += ["", f"Smoke test (SPEC 8.5) on Node {r.get('node')} ({r.get('platform')}), Klipper `{(r.get('klipper') or '')[:12]}`:", ""]
        if klipper:
            slowest = max(klipper, key=lambda x: x["ms"])
            out.append(f"- slowest Klipper file: `{slowest['name'][len('klipper: '):]}` in {slowest['ms']} ms (limit {limits.get('compileMs')} ms)")
        if "peakMemoryBytes" in r and "memoryBytes" in limits:
            out.append(f"- peak instance memory: {r['peakMemoryBytes'] / 2**20:.0f} MB (limit {limits['memoryBytes'] / 2**20:.0f} MB)")
        reuse = r.get("reuse")
        if reuse:
            verdict = "stable" if reuse.get("stable") else "unstable"
            out.append(
                f"- one reused instance over {reuse['runs']} compiles: {verdict} ({reuse['failures']} failures, "
                f"{reuse['mismatches']} output differences), {reuse['avgMsReused']} ms per compile against "
                f"{reuse['avgMsFresh']} ms with a fresh instance"
            )
        out.append("- the full report is the `smoke-report` artifact of the workflow run")
    print("\n".join(out))


if __name__ == "__main__":
    main()
