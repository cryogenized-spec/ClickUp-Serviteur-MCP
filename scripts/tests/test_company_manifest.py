"""Isolated non-destructive company manifest tests. No real credentials."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "scripts/generate-company-config.mjs"
VALID = {
    "COMPANY_OAUTH_KV_ID": "b" * 32,
    "COMPANY_WORKSPACE_ID": "5555555555",
    "COMPANY_LIST_ID": "6666666666",
    "COMPANY_GITHUB_OWNER_ID": "77777777",
    "COMPANY_CLICKUP_USER_ID": "88888888",
    "COMPANY_PUBLIC_ORIGIN": "https://clickup-serviteur-company.example.workers.dev",
    "STAGING_OAUTH_KV_ID": "a" * 32,
    "STAGING_PUBLIC_ORIGIN": "https://clickup-serviteur-staging.example.workers.dev",
}


class CompanyManifestTests(unittest.TestCase):
    def generate(self, override: dict[str, str] | None = None):
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ.copy()
            for key in VALID:
                env.pop(key, None)
            env.update(VALID)
            env.update(override or {})
            result = subprocess.run(
                ["node", str(GENERATOR)],
                cwd=directory, env=env, capture_output=True, text=True,
                timeout=15, check=False,
            )
            path = Path(directory) / ".wrangler-company.generated.jsonc"
            config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
            return result, config

    def test_separate_company_worker_non_destructive_defaults(self):
        result, config = self.generate()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIsNotNone(config)
        assert config is not None
        self.assertEqual("clickup-serviteur-company", config["name"])
        self.assertEqual("5555555555", config["vars"]["CLICKUP_WORKSPACE_ID"])
        self.assertEqual("6666666666", config["vars"]["CLICKUP_LIST_ID"])
        self.assertEqual("list", config["vars"]["CLICKUP_RESOURCE_SCOPE"])
        self.assertEqual("true", config["vars"]["CLICKUP_COMPANY_PROFILE"])
        self.assertEqual("non_destructive", config["vars"]["CLICKUP_COMPANY_WRITE_MODE"])
        self.assertNotIn("CLICKUP_COMPANY_READ_ONLY", config["vars"])
        self.assertEqual("77777777", config["vars"]["ALLOWED_GITHUB_IDS"])
        self.assertEqual({"77777777": "88888888"},
                         json.loads(config["vars"]["CLICKUP_STAFF_USER_MAP"]))
        self.assertEqual(VALID["COMPANY_OAUTH_KV_ID"], config["kv_namespaces"][0]["id"])
        for secret in ("CLICKUP_TOKEN_KEY", "CLICKUP_CLIENT_SECRET", "GITHUB_CLIENT_SECRET"):
            self.assertNotIn(secret, config["vars"])

    def test_missing_required_config_rejected(self):
        for key in VALID:
            if key in ("STAGING_OAUTH_KV_ID", "STAGING_PUBLIC_ORIGIN"):
                continue
            with self.subTest(key=key):
                result, config = self.generate({key: ""})
                self.assertNotEqual(0, result.returncode)
                self.assertIsNone(config)

    def test_dummy_resources_and_shared_kv_rejected(self):
        bad = (
            {"COMPANY_WORKSPACE_ID": "9012707978"},
            {"COMPANY_LIST_ID": "901219425894"},
            {"COMPANY_OAUTH_KV_ID": VALID["STAGING_OAUTH_KV_ID"]},
            {"COMPANY_PUBLIC_ORIGIN": "http://example.com"},
            {"COMPANY_PUBLIC_ORIGIN": VALID["STAGING_PUBLIC_ORIGIN"]},
            {"COMPANY_PUBLIC_ORIGIN": "https://unrelated-worker.example.workers.dev"},
        )
        for value in bad:
            with self.subTest(value=value):
                result, config = self.generate(value)
                self.assertNotEqual(0, result.returncode)
                self.assertIsNone(config)


if __name__ == "__main__":
    unittest.main()
