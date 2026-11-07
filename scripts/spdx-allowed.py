"""SPDX expression check for scripts/license-check.mjs, with `license-expression` (Apache-2.0).

stdin: {"allowed": [SPDX ids], "expressions": [str]}; stdout: one true/false per expression.
`OR` passes if any branch is allowed, `AND` only if all are. Fail closed: an expression the
library cannot parse or that names an unknown id is false, and so is any `WITH` exception.
Run through the worker venv: `uv run --project services/worker-py python scripts/spdx-allowed.py`.
"""

import json
import sys

from license_expression import LicenseSymbol, LicenseWithExceptionSymbol, get_spdx_licensing

licensing = get_spdx_licensing()


def check(expression: str, allowed: set[str]) -> bool:
    try:
        tree = licensing.parse(expression, validate=True, strict=True)
    except Exception:  # the library raises several types (even AttributeError) on bad input
        return False

    def ok(node: object) -> bool:
        if isinstance(node, LicenseWithExceptionSymbol):
            return False  # exceptions are reviewed one by one (deny.toml), never here
        if isinstance(node, LicenseSymbol):
            return node.key in allowed
        args: tuple[object, ...] = getattr(node, "args", ())
        if isinstance(node, licensing.OR):
            return any(map(ok, args))
        if isinstance(node, licensing.AND):
            return all(map(ok, args))
        return False

    return tree is not None and ok(tree)


if __name__ == "__main__":
    req = json.load(sys.stdin)
    allowed = set(req["allowed"])
    json.dump([check(e, allowed) for e in req["expressions"]], sys.stdout)
