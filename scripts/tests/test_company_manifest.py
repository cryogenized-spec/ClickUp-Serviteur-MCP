"""No-secret tests for isolated company deployment config."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "scripts/generate-company-config.mjs"


class CompanyManifestTests(unittest.TestCase):
    def generate(self, overrides=None):
        env = os.environ.copy()
        env.update({
            "COMPANY_OAUTH_KV_ID": "b" * 32,
            "STAGING_OAUTH_KV_ID": "a" * 32,
            "STAGING_WORKSPACE_ID": "9012707978",
            "COMPANY_WORKSPACE_ID": "9005168750",
            "COMPANY_LIST_ID": "901202442802",
            "COMPANY_OWNER_GITHUB_ID": "256972168",
            "COMPANY_CLICKUP_USER_ID": "74510260",
        })
        env.update(overrides or {})
        with tempfile.TemporaryDirectory() as directory:
            run = subprocess.run(
                ["node", str(GENERATOR)], cwd=directory, env=env,
                capture_output=True, text=True, timeout=15, check=False,
            )
            path = Path(directory) / ".wrangler-company.generated.jsonc"
            return run, json.loads(path.read_text()) if path.is_file() else None

    def test_company_profile_is_isolated_and_read_only(self):
        run, cfg = self.generate()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(cfg["name"], "neonsales-clickup-mcp-company")
        self.assertEqual(cfg["vars"]["CLICKUP_COMPANY_READ_ONLY"], "true")
        self.assertEqual(cfg["vars"]["CLICKUP_RESOURCE_SCOPE"], "list")
        self.assertEqual(cfg["vars"]["CLICKUP_WORKSPACE_ID"], "9005168750")
        self.assertEqual(cfg["vars"]["CLICKUP_LIST_ID"], "901202442802")
        self.assertEqual(cfg["vars"]["CLICKUP_STAFF_USER_MAP"], '{"256972168":"74510260"}')
        self.assertEqual(cfg["kv_namespaces"][0]["id"], "b" * 32)
        self.assertNotIn("CLICKUP_WORKSPACE_GITHUB_IDS", cfg["vars"])
        self.assertNotIn("CLICKUP_OAUTH_ENABLED", cfg["vars"])
        self.assertNotIn("CLICKUP_LIVE_ENABLED", cfg["vars"])
        self.assertNotIn("CLICKUP_TOKEN_KEY", cfg["vars"])

    def test_never_share_staging_kv_or_workspace(self):
        for env in [
            {"COMPANY_OAUTH_KV_ID": "a" * 32},
            {"COMPANY_WORKSPACE_ID": "9012707978"},
            {"COMPANY_WORKSPACE_ID": ""},
            {"COMPANY_OWNER_GITHUB_ID": "x"},
            {"COMPANY_LIST_ID": "0"},
        ]:
            with self.subTest(env=env):
                run, cfg = self.generate(env)
                self.assertNotEqual(run.returncode, 0)
                self.assertIsNone(cfg)
