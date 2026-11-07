"""Prompt = code: released prompt versions never change, and every purpose has an eval."""

import hashlib
import json
import re

from worker import prompts, settings

ROOT = settings.PROMPTS_DIR
LOCK = json.loads((ROOT / "lock.json").read_text())
FILES = {str(p.relative_to(ROOT))[:-3]: p for p in sorted(ROOT.rglob("*.md"))}


def test_released_prompt_versions_are_immutable():
    for key, path in FILES.items():
        assert re.fullmatch(r"[a-z0-9_.-]+/[a-z0-9_.-]+\.v[1-9][0-9]*", key), key
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert LOCK.get(key) == digest, (
            f"{key}.md is new or was edited. Released versions are immutable: put changed text"
            f' in a new .v<N+1>.md file. For a new file add "{key}": "{digest}" to'
            " prompts/lock.json."
        )
    assert set(LOCK) <= set(FILES), f"lock.json lists missing files: {set(LOCK) - set(FILES)}"


def test_every_prompted_purpose_has_an_eval_and_judge_targets_exist():
    purposes = {key.split("/")[0] for key in FILES} - {"judge"}
    evals = settings.PROMPTS_DIR.parent / "evals"
    for purpose in purposes:
        assert (evals / purpose / "promptfooconfig.json").is_file(), f"no eval for {purpose}"
    for key in FILES:
        if key.startswith("judge/"):
            assert key.split("/")[1].rsplit(".v", 1)[0] in purposes, key


def test_load_and_render():
    p = prompts.load("judge/project.summary", 1)
    assert (p.id, p.version) == ("judge/project.summary", "1")
    rendered = p.render(input="IN", output="OUT")
    assert "<input>\nIN\n</input>" in rendered and "{{" not in rendered
