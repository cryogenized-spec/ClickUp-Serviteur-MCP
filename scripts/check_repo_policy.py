#!/usr/bin/env python3
"""Fail-closed foundation validator. No external Python dependencies.

This does not replace required branch rules, code review or MCP conformance.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ERRORS: list[str] = []
REQUIRED = [
    "README.md", "AGENTS.md", "CLAUDE.md",
    "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md",
    "docs/PUBLIC_RELEASE.md",
    "docs/PROJECT_STATE.md", "docs/DECISIONS.md",
    "docs/ARCHITECTURE_PROPOSAL.md", "docs/MCP_COMPLIANCE.md",
    "docs/MODULARITY.md", "docs/SKILLS.md", "docs/BRANCH_PROTECTION.md",
    "docs/DEMO_ACCEPTANCE.md", "docs/WORKFLOW.md",
    "docs/POC_V0_1_REFERENCE.md", "docs/phases/ROADMAP.md",
    "docs/CODEX_REVIEW.md", "docs/SECURITY_PERIMETER.md",
    "docs/superpowers/specs/2026-10-10-phase1-perimeter-design.md",
    "docs/superpowers/plans/2026-10-10-phase1-perimeter.md",
    "docs/PHASE3_SETUP.md",
    "docs/superpowers/specs/2026-10-10-phase3-auth-design.md",
    "docs/superpowers/plans/2026-10-10-phase3-auth.md",
    "tsconfig.auth.json", "tsconfig.mcp.json",
    ".github/workflows/strict-ci.yml",
    ".github/CODEOWNERS", ".github/dependabot.yml",
]

def error(message: str) -> None:
    ERRORS.append(message)
    print("ERROR: " + message, file=sys.stderr)

def require_file(path: str) -> Path:
    file = ROOT / path
    if not file.is_file() or file.is_symlink():
        error("Required file missing or symlinked: " + path)
    return file

def git_blob(data: bytes) -> str:
    return hashlib.sha1(("blob %d\\0" % len(data)).encode().replace(b"\\0", b"\0") + data).hexdigest()

def verify_skills() -> None:
    manifest_file = require_file(".agents/skills/upstream-manifest.json")
    if not manifest_file.is_file():
        return
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        error("Unreadable skill manifest: " + str(exc))
        return
    ref = manifest.get("vendorRef", "")
    if manifest.get("vendor") != "obra/superpowers" or not re.fullmatch(r"[a-f0-9]{40}", ref):
        error("Unexpected or unpinned upstream vendor")
    entries = manifest.get("entries")
    if not isinstance(entries, list) or len(entries) != 14:
        error("Unexpected number of pinned skills/license entries")
        return
    found: set[str] = set()
    for entry in entries:
        path = entry.get("path", "")
        source = entry.get("source", "")
        expected = entry.get("gitBlobSha", "")
        if (not isinstance(path, str) or not path.startswith(".agents/skills/")
                or ".." in Path(path).parts or path in found):
            error("Duplicate/unsafe skill manifest path: " + str(path))
            continue
        found.add(path)
        file = require_file(path)
        if not file.is_file() or file.is_symlink():
            continue
        actual = git_blob(file.read_bytes())
        if actual != expected:
            error(f"Vendored upstream blob changed: {path}, got {actual}")
        if not source.startswith(f"https://github.com/obra/superpowers/blob/{ref}/"):
            error("Unpinned upstream source URL: " + path)
        if path.endswith("/SKILL.md"):
            text = file.read_text(encoding="utf-8")
            if not (text.startswith("---\n") and re.search(r"^name:\s*\S+", text, re.M)
                    and re.search(r"^description:\s*\S+", text, re.M)):
                error("Malformed SKILL.md frontmatter: " + path)
    stray = {p.relative_to(ROOT).as_posix()
             for p in (ROOT / ".agents/skills").rglob("*")
             if p.is_file() and p.name != "upstream-manifest.json"} - found
    if stray:
        error("Unpinned upstream skill file(s): " + ", ".join(sorted(stray)))

def verify_phase3_typecheck(scripts: dict[str, str]) -> None:
    """Fail closed if a future change silently drops an isolated strict typecheck."""
    expected = (
        "tsc -p tsconfig.auth.json --noEmit && "
        "tsc -p tsconfig.mcp.json --noEmit && "
        "tsc -p tsconfig.json --noEmit"
    )
    if scripts.get("typecheck") != expected:
        error("Phase 3 must run strict auth + MCP + combined TS checks")
    for path, expected_types in (
        ("tsconfig.auth.json", ["@cloudflare/workers-types"]),
        ("tsconfig.mcp.json", ["node"]),
    ):
        file = require_file(path)
        if not file.is_file():
            continue
        try:
            cfg = json.loads(file.read_text(encoding="utf-8"))
            compiler = cfg.get("compilerOptions", {})
            if (cfg.get("extends") != "./tsconfig.json"
                or compiler.get("skipLibCheck") is not False
                or compiler.get("strict") is False
                or compiler.get("types") != expected_types):
                error("Weakened isolated TypeScript profile: " + path)
        except (OSError, ValueError, AttributeError) as exc:
            error("Invalid isolated TS profile " + path + ": " + str(exc))

def verify_application() -> None:
    excluded = {".git", ".github", ".agents", "node_modules", "dist", "build", "coverage"}
    code_files = [
        p for p in ROOT.rglob("*")
        if p.is_file()
        and p.suffix in {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
        and not any(part in excluded for part in p.relative_to(ROOT).parts)
    ]
    ts_files = [p for p in code_files if p.suffix in {".ts", ".tsx", ".mts", ".cts"}]
    package = ROOT / "package.json"
    lockfile = ROOT / "package-lock.json"
    if not (code_files or package.exists() or lockfile.exists()):
        print("Docs-only stage: TypeScript checks are NOT yet applicable.")
        return
    for name in ("package.json", "package-lock.json", "tsconfig.json", "eslint.config.js"):
        require_file(name)
    if not package.is_file():
        return
    try:
        config = json.loads(package.read_text(encoding="utf-8"))
    except ValueError as exc:
        error("Invalid package.json: " + str(exc))
        return
    scripts = config.get("scripts", {})
    for name in ("format:check", "lint", "typecheck", "test", "build"):
        command = scripts.get(name, "")
        if (not isinstance(command, str) or not command.strip()
                or re.search(r"(^|\s)(echo|true|exit\s+0)(\s|$)|\|\|\s*true", command)):
            error("Missing or obvious no-op npm script: " + name)
    if (ROOT / "src/auth/oauth-runtime.ts").is_file():
        verify_phase3_typecheck(scripts)
    tsconfig = ROOT / "tsconfig.json"
    if tsconfig.is_file():
        try:
            compiler = json.loads(tsconfig.read_text(encoding="utf-8")).get("compilerOptions", {})
        except ValueError as exc:
            error("Invalid tsconfig.json: " + str(exc))
            return
        for flag in ("strict", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes",
                     "noImplicitOverride", "noFallthroughCasesInSwitch"):
            if compiler.get(flag) is not True:
                error("Must enable TypeScript compiler option: " + flag)
    for file in ts_files:
        content = file.read_text(encoding="utf-8")
        if "@ts-nocheck" in content or "@ts-ignore" in content:
            error("TypeScript checking suppressed in: " + str(file.relative_to(ROOT)))

def verify_public_brand_neutrality() -> None:
    """Reject former employer branding anywhere in the checked-in source tree.

    The marker is encoded to avoid introducing it into this public source.
    Ignore generated dependencies and local Git state, never tracked files.
    """
    marker = bytes.fromhex("6e656f6e73616c6573")
    ignored = {".git", "node_modules", "dist", "build", "coverage", "__pycache__", ".venv", ".wrangler"}
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        parts = path.relative_to(ROOT).parts
        if any(part in ignored for part in parts):
            continue
        try:
            if marker in path.read_bytes().lower():
                error("Legacy organization branding remains in: " + path.relative_to(ROOT).as_posix())
        except OSError as exc:
            error("Cannot check source branding: " + str(exc))

def main() -> int:
    for path in REQUIRED:
        require_file(path)
    verify_skills()
    verify_application()
    verify_public_brand_neutrality()
    if ERRORS:
        print(f"FAILED: {len(ERRORS)} policy error(s)", file=sys.stderr)
        return 1
    print("PASS: foundation documentation, pinned external skills and stage policy")
    return 0

if __name__ == "__main__":
    sys.exit(main())
