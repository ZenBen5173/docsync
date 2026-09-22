"""Serverless (Vercel) mode: an empty /tmp on every cold start, a read-only pre-seeded database shipped
with the deployment, no background work, no event stream."""
import json
import sqlite3
import sys

import pytest

from tests.test_api import EMAILS
from tests.test_pipeline import BL, SI


def _fresh_app_modules():
    for name in [m for m in sys.modules if m == "app" or m.startswith("app.")]:
        del sys.modules[name]


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    root = tmp_path_factory.mktemp("serverless")
    bundle = root / "bundle"
    (bundle / "inbox").mkdir(parents=True)
    (bundle / "attachments").mkdir()
    for e in EMAILS:
        (bundle / "inbox" / f"{e['email_id']}.json").write_text(json.dumps(e), encoding="utf-8")
    for eid, bl in (("email_001", BL), ("email_002", BL.replace("THREE (3)", "4 x 40'HC"))):
        (bundle / "attachments" / f"{eid}_SI.txt").write_text(SI, encoding="utf-8")
        (bundle / "attachments" / f"{eid}_BL.txt").write_text(bl, encoding="utf-8")

    mp = pytest.MonkeyPatch()
    # 1) "build time": seed a database on a normal machine and freeze it as ONE self-contained file
    mp.setenv("DOCCHECK_SERVERLESS", "0")
    mp.setenv("DOCCHECK_VAR", str(root / "build-var"))
    mp.setenv("DOCCHECK_DB", f"sqlite:///{(root / 'build-var' / 'build.db').as_posix()}")
    mp.setenv("DOCCHECK_SOURCE", str(bundle))
    mp.setenv("DOCCHECK_BUNDLED_SEED", str(root / "missing.db"))
    _fresh_app_modules()
    from app import pipeline
    pipeline.run_batch(str(bundle), persist=True, note="build seed")
    seed = root / "seed.db"
    src, dst = sqlite3.connect(root / "build-var" / "build.db"), sqlite3.connect(seed)
    with dst:
        src.backup(dst)
    src.close()
    dst.execute("PRAGMA journal_mode=DELETE")
    dst.close()
    seed.chmod(0o444)                                           # the deployment's filesystem is read-only

    # 2) "cold start" on the host: nothing in the writable directory, only the bundled seed
    mp.setenv("DOCCHECK_SERVERLESS", "1")
    mp.setenv("DOCCHECK_VAR", str(root / "tmp"))
    mp.setenv("DOCCHECK_DB", f"sqlite:///{(root / 'tmp' / 'doccheck.db').as_posix()}")
    mp.setenv("DOCCHECK_BUNDLED_SEED", str(seed))
    _fresh_app_modules()
    from fastapi.testclient import TestClient
    import importlib
    main = importlib.import_module("app.api.main")
    c = TestClient(main.app)            # deliberately NOT a context manager: no lifespan/startup event, like the host
    yield c
    mp.undo()
    _fresh_app_modules()


def test_cold_start_comes_up_fully_seeded(client):
    meta = client.get("/api/meta").json()["demo"]
    assert meta == {"public": True, "reset_available": True, "serverless": True}
    counts = client.get("/api/counts?user_id=1").json()["folders"]
    assert (counts["all"], counts["mismatch"], counts["ok"]) == (3, 1, 1)
    d = client.get("/api/cases/email_002").json()
    assert d["defect_fields"] == ["container_count"] and "Container count" in d["draft"]["body"]


def test_no_background_work_and_no_event_stream(client):
    full = client.post("/api/pipeline/run", json={})
    assert full.status_code == 409 and "pre-computed" in full.json()["detail"]
    assert client.get("/api/events").status_code == 404
    assert client.post("/api/pipeline/score", json={}).status_code == 404


def test_small_retries_run_inside_the_request(client):
    assert client.post("/api/pipeline/run", json={"ids": ["email_002"]}).json() == {"ok": True, "started": True}
    assert client.get("/api/pipeline/status").json()["state"]["running"] is False
    assert client.post("/api/cases/email_002/retry", json={}).json()["status"] == "MISMATCH"
    assert client.post("/api/cases/bulk", json={"ids": ["email_001", "email_002"], "action": "retry"}).status_code == 200


def test_edits_work_and_reset_restores_the_bundled_seed(client):
    d = client.post("/api/cases/email_002/correct", json={"field_results": {"container_count": "match"}}).json()
    assert d["status"] == "OK"
    assert client.post("/api/cases/email_001/send", json={"to": "a@b.c", "subject": "RE", "body": "ok"}).json()["ok"]
    assert client.get("/api/counts?user_id=1").json()["folders"]["sent"] == 1
    assert client.post("/api/demo/reset").json()["ok"]            # restores from the READ-ONLY bundled file
    after = client.get("/api/counts?user_id=1").json()["folders"]
    assert (after["sent"], after["mismatch"]) == (0, 1)
