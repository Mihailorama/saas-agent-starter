# 0006. TypeScript, Python and Rust (PyO3)

Status: accepted

## Context

The product surface (API, UI) is best served by TypeScript. AI/LLM and data work lives in the
Python ecosystem. Some Python hot paths are too slow.

## Decision

- TypeScript for API and web. Python for AI/data processing, as Temporal activities.
- Rust only for hot paths measured in Python, in `crates/core`, exposed via PyO3 and built with
  maturin as an abi3 wheel (one wheel for Python 3.12+), compiled inside the worker image.
- Every Rust function keeps a pure-Python twin, a parity test (Rust == Python on generated
  inputs) and a benchmark (`pnpm bench`; the example SimHash is ~100-200x faster).

## Consequences

- Three toolchains in the gate (Biome/tsc, ruff/pyright/pytest, fmt/clippy/cargo test).
- Contracts between TS and Python are workflow names and JSON argument shapes; they are tested
  end to end against a real Temporal server.
