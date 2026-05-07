#!/usr/bin/env python3
"""
One-shot helper: swap the legacy `return 444` default_server block
in /etc/nginx/sites-enabled/gbox for the catch-all we need to reach
the storefront on custom seller domains.

Safe to re-run — idempotent: if the catch-all is already in place,
it's a no-op.
"""
from __future__ import annotations

import pathlib
import re
import sys

SITES = pathlib.Path("/etc/nginx/sites-enabled/gbox")
CATCHALL = pathlib.Path("/tmp/gbox-catchall.conf")

MARKER_OLD = "# DEFAULT — drop unknown hostnames"
MARKER_NEW = "# CATCH-ALL — forward unknown Host headers to storefront"


def main() -> int:
    if not SITES.exists():
        print(f"FAIL: {SITES} not found", file=sys.stderr)
        return 1
    if not CATCHALL.exists():
        print(f"FAIL: {CATCHALL} not found", file=sys.stderr)
        return 1

    content = SITES.read_text()
    replacement = CATCHALL.read_text()

    # Idempotency: if the new catch-all marker already exists, skip.
    if MARKER_NEW in content:
        print("SKIP: catch-all already installed")
        return 0

    pattern = re.compile(
        r"# ═+\s*\n"
        + re.escape(MARKER_OLD)
        + r"\s*\n# ═+\s*\nserver \{[^}]*return 444;\s*\}\s*$",
        re.MULTILINE,
    )
    new_content, n = pattern.subn(replacement.rstrip() + "\n", content)
    if n != 1:
        print(f"FAIL: matched {n} times, expected 1", file=sys.stderr)
        return 2

    SITES.write_text(new_content)
    print("OK: replaced default_server block")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
