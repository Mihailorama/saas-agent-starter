"""Prints the Rust vs pure-Python SimHash speedup: `uv run python bench.py`."""

import random
import time
from collections.abc import Callable

from saas_core import simhash as rust

from worker.text import simhash_py

rng = random.Random(0)  # noqa: S311
WORDS = [f"word{i}" for i in range(5000)]
TEXTS = [" ".join(rng.choices(WORDS, k=200)) for _ in range(2000)]


def run(fn: Callable[[str], int]) -> float:
    start = time.perf_counter()
    for text in TEXTS:
        fn(text)
    return time.perf_counter() - start


py, rs = run(simhash_py), run(rust)
print(f"{len(TEXTS)} texts x 200 words: python {py:.3f}s, rust {rs:.3f}s, speedup {py / rs:.0f}x")
