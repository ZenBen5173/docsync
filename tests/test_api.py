"""End-to-end API tests on a tiny synthetic inbox in a temp directory (own database, no dataset,
no ground truth). Covers the endpoints a public visitor can reach, including the ones that were
exploitable or broken before the deploy review."""
import importlib
import json
import sys

import pytest

from tests.test_pipeline import BL, SI

EMAILS = [
    {"email_id": "email_001", "from": "docs@acme-forwarding.sg", "subject": "RE_ anything",
     "body": "Hi Team,\n\nAttached are the SI and draft BL. Please check the details and confirm. Draft BL No. MEDU1234567.\n\nBest Regards,\nSam",
     "attachments": ["attachments/email_001_SI.txt", "attachments/email_001_BL.txt"]},
    {"email_id": "email_002", "from": "ops@acme-forwarding.sg", "subject": "TO CONFIRM DOCS",
     "body": "Hi Team,\n\nPls check the draft BL against the SI and revert with any discrepancy.\n\nBest Regards,\nSam",
     "attachments": ["attachments/email_002_SI.txt", "attachments/email_002_BL.txt"]},
    {"email_id": "email_003", "from": "billing@acme-forwarding.sg", "subject": "Total Freight",
     "body": "Dear Team,\n\nQuery on invoice 5250076524: is the THC included or billed separately?", "attachments": []},
]


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    root = tmp_path_factory.mktemp("doccheck")
    bundle = root / "bundle"
    (bundle / "inbox").mkdir(parents=True)
    (bundle / "attachments").mkdir()
    for e in EMAILS:
        (bundle / "inbox" / f"{e['email_id']}.json").write_text(json.dumps(e), encoding="utf-8")
    (bundle / "attachments" / "email_001_SI.txt").write_text(SI, encoding="utf-8")
    (bundle / "attachments" / "email_001_BL.txt").write_text(BL, encoding="utf-8")
    (bundle / "attachments" / "email_002_SI.txt").write_text(SI, encoding="utf-8")
    (bundle / "attachments" / "email_002_BL.txt").write_text(BL.replace("THREE (3)", "4 x 40'HC"), encoding="utf-8")

    mp = pytest.MonkeyPatch()
    mp.setenv("DOCCHECK_VAR", str(root / "var"))
    mp.setenv("DOCCHECK_DB", f"sqlite:///{(root / 'var' / 'test.db').as_posix()}")
    mp.setenv("DOCCHECK_SOURCE", str(bundle))
    mp.setenv("DOCCHECK_PUBLIC_DEMO", "1")
    mp.setenv("PIPELINE_MIN_INTERVAL_S", "0")
    for name in [m for m in sys.modules if m == "app" or m.startswith("app.")]:
        del sys.modules[name]                       # re-import the app against the temp configuration
    from fastapi.testclient import TestClient
    from app import pipeline, store
    pipeline.run_batch(str(bundle), persist=True, note="test seed")
    store.snapshot_seed()
    main = importlib.import_module("app.api.main")
    with TestClient(main.app) as c:
        yield c
    mp.undo()
    for name in [m for m in sys.modules if m == "app" or m.startswith("app.")]:
        del sys.modules[name]


def test_inbox_and_detail(client):
    counts = client.get("/api/counts?user_id=1").json()["folders"]
    assert (counts["all"], counts["mismatch"], counts["ok"]) == (3, 1, 1)
    rows = client.get("/api/cases", params={"folder": "all", "q": "status:mismatch"}).json()["rows"]
    assert [r["id"] for r in rows] == ["email_002"] and rows[0]["defect_fields"] == ["container_count"]
    d = client.get("/api/cases/email_002").json()
    assert d["carrier"] is None or isinstance(d["carrier"], str)
    assert "Container count" in d["draft"]["body"] and len(d["fields"]) == 7
    assert client.get("/api/cases/nope").status_code == 404


