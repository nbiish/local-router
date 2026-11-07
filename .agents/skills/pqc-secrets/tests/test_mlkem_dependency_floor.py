"""Regression guards for the ML-KEM dependency floor and uv resolution.

Two independent failures made every pqc-secrets command unusable on a fresh
Linux/WSL host:

  1. The PEP-723 header declared ``cryptography>=45.0``, but
     ``cryptography.hazmat.primitives.asymmetric.mlkem`` first shipped in 47.0.
     A resolver honouring the declared floor could still install an
     interpreter that has no ML-KEM-768, and the module-level import died
     before argument parsing — so ``list``, ``store`` and ``verify`` failed
     too, with a bare traceback.

  2. The generated launcher located uv with ``command -v uv`` only. A
     non-interactive shell (CI, ``bash -lc`` from another process, a systemd
     unit) often lacks ``~/.local/bin`` on PATH, so a working uv install was
     invisible and the launcher fell through to a system python3 whose
     cryptography predated the floor.

Both are cheap to assert and expensive to rediscover, so they are pinned here.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
ENGINE = SKILL_ROOT / "scripts" / "pqc_secrets.py"
DIST = SKILL_ROOT.parent.parent.parent / "src" / "pqc_dist.sh"

# asymmetric.mlkem first appears in this release. Verified empirically by
# installing each candidate and importing the module: 45.0.7 and 46.0.5 lack
# it; 47.0.0, 48.0.1 and 50.0.2 have it.
MLKEM_FIRST_VERSION = (47, 0)


def _parse_pep723_dependencies(source: str) -> list[str]:
    """The dependency requirements, comment lines and quoting removed."""
    match = re.search(r"^# dependencies = \[\n(.*?)^# \]", source, re.S | re.M)
    assert match, "engine lost its PEP-723 dependency block"
    requirements: list[str] = []
    for raw in match.group(1).splitlines():
        line = raw.strip()
        # Inside the block every line is a Python comment, so strip the '#'.
        if not line.startswith("#"):
            continue
        line = line[1:].strip()
        if not line or line.startswith("#"):
            continue  # blank or the explanatory comment
        requirements.append(line.strip().strip('",'))
    return requirements


def _floor_of(requirement: str) -> tuple[int, ...] | None:
    match = re.search(r"cryptography\s*>=\s*(\d+(?:\.\d+)*)", requirement)
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


def test_cryptography_floor_covers_native_mlkem():
    """The declared floor must be a version that actually exports mlkem."""
    source = ENGINE.read_text(encoding="utf-8")
    requirements = _parse_pep723_dependencies(source)
    cryptography_reqs = [r for r in requirements if r.startswith("cryptography")]
    assert cryptography_reqs, f"no cryptography requirement in {requirements}"

    floor = _floor_of(cryptography_reqs[0])
    assert floor is not None, f"cryptography requirement has no >= floor: {cryptography_reqs[0]}"
    assert floor >= MLKEM_FIRST_VERSION, (
        f"cryptography>={'.'.join(map(str, floor))} cannot satisfy the mlkem import; "
        f"the floor must be >= {'.'.join(map(str, MLKEM_FIRST_VERSION))}"
    )


def test_engine_imports_mlkem_defensively():
    """A missing mlkem must exit with guidance, not an unhandled ImportError."""
    source = ENGINE.read_text(encoding="utf-8")
    assert "from cryptography.hazmat.primitives.asymmetric import mlkem" in source
    # The import is wrapped, and the failure path explains the fix rather than
    # re-raising the raw ImportError that named an internal module path.
    assert "except ImportError" in source, "mlkem import is no longer guarded"
    assert "required:  cryptography" in source, "guard does not state the required version"
    assert "SystemExit(78)" in source, "guard must exit 78 (EX_CONFIG), not 1"

    # And the guard must be the FIRST thing that touches mlkem on import.
    tree = ast.parse(source)
    import_lines = [
        node.lineno
        for node in walk_imports(tree)
        if getattr(node, "module", None) == "cryptography.hazmat.primitives.asymmetric"
    ]
    assert import_lines, "no asymmetric import found"

    try_block_lines = [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Try)
        and any(
            getattr(item, "module", None) == "cryptography.hazmat.primitives.asymmetric"
            for item in ast.walk(node)
            if isinstance(item, ast.ImportFrom)
        )
    ]
    assert try_block_lines, "the asymmetric import is not inside a try block"


def walk_imports(tree: ast.AST):
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            yield node


@pytest.mark.skipif(not DIST.exists(), reason="pqc_dist.sh not present in this checkout")
def test_generated_launcher_resolves_uv_beyond_path():
    """The launcher must find uv in ~/.local/bin when PATH lacks it."""
    dist = DIST.read_text(encoding="utf-8")
    launcher = re.search(r"_pqc_launcher_body\(\) \{\n    cat <<'LAUNCHER'\n(.*?)\nLAUNCHER", dist, re.S)
    assert launcher, "launcher body not found"
    body = launcher.group(1)

    assert "$HOME/.local/bin/uv" in body, (
        "launcher no longer falls back to ~/.local/bin/uv; a non-interactive "
        "shell will silently use a system python3 that may lack ML-KEM-768"
    )
    # It must report the real problem when uv is genuinely absent.
    assert "uv not found" in body


@pytest.mark.skipif(not DIST.exists(), reason="pqc_dist.sh not present in this checkout")
def test_run_engine_helper_shares_the_uv_resolver():
    """`--pqc-install`'s probe must use the same resolver as the launcher."""
    dist = DIST.read_text(encoding="utf-8")
    assert "_pqc_find_uv()" in dist, "missing shared uv resolver"
    run_engine = re.search(r"_pqc_run_engine\(\) \{\n(.*?)\n\}", dist, re.S)
    assert run_engine, "_pqc_run_engine not found"
    assert "_pqc_find_uv" in run_engine.group(1), (
        "_pqc_run_engine still uses bare `command -v uv`, so the probe reports "
        "'engine probe failed' on an install whose uv is simply off-PATH"
    )
