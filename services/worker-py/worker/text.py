"""SimHash fingerprints. Uses the Rust extension (crates/core) when importable."""

from collections.abc import Callable

FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
MASK = (1 << 64) - 1
# Must match `is_separator` in crates/core/src/lib.rs.
_SEPARATORS = bytes(
    [*range(33, 48), *range(58, 65), *range(91, 97), *range(123, 127), *b" \t\n\r\x0b\x0c"]
)
_TO_SPACE = bytes.maketrans(_SEPARATORS, b" " * len(_SEPARATORS))


def simhash_py(text: str) -> int:
    """Pure-Python reference implementation; the Rust version must match it bit for bit."""
    weights = [0] * 64
    for token in text.encode().lower().translate(_TO_SPACE).split():
        h = FNV_OFFSET
        for byte in token:
            h = ((h ^ byte) * FNV_PRIME) & MASK
        for bit in range(64):
            weights[bit] += 1 if (h >> bit) & 1 else -1
    return sum(1 << bit for bit, weight in enumerate(weights) if weight > 0)


simhash: Callable[[str], int]
try:
    from saas_core import simhash as _rust_simhash

    simhash = _rust_simhash
except ImportError:  # no wheel for this platform: stay correct, just slower
    simhash = simhash_py

backend = "python" if simhash is simhash_py else "rust"
