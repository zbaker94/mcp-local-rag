#!/usr/bin/env python3
"""Emit a markdown digest of a pyproject.toml. Used by context-sync.sh.

Usage: _pyproject_digest.py <pyproject.toml> <source-root>

<source-root> is only used to render a project-relative path; if the manifest
is not under it, the absolute parent path is shown instead. Requires Python
3.11+ (stdlib tomllib).
"""
import sys
import tomllib
from pathlib import Path

path = Path(sys.argv[1])
root = Path(sys.argv[2])
try:
    rel = path.parent.relative_to(root)
    rel = str(rel) if str(rel) != "." else "(root)"
except ValueError:
    rel = str(path.parent)

try:
    data = tomllib.loads(path.read_text(encoding="utf-8"))
except Exception as e:  # noqa: BLE001 - digest should never hard-fail the sweep
    print(f"# pyproject (unparseable)\n\n- **Project path:** `{rel}`\n- {e}")
    sys.exit(0)

proj = data.get("project", {})
poetry = data.get("tool", {}).get("poetry", {})
name = proj.get("name") or poetry.get("name") or "(unnamed)"
version = proj.get("version") or poetry.get("version") or "n/a"
desc = proj.get("description") or poetry.get("description")

out = [f"# Python package: {name}", "",
       f"- **Project path:** `{rel}`",
       "- **Source:** `pyproject.toml`",
       f"- **Version:** {version}"]
if desc:
    out.append(f"- **Description:** {desc}")

# Dependencies: PEP 621 list or poetry table.
deps = proj.get("dependencies")
if isinstance(deps, list) and deps:
    out += ["", "## Dependencies"] + [f"- {d}" for d in deps]
elif isinstance(poetry.get("dependencies"), dict):
    out += ["", "## Dependencies"] + [
        f"- {k} {v}" for k, v in poetry["dependencies"].items()]

# Console scripts / entrypoints.
scripts = proj.get("scripts") or poetry.get("scripts")
if isinstance(scripts, dict) and scripts:
    out += ["", "## Scripts / entrypoints"] + [
        f"- `{k}` -> `{v}`" for k, v in scripts.items()]

print("\n".join(out))
