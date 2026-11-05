//! Hot paths for the Python worker, exposed via PyO3 as the `saas_core` module.
//! Every function here has a pure-Python twin (services/worker-py/worker/text.py)
//! and a parity test, so the worker still runs where the wheel is unavailable.

use pyo3::prelude::*;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn is_separator(b: u8) -> bool {
    b.is_ascii_punctuation() || matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV_OFFSET, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(FNV_PRIME)
    })
}

/// 64-bit SimHash of `text`: ASCII-lowercased, split on ASCII whitespace and
/// punctuation, every token hashed with FNV-1a. Near-duplicate texts get
/// fingerprints with a small Hamming distance.
pub fn simhash(text: &str) -> u64 {
    let lower = text.to_ascii_lowercase();
    let mut weights = [0i64; 64];
    for token in lower.as_bytes().split(|&b| is_separator(b)) {
        if token.is_empty() {
            continue;
        }
        let h = fnv1a(token);
        for (bit, w) in weights.iter_mut().enumerate() {
            *w += if (h >> bit) & 1 == 1 { 1 } else { -1 };
        }
    }
    weights
        .iter()
        .enumerate()
        .filter(|&(_, &w)| w > 0)
        .fold(0, |acc, (bit, _)| acc | (1 << bit))
}

#[pyfunction(name = "simhash")]
fn py_simhash(text: &str) -> u64 {
    simhash(text)
}

#[pymodule]
fn saas_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(py_simhash, m)?)
}

#[cfg(test)]
mod tests {
    use super::simhash;

    #[test]
    fn empty_and_separators_only_hash_to_zero() {
        assert_eq!(simhash(""), 0);
        assert_eq!(simhash(" ,.!? \t\n"), 0);
    }

    #[test]
    fn ignores_ascii_case_and_punctuation() {
        assert_eq!(simhash("Hello, World!"), simhash("hello world"));
    }

    #[test]
    fn near_duplicates_are_closer_than_unrelated_texts() {
        let a = simhash("the quick brown fox jumps over the lazy dog");
        let b = simhash("the quick brown fox jumped over the lazy dog");
        let c = simhash("quarterly revenue grew in every region");
        assert!((a ^ b).count_ones() < (a ^ c).count_ones());
    }
}
