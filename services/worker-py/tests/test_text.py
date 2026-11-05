import random

import saas_core

from worker.text import simhash_py

ALPHABET = "abcXYZ019 ,.;!?-_'\"\t\n\x0b\x0c\x1féüß漢字🙂İΣ"


def random_texts(n: int) -> list[str]:
    rng = random.Random(42)  # noqa: S311 - deterministic test data, not crypto
    return ["".join(rng.choices(ALPHABET, k=rng.randint(0, 80))) for _ in range(n)]


def test_rust_matches_python() -> None:
    for text in ["", " ,. ", "Hello, World!", "a b a", *random_texts(5000)]:
        assert saas_core.simhash(text) == simhash_py(text), repr(text)


def test_case_and_punctuation_insensitive() -> None:
    assert simhash_py("Hello, World!") == simhash_py("hello world")


def test_near_duplicates_are_closer() -> None:
    a = simhash_py("the quick brown fox jumps over the lazy dog")
    b = simhash_py("the quick brown fox jumped over the lazy dog")
    c = simhash_py("quarterly revenue grew in every region")
    assert (a ^ b).bit_count() < (a ^ c).bit_count()
