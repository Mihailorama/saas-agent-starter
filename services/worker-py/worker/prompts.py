"""Prompt templates live in git: prompts/<purpose>/<name>.v<N>.md (docs/adr/0009-llm-ops.md).

A prompt is code: a changed text is a new version file, never an edit of a released one
(prompts/lock.json pins each version's hash; tests/test_prompts.py enforces it). Callers always
name the version explicitly, and it is logged on every ai_calls row.
"""

from dataclasses import dataclass
from functools import cache

from worker import settings


@dataclass(frozen=True)
class Prompt:
    id: str  # "<purpose>/<name>", logged as ai_calls.prompt_template_id
    version: str  # "<N>", logged as ai_calls.prompt_template_version
    text: str

    def render(self, **values: str) -> str:
        """Replaces {{key}} placeholders (same syntax Promptfoo's Nunjucks reads)."""
        out = self.text
        for key, value in values.items():
            out = out.replace("{{" + key + "}}", value)
        return out


@cache
def load(prompt_id: str, version: int) -> Prompt:
    path = settings.PROMPTS_DIR / f"{prompt_id}.v{version}.md"
    return Prompt(prompt_id, str(version), path.read_text().strip())