def test_attachment_routes_only_serve_that_emails_files(client):
    assert client.get("/api/cases/email_001/attachments/email_001_SI.txt").status_code == 200
    assert client.get("/api/cases/email_001/attachments/email_002_BL.txt").status_code == 404
    assert client.get("/api/cases/email_001/attachments/..%2F..%2Fvar%2Ftest.db").status_code == 404
    assert client.get("/api/cases/email_001/attachments/email_001_SI.txt/preview").json()["readable"] is True


def test_thresholds_can_be_saved_twice_and_are_validated(client):
    # regression: dict(a, **b, **c) raised TypeError as soon as a key was saved a second time
    assert client.put("/api/settings", json={"field_review_below": 0.7}).status_code == 200
    r = client.put("/api/settings", json={"field_review_below": 5, "evil": "x", "field_thresholds": {"consignee": 0.9, "hack": 1}})
    assert r.status_code == 200
    v = r.json()["values"]
    assert v["field_review_below"] == 1.0 and "evil" not in v and v["field_thresholds"] == {"consignee": 0.9}
    assert client.put("/api/settings", json={"field_review_below": "high"}).status_code == 422
    assert client.put("/api/settings", json=client.get("/api/settings").json()["defaults"]).status_code == 200


def test_hostile_regex_is_refused(client):
    lab = client.post("/api/labels", json={"name": "Test label"}).json()
    bad = client.post("/api/rules", json={"name": "evil", "label_id": lab["id"],
                                          "conditions": [{"field": "body", "op": "regex", "value": "(.+)+Z"}]})
    assert bad.status_code == 422 and "Regex not accepted" in bad.json()["detail"]
    assert client.post("/api/kb", json={"kind": "classifier_hint", "key": "(a|aa)+$", "value": "SPAM"}).status_code == 422
    ok = client.post("/api/rules", json={"name": "acme", "label_id": lab["id"],
                                         "conditions": [{"field": "sender_domain", "op": "is", "value": "acme-forwarding.sg"}]})
    assert ok.status_code == 200 and ok.json()["retagged"] == 3
    rows = client.get("/api/cases", params={"folder": "all", "label": lab["id"]}).json()
    assert rows["total"] == 3                                    # the rule re-tagged existing cases live


def test_no_caller_controlled_urls(client):
    assert client.post("/api/pipeline/score", json={"scoring_url": "http://attacker.example"}).status_code == 404
    assert client.post("/api/pipeline/run", json={"ids": "email_001"}).status_code == 422
    assert "source" not in client.get("/api/meta").json()        # no server paths in responses


def test_review_learning_loop_and_reset(client):
    # reviewer overrides a field -> verdict flips, reply is regenerated, correction is logged
    d = client.post("/api/cases/email_002/correct", json={"field_results": {"container_count": "match"}, "user_id": 1}).json()
    assert d["status"] == "OK" and "OK to finalize" in d["draft"]["body"]
    # reviewer edits a reply before sending
    case = client.get("/api/cases/email_001").json()
    body = case["draft"]["body"].replace("BL checked against SI", "Please quote BL no. MEDU1234567 in your reply. BL checked against SI")
    assert client.post("/api/cases/email_001/send", json={"to": "a@b.c", "subject": "RE", "body": body}).json()["ok"]
    rep = client.post("/api/learning/generate", json={}).json()
    assert rep["corrections"] >= 2
    sugg = client.get("/api/learning").json()["suggestions"]
    line = next(s for s in sugg if s["kind"] == "reply_rule")
    assert line["payload"]["value"] == "Please quote BL no. {bl_no} in your reply."
    assert client.post(f"/api/learning/suggestions/{line['id']}/approve").json()["ok"]
    assert any(i["source"] == "learned" for i in client.get("/api/kb").json()["items"])
    assert client.post("/api/analytics/analyze", json={"filters": {}}).json()["metrics"]["bl_checks"] == 2
    # ... and one click puts the public demo back
    assert client.post("/api/demo/reset").json()["ok"]
    after = client.get("/api/counts?user_id=1").json()
    assert after["folders"]["sent"] == 0 and after["folders"]["mismatch"] == 1
    assert not any(i["source"] == "learned" for i in client.get("/api/kb").json()["items"])


