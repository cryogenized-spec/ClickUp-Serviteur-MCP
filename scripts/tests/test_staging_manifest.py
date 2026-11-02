"""Regression checks for the staging manifest generator (no cloud credentials)."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "scripts/generate-staging-config.mjs"


class StagingManifestTests(unittest.TestCase):
    def generate(self, owner_ids: str | None = None) -> tuple[subprocess.CompletedProcess[str], dict | None]:
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ.copy()
            env["STAGING_OAUTH_KV_ID"] = "a" * 32  # Fake, syntactically valid test namespace.
            if owner_ids is None:
                env.pop("STAGING_WORKSPACE_GITHUB_IDS", None)
            else:
                env["STAGING_WORKSPACE_GITHUB_IDS"] = owner_ids
            result = subprocess.run(
                ["node", str(GENERATOR)],
                cwd=directory,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            path = Path(directory) / ".wrangler-staging.generated.jsonc"
            return result, json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

    def test_default_repository_owner_is_accepted(self) -> None:
        result, config = self.generate()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIsNotNone(config)
        assert config is not None
        self.assertEqual("256972168", config["vars"]["CLICKUP_WORKSPACE_GITHUB_IDS"])
        self.assertEqual("workspace", config["vars"]["CLICKUP_RESOURCE_SCOPE"])
        self.assertEqual("neonsales-clickup-mcp-staging", config["name"])
        self.assertTrue(config["keep_vars"])

    def test_explicit_numeric_owner_allowlist_is_accepted(self) -> None:
        result, config = self.generate("256972168,123456789")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIsNotNone(config)
        assert config is not None
        self.assertEqual("256972168,123456789", config["vars"]["CLICKUP_WORKSPACE_GITHUB_IDS"])

    def test_malformed_owner_allowlist_is_rejected_before_deployment(self) -> None:
        for value in ("abc", "0", "256972168,", "256972168,,123", "256972168;123"):
            with self.subTest(value=value):
                result, config = self.generate(value)
                self.assertNotEqual(0, result.returncode)
                self.assertIsNone(config)
                self.assertIn("STAGING_WORKSPACE_GITHUB_IDS", result.stderr)


if __name__ == "__main__":
    unittest.main()
