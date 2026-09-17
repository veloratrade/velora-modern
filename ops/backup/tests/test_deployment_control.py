#!/usr/bin/env python3
"""Deployment-control invariants (Phase 6 + Phase 10, structural).

These tests assert properties of the DEPLOYMENT PATH itself, not of the backup
logic. They are deliberately structural so they prove the gate cannot be
bypassed without running a real deploy or breaking staging.

Comment-stripping note: the workflows legitimately *describe* the bypasses they
forbid ("no continue-on-error path", "unlike EMPTY-TARGET-BOOTSTRAP..."). A raw
text scan would fail on accurate documentation and tempt someone to delete it,
so these tests parse the YAML and inspect executable structure only.
"""
from __future__ import annotations

import unittest
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

REPO = Path(__file__).resolve().parents[3]
DEPLOY_WF = REPO / ".github" / "workflows" / "deploy-staging-gated.yml"
GATE_WF = REPO / ".github" / "workflows" / "backup-gate.yml"

BYPASS_TOKENS = (
    "skip_backup", "skip_gate", "skip_ci", "force_deploy", "force",
    "bootstrap_ack", "empty-target-bootstrap", "continue-on-error",
)


def executable_yaml(path: Path) -> str:
    """YAML round-trip: comments are dropped, structure is preserved."""
    return yaml.dump(yaml.safe_load(path.read_text()), default_flow_style=False).lower()


@unittest.skipIf(yaml is None, "pyyaml not installed")
class TestGatedDeploymentGraph(unittest.TestCase):
    def setUp(self):
        for p in (DEPLOY_WF, GATE_WF):
            if not p.exists():
                self.skipTest(f"missing {p}")
        self.deploy = yaml.safe_load(DEPLOY_WF.read_text())
        self.gate = yaml.safe_load(GATE_WF.read_text())
        self.jobs = self.deploy["jobs"]

    # --- the pipeline order itself ------------------------------------- #
    def test_pipeline_is_a_chain_not_a_fan_out(self):
        self.assertEqual(self.jobs["backup"]["needs"], ["ci"])
        self.assertIn("backup", self.jobs["backup_gate"]["needs"])
        self.assertIn("ci", self.jobs["backup_gate"]["needs"])

    def test_deploy_requires_ci_backup_and_gate(self):
        needs = self.jobs["deploy"]["needs"]
        for required in ("ci", "backup", "backup_gate"):
            self.assertIn(required, needs,
                          f"deploy must not be schedulable without {required}")

    def test_deploy_has_no_unconditional_if(self):
        """A job-level `if: always()` would defeat every `needs:`."""
        cond = str(self.jobs["deploy"].get("if", ""))
        self.assertNotIn("always()", cond)
        self.assertNotIn("cancelled()", cond)

    def test_deploy_revalidates_predecessor_results(self):
        """Defence in depth: deploy re-checks results even though needs: exists."""
        body = yaml.dump(self.jobs["deploy"])
        self.assertIn("needs.backup_gate.result", body)
        self.assertIn("needs.ci.result", body)
        self.assertIn("needs.backup.result", body)

    # --- no bypass anywhere -------------------------------------------- #
    def test_no_bypass_tokens_in_executable_yaml(self):
        for path in (DEPLOY_WF, GATE_WF):
            body = executable_yaml(path)
            for token in BYPASS_TOKENS:
                if token == "force":       # avoid matching 'force' inside words
                    continue
                self.assertNotIn(token, body, f"{path.name} must not contain {token!r}")

    def test_gate_workflow_has_no_bootstrap_input(self):
        inputs = (self.gate.get(True) or self.gate.get("on"))["workflow_call"]["inputs"]
        for name in inputs:
            self.assertNotIn("bootstrap", name.lower())

    # --- evidence binding ----------------------------------------------- #
    def test_gate_binds_evidence_to_environment_and_commit(self):
        inputs = (self.gate.get(True) or self.gate.get("on"))["workflow_call"]["inputs"]
        self.assertIn("expected_env", inputs)
        self.assertIn("expected_commit_sha", inputs)
        self.assertTrue(inputs["expected_commit_sha"].get("required"))

    def test_deploy_passes_github_sha_not_user_input(self):
        """The commit under deployment must not be caller-controllable."""
        raw = DEPLOY_WF.read_text()
        self.assertIn("expected_commit_sha: ${{ github.sha }}", raw)

    def test_gate_fails_closed_when_evidence_file_absent(self):
        raw = GATE_WF.read_text()
        self.assertIn("evidence/evidence.json", raw)
        self.assertIn("exit 1", raw)

    # --- credential policy ---------------------------------------------- #
    def test_backup_job_requires_dedicated_credential(self):
        body = yaml.dump(self.jobs["backup"])
        self.assertIn("backup_repo_token", body.lower())
        self.assertNotIn("secrets.github_token", body.lower())

    # --- the dump must never become an artifact -------------------------- #
    def test_dump_is_removed_before_artifact_upload(self):
        raw = DEPLOY_WF.read_text()
        self.assertIn('rm -f "evidence/$BID.dump.gz"', raw)

    def test_only_evidence_json_is_published(self):
        for step in self.jobs["backup"]["steps"]:
            if step.get("uses", "").startswith("actions/upload-artifact"):
                self.assertIn("evidence.json", step["with"]["path"])


@unittest.skipIf(yaml is None, "pyyaml not installed")
class TestSupersededGateNotReintroduced(unittest.TestCase):
    """The bootstrap-bearing gate must not come back into this branch."""

    def test_old_bootstrap_gate_is_absent(self):
        old = REPO / ".github" / "workflows" / "backup-evidence-gate.yml"
        self.assertFalse(
            old.exists(),
            "backup-evidence-gate.yml accepts EMPTY-TARGET-BOOTSTRAP instead of "
            "evidence; OD-4 records that exception as NOT APPROVED and staging is "
            "now data-bearing. It must not be reintroduced unmodified.")

    def test_no_workflow_in_branch_accepts_bootstrap(self):
        wfdir = REPO / ".github" / "workflows"
        for wf in wfdir.glob("*.yml"):
            body = executable_yaml(wf)
            self.assertNotIn("empty-target-bootstrap", body, f"{wf.name}")
            self.assertNotIn("bootstrap_ack", body, f"{wf.name}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
