# 0005. License policy

Status: accepted

## Context

The starter is MIT-0 so anyone can use it without obligations. That only holds if nothing we
pull in puts copyleft or source-available terms on our own code. Originally that excluded every
copyleft license, including the file-level MPL-2.0, which kept Tailwind on v3 and Vite on v7
(their CSS engine `lightningcss` is MPL-2.0) and shaped a few Python choices.

## Decision

- Every code dependency (npm, PyPI, crates.io; runtime and dev) must be one of: MIT, MIT-0, ISC,
  BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, Unlicense, CC0-1.0, BlueOak-1.0.0, PostgreSQL,
  Python-2.0, Zlib, CNRI-Python, MPL-2.0. SPDX `OR` passes if any branch is allowed, `AND` only
  if all are.
- Zlib and CNRI-Python are allowed (owner decision, 2026-11-07):
  - Zlib: OSI-approved and permissive; it asks only not to misrepresent the origin, to mark
    altered source versions and to keep the notice. `numpy` declares Zlib for bundled parts.
  - CNRI-Python: OSI-approved (listed as superseded, it is part of the Python license stack),
    a royalty-free grant to use, modify and distribute that asks to keep CNRI's agreement and
    summarize changes in derivative works. `regex` declares it.
- Expressions are parsed with `license-expression` (Apache-2.0, `scripts/spdx-allowed.py`), not
  by hand. Package metadata that is not SPDX passes only through an exact alias in
  `scripts/license-check.mjs` (`ALIASES`, e.g. "BSD License", "Apache Software License", "Apache 2.0",
  "Apache License, Version 2.0", "ISC License", "MIT License", owner decision 2026-11-07).
  Everything else fails closed: an unknown id, a string the parser rejects, an ambiguous name
  ("BSD") and any `WITH` exception. The two trove classifiers "BSD License" and
  "Apache Software License" name a family without a version; every member of both families is
  permissive, so they map to BSD-3-Clause and Apache-2.0 (tokenizers, python-dateutil and jinja2
  declare only these). The JS SPDX
  libraries (`spdx-expression-parse`, `spdx-satisfies`, `spdx-correct`) are not used: all of them
  depend on `spdx-exceptions` (CC-BY-3.0), which the allowlist does not include.
  `license-expression` itself ships a CC-BY-4.0 data file (`scancode-licensedb-index.json`):
  accepted by the owner (2026-11-07) because CC-BY only asks to keep the credit, the credit ships
  with the package, and the tool runs in `pnpm check` only, never in a shipped image. This does
  not put CC-BY on the code allowlist. Adding an alias
  or a license is an owner decision, like everything in this ADR.
- MPL-2.0 is allowed (owner decision, 2026-11-05). It is file-level copyleft: its obligations
  attach only to the MPL-licensed files themselves, and only if we modify and distribute them.
  Using an unmodified MPL-2.0 package (as a dependency, bundled or not) puts no obligations on
  our own code, so the starter and the apps built on it stay MIT-0 / any license. MPL 1.x and
  `MPL-2.0-no-copyleft-exception` are not on the list.
- We never modify dependency files: no vendored edits, `pnpm patch`, `patch-package`, forks
  pinned in place of the upstream package, or edits under `node_modules`/`.venv`/the cargo
  registry. A fix goes upstream (issue or pull request), and we wait for a release or work
  around it in our own code. This keeps every dependency, MPL-2.0 ones included, unmodified,
  which is what keeps the MPL out of our code.
- Still banned, in any form (strong or network copyleft, source-available): GPL, LGPL, AGPL,
  EUPL, SSPL, BUSL/BSL, Commons Clause and anything else not on the list.
- For Python packages the gate reads the PEP 639 `License-Expression` when present; otherwise a
  package passes if its declared `License` field or its trove classifiers are allowed (many
  packages declare `Apache-2.0` in the field but only the vaguer "Apache Software License"
  classifier), and no classifier names a disallowed copyleft or source-available family. The
  allowlist is the same for every source.
- `pnpm check:licenses` (`scripts/license-check.mjs`) enforces it for npm and the Python venv and runs
  `cargo deny check` (licenses + RustSec advisories) for Rust. It lists every MPL-2.0 package it
  finds, so they stay visible in review. It also fails if a container image is not documented in
  `docs/LICENSES.md`. CI runs it on every push.
- Narrow, documented exceptions only:
  - Python `typing_extensions` declares `PSF-2.0`, treated as `Python-2.0` (an alias).
  - Rust `unicode-ident` (`Unicode-3.0`) and `target-lexicon` (`Apache-2.0 WITH LLVM-exception`)
    are build-time-only crates of PyO3 (proc macros / build script), not compiled into the wheel.
    Both are permissive.
  - Python `tiktoken` 0.14.0 (via LiteLLM): its License field is the full MIT text, with no
    License-Expression or classifier the gate can read. Checked against its LICENSE file and
    accepted as `MIT` (owner approval 2026-11-07) through `REVIEWED` in
    `scripts/license-check.mjs`: exact name and version only, and the entry's SPDX id still has
    to pass the allowlist, so another version fails again until it is reviewed.
- The allowlist applies only to code dependencies. Infrastructure runs as separate containers,
  run unmodified and not distributed with the app, so their license may be anything, AGPL and
  source-available included (owner decision, 2026-11-05); prefer mainstream tools. Each image
  must be listed in `docs/LICENSES.md` with its license; the gate fails only on an undocumented
  image, never on an image's license.

## Consequences

- Current Tailwind (v4) and Vite (v8) are usable; both use `lightningcss` (MPL-2.0) for CSS.
  Python `requests`/`certifi` (MPL-2.0) are fine too, so the worker exports OTLP over HTTP
  like the API.
- Anyone who needs to change an MPL-2.0 file must do it upstream, not in this repo; a local
  modification would make that file's source distributable under the MPL.
- Python type checking stays on pyright (it was also chosen over mypy because mypy depended
  on MPL-2.0 `pathspec`; that reason is gone, but pyright works and there is no reason to churn).
