#!/usr/bin/env python3
"""Rewrite ATfE's multilib.yaml for the clang of this toolchain.

The Arm Toolchain for Embedded ships a multilib.yaml whose variants carry an
``IncludeDirs`` key. clang 23.1.4 does not know that key, rejects the whole
file ("unknown key 'IncludeDirs'", then "undefined group name") and so cannot
select any library variant by itself. This script drops every ``IncludeDirs``
block and leaves the rest of the file untouched: the variant directories, the
flag matching and the exclusive group still work, and clang 23.1.4 adds the
``<variant>/include`` directory on its own.

Usage: multilib_yaml.py <in> <out>

No YAML library is used on purpose (the build runners have none); the file is
handled line by line, which is enough for ATfE's generated layout: a key, then
its list items at a deeper indentation.
"""
import re
import sys

DROP_KEYS = ("IncludeDirs",)
NOTE = "# IncludeDirs blocks removed by webflash-toolchain (scripts/multilib_yaml.py): clang 23 does not accept them.\n"


def rewrite(text: str) -> tuple[str, int]:
    out = []
    dropped = 0
    skip_indent = None
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if skip_indent is not None:
            # Inside a dropped block: its list items are indented deeper than
            # the key, or start with "- " at the key's own indentation.
            if line.strip() == "" or indent > skip_indent or (indent == skip_indent and stripped.startswith("- ")):
                continue
            skip_indent = None
        m = re.match(r"([A-Za-z_]+):\s*$", stripped)
        if m and m.group(1) in DROP_KEYS:
            skip_indent = indent
            dropped += 1
            continue
        out.append(line)
    return "".join(out), dropped


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: multilib_yaml.py <in> <out>")
    with open(sys.argv[1], encoding="utf-8") as f:
        text = f.read()
    result, dropped = rewrite(text)
    if dropped == 0:
        sys.exit(f"{sys.argv[1]}: no IncludeDirs block found; the ATfE layout changed, check the file")
    with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as f:
        f.write(NOTE + result)
    print(f"{sys.argv[2]}: {dropped} IncludeDirs blocks removed")


if __name__ == "__main__":
    main()
