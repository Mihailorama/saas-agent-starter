"""Release comments on tracker items (docs/releases.md; run by .github/workflows/released.yml).

    uv run --directory services/worker-py python -m worker.released <tag> [--dry-run]

For every PR merged between the previous v* tag and <tag>, comments "Released in <tag>" on the
tracker items that PR closes: a closing keyword in its title or body (`Fixes PROJ-123` for Plane,
the default; `Closes #12` for TRACKER=github). A bare mention is not enough. Never changes an
item's state. Idempotent: an item that already has the comment for this tag is skipped.
Env: GITHUB_TOKEN (reads the PRs), GITHUB_REPOSITORY (owner/name; default: the origin remote),
GITHUB_API_URL / GITHUB_SERVER_URL (GitHub Enterprise Server) and the tracker's variables
(worker/settings.py). No tracker credentials = nothing to do.
"""

import asyncio
import os
import re
import subprocess
import sys

import httpx2

from worker import settings
from worker.tracker import DryRunTracker, GitHub, Tracker, connect


def git(*args: str) -> str:
    return subprocess.run(  # noqa: S603 - fixed binary, our own arguments
        ["git", *args],  # noqa: S607
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def release_commits(tag: str) -> tuple[str | None, list[str]]:
    """Commits from the previous v* tag (exclusive) to `tag`; all history for the first release."""
    try:
        prev: str | None = git("describe", "--tags", "--abbrev=0", "--match", "v*", f"{tag}^")
    except subprocess.CalledProcessError:
        prev = None  # first release
    return prev, git("log", "--format=%H", f"{prev}..{tag}" if prev else tag).split()


def released_comment(tag: str, pr: int, repo: str) -> str:
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    return f"Released in {tag} (via #{pr}). Release notes: {server}/{repo}/releases/tag/{tag}"


async def comment_release(
    tag: str, shas: list[str], tracker: Tracker, gh: GitHub, *, dry_run: bool = False
) -> dict[str, str]:
    """ref -> what happened (commented | already | planned | unreadable)."""
    prs: dict[int, str] = {}  # number -> title + body
    for sha in shas:
        for pr in await gh.merged_prs(sha):
            prs[int(pr["number"])] = f"{pr.get('title') or ''}\n{pr.get('body') or ''}"
    items: dict[str, int] = {}  # tracker ref -> PR that shipped it
    for number, text in sorted(prs.items()):
        for ref in await tracker.closed_by(text):
            items.setdefault(ref, number)
    done: dict[str, str] = {}
    for ref, pr in items.items():
        status = await tracker.read(ref)
        if status is None:
            done[ref] = "unreadable"
        elif any(f"Released in {tag} " in t for t in status.texts):
            done[ref] = "already"
        elif dry_run:
            done[ref] = "planned"
        else:
            await tracker.comment(ref, released_comment(tag, pr, gh.repo))
            done[ref] = "commented"
    return done


async def main(tag: str, dry_run: bool) -> None:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not repo:
        origin = re.search(r"github\.com[:/](.+?)(\.git)?$", git("remote", "get-url", "origin"))
        repo = origin.group(1) if origin else ""
    async with httpx2.AsyncClient(timeout=30) as http:
        gh = GitHub(repo, os.environ["GITHUB_TOKEN"], http, settings.GITHUB_API_URL)
        tracker: Tracker = gh if settings.TRACKER == "github" else await connect(http)
        if isinstance(tracker, DryRunTracker):
            print(f"{tag}: no {settings.TRACKER} tracker credentials, nothing to do")
            return
        prev, shas = release_commits(tag)
        print(f"{tag}: {len(shas)} commits since {prev or 'the first commit'} in {repo}")
        for ref, what in (await comment_release(tag, shas, tracker, gh, dry_run=dry_run)).items():
            print(f"  {tracker.name} {ref}: {what}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1 or not os.environ.get("GITHUB_TOKEN"):
        raise SystemExit("usage: GITHUB_TOKEN=... python -m worker.released <tag> [--dry-run]")
    asyncio.run(main(args[0], "--dry-run" in sys.argv))