def test_bad_input_is_a_4xx_not_a_500(client):
    for method, url, body in [("post", "/api/cases/nope/send-to-review", {}), ("post", "/api/cases/nope/reset", None),
                              ("put", "/api/cases/nope/draft", {"body": "x"}), ("post", "/api/cases/nope/send", {"body": "x"}),
                              ("post", "/api/cases/nope/retry", {}), ("post", "/api/cases/nope/confirm", {}),
                              ("patch", "/api/cases/nope", {"is_read": True}), ("delete", "/api/labels/99999", None),
                              ("post", "/api/learning/suggestions/99999/approve", None), ("post", "/api/kb", {"kind": "port_alias"}),
                              ("post", "/api/labels", {})]:
        r = getattr(client, method)(url, **({"json": body} if body is not None else {}))
        assert r.status_code < 500, f"{method.upper()} {url} -> {r.status_code}"


def test_second_correction_on_the_same_case_is_persisted(client):
    # regression: a shallow-copied JSON dict was mutated in place, so SQLAlchemy skipped the UPDATE
    client.post("/api/demo/reset")
    client.post("/api/cases/email_002/correct", json={"field_values": {"container_count": {"bl": "3 x 40'HC"}}})
    client.post("/api/cases/email_002/correct", json={"field_values": {"gross_weight_kg": {"bl": "99,999 KG"}}})
    d = client.get("/api/cases/email_002").json()
    assert set(d["overrides"]["field_values"]) == {"container_count", "gross_weight_kg"}
    assert d["status"] == "MISMATCH" and d["defect_fields"] == ["gross_weight_kg"]
    client.post("/api/demo/reset")


def test_the_last_admin_cannot_be_demoted_or_deactivated(client):
    users = client.get("/api/users").json()
    admin = next(u for u in users if u["role"] == "admin")
    assert client.post("/api/users", json={**admin, "role": "viewer"}).status_code == 409
    assert client.post("/api/users", json={**admin, "active": False}).status_code == 409
    assert client.delete(f"/api/users/{admin['id']}").status_code == 409
    assert client.post("/api/users", json={**admin, "role": "superuser"}).status_code == 422
    other = next(u for u in users if u["role"] == "reviewer")
    assert client.post("/api/users", json={**other, "role": "admin"}).status_code == 200
    assert client.post("/api/users", json={**admin, "role": "viewer"}).status_code == 200      # now allowed
    client.post("/api/demo/reset")


def test_empty_bulk_retry_is_a_noop_not_a_full_run(client):
    assert client.post("/api/cases/bulk", json={"ids": [], "action": "retry"}).json()["count"] == 0
    assert client.get("/api/pipeline/status").json()["state"]["running"] is False


def test_optional_password_gate(client, monkeypatch):
    import base64
    from app import config
    assert client.get("/api/meta").status_code == 200                       # gate off by default
    assert client.get("/api/meta").headers["x-robots-tag"] == "noindex, nofollow"
    assert "Disallow: /" in client.get("/robots.txt").text
    monkeypatch.setattr(config, "DEMO_PASSWORD", "s3cret, with comma")
    assert client.get("/api/meta").status_code == 401
    assert client.get("/").status_code == 401
    assert client.get("/healthz").status_code == 200                        # the host's health check stays open
    bad = {"authorization": "Basic " + base64.b64encode(b"judge:wrong").decode()}
    good = {"authorization": "Basic " + base64.b64encode("anyone:s3cret, with comma".encode()).decode()}
    assert client.get("/api/meta", headers=bad).status_code == 401
    assert client.get("/api/meta", headers=good).status_code == 200
    assert client.get("/api/meta", headers={"authorization": "Basic !!!not-base64"}).status_code == 401
