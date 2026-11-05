# 0005. License policy

Status: accepted

## Context

The starter is MIT-0 so anyone can use it without obligations. That only holds if nothing we
pull in brings copyleft or source-available terms.

## Decision

- Every code dependency (npm, PyPI, crates.io; runtime and dev) must be one of: MIT, MIT-0, ISC,
  BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, Unlicense, CC0-1.0, BlueOak-1.0.0, PostgreSQL,
  Python-2.0. SPDX `OR` passes if any branch is allowed, `AND` only if all are.
- For Python packages the gate reads the PEP 639 `License-Expression` when present; otherwise a
  package passes if its declared `License` field or its trove classifiers are allowed (many
  packages declare `Apache-2.0` in the field but only the vaguer "Apache Software License"
  classifier), and no classifier names a copyleft or source-available family. The allowlist is
  the same for every source.
- `pnpm check:licenses` (`scripts/license-check.mjs`) enforces it for npm and the Python venv and runs
  `cargo deny check` (licenses + RustSec advisories) for Rust. It also fails if a container image
  is not documented in `docs/LICENSES.md`. CI runs it on every push.
- Narrow, documented exceptions only:
  - Python `typing_extensions` declares `PSF-2.0`, treated as `Python-2.0`.
  - Rust `unicode-ident` (`Unicode-3.0`) and `target-lexicon` (`Apache-2.0 WITH LLVM-exception`)
    are build-time-only crates of PyO3 (proc macros / build script), not compiled into the wheel.
    Both are permissive.
- Infrastructure runs as separate, unmodified containers. Their licenses are listed in
  `docs/LICENSES.md`; all are permissive. Grafana (AGPL) is mentioned as optional, not shipped.

## Consequences

- Tailwind v3 instead of v4, Vite 7 instead of 8 (their newer engines depend on `lightningcss`,
  MPL-2.0). Revisit if that changes.
- Python OTLP export uses gRPC (`requests`/`certifi` would bring MPL-2.0), Python type checking
  uses pyright (mypy depends on MPL-2.0 `pathspec`).
