#!/usr/bin/env python3
"""CI-REVIEW-001 helpers — extract/validate findings from claude -p output and
format the PR comment. Kept in-repo so the GHA workflow stays free of inline
heredoc Python (YAML indentation trap) and the logic is unit-testable.

Usage:
    ci_review_lib.py extract <raw_claude_json> <schema.json> <out_findings.json> [prior_findings.json]
    ci_review_lib.py comment <findings.json> <out_comment.md>

The optional prior file enables MECHANICAL dedup (file+line+category) on top of the
prompt-level "don't repeat PRIOR_FINDINGS" instruction — the model complied in
verification, but a prompt is best-effort and the filter is the guarantee.
"""

import json
import re
import sys
from pathlib import Path


def extract(raw_path: str, schema_path: str, out_path: str, prior_path: str | None = None) -> int:
    raw = json.loads(Path(raw_path).read_text())
    text = raw.get("result", "") if isinstance(raw, dict) else str(raw)
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        print("::error::no JSON object found in review output", file=sys.stderr)
        return 1
    try:
        findings = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        print(f"::error::review output is not valid JSON: {e}", file=sys.stderr)
        return 1
    try:
        import jsonschema
        jsonschema.Draft202012Validator(
            json.loads(Path(schema_path).read_text())).validate(findings)
    except ImportError:
        print("::warning::jsonschema not installed — schema validation skipped", file=sys.stderr)
    except Exception as e:
        print(f"::error::findings failed schema validation: {e}", file=sys.stderr)
        return 1
    if prior_path and Path(prior_path).exists():
        prior = json.loads(Path(prior_path).read_text())
        seen = {(f["file"], f["line"], f["category"]) for f in prior.get("findings", [])}
        before = len(findings.get("findings", []))
        findings["findings"] = [f for f in findings.get("findings", [])
                                if (f["file"], f["line"], f["category"]) not in seen]
        dropped = before - len(findings["findings"])
        if dropped:
            print(f"mechanical dedup: {dropped} repeat(s) of prior findings dropped")
    Path(out_path).write_text(json.dumps(findings, indent=2))
    print(f"{len(findings.get('findings', []))} findings extracted and schema-validated")
    return 0


def comment(findings_path: str, out_path: str) -> int:
    data = json.loads(Path(findings_path).read_text())
    rows = data.get("findings", [])
    lines = ["## 🔎 CI review (CI-REVIEW-001 — report-only stage)", ""]
    if not rows:
        lines.append("No new findings against the build-discipline gates.")
    else:
        lines += ["| sev | file:line | gate | finding |", "|-----|-----------|------|---------|"]
        for f in sorted(rows, key=lambda x: {"high": 0, "medium": 1, "low": 2}.get(x["severity"], 3)):
            lines.append(
                f"| {f['severity']} | `{f['file']}:{f['line']}` | {f.get('gate_section') or '—'} | "
                f"{f['summary']} — *{f['failure_scenario']}* |")
    lines += ["", "_Report-only: findings do not block merge. "
              "Blocking flip is ⏸️ gated (2-week false-positive observation; "
              "blocking will apply only to severity=high findings citing a gate_section)._"]
    Path(out_path).write_text("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "extract":
        sys.exit(extract(*sys.argv[2:6]))
    if cmd == "comment":
        sys.exit(comment(*sys.argv[2:4]))
    sys.exit(f"unknown command {cmd}\n{__doc__}")
