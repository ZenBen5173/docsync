"""Behaviour the hover guide's fact-check found to be wrong in the APP (not in the wording): the reply drafted
when nothing was compared, the Inbox's Spam tab, a confirmation that a re-check forgot, a mismatch reply with
an empty list, and scans on a machine without the OCR engine. Own tiny inbox, own database."""
import importlib
import json
import sys

import pytest

from tests.test_pipeline import BL, SI

EMAILS = [
    {"email_id": "email_101", "from": "jane@acme-forwarding.sg", "subject": "REQUEST BL DRAFT",
     "body": "Dear Hari,\n\nPlease assist to send the draft BL for ABC123 for checking asap.\n\nThank you.", "attachments": []},
    {"email_id": "email_102", "from": "winner@lucky-prize-intl.biz", "subject": "YOU HAVE WON",
     "body": "Congratulations!!! You have won a cash prize of USD 1,000,000 in our lottery. Click here to claim your prize now "
             "and verify your bank account and password. Act now, limited time offer, 100% free.", "attachments": []},
    {"email_id": "email_103", "from": "ops@acme-forwarding.sg", "subject": "TO CONFIRM DOCS",
     "body": "Hi Team,\n\nAttached are the SI and draft BL. Please check the details and confirm.\n\nBest Regards,\nSam",
     "attachments": ["attachments/email_103_SI.txt"]},
    {"email_id": "email_104", "from": "docs@acme-forwarding.sg", "subject": "RE_ anything",
     "body": "Hi Team,\n\nAttached are the SI and draft BL. Please check the details and confirm.\n\nBest Regards,\nSam",
     "attachments": ["attachments/email_104_SI.txt", "attachments/email_104_BL.txt"]},
]


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    root = tmp_path_factory.mktemp("doccheck_flow")
    bundle = root / "bundle"
    (bundle / "inbox").mkdir(parents=True)
    (bundle / "attachments").mkdir()
    for e in EMAILS:
        (bundle / "inbox" / f"{e['email_id']}.json").write_text(json.dumps(e), encoding="utf-8")
    for name, text in (("email_103_SI.txt", SI), ("email_104_SI.txt", SI), ("email_104_BL.txt", BL)):
        (bundle / "attachments" / name).write_text(text, encoding="utf-8")
    mp = pytest.MonkeyPatch()
    mp.setenv("DOCCHECK_VAR", str(root / "var"))
    mp.setenv("DOCCHECK_DB", f"sqlite:///{(root / 'var' / 'test.db').as_posix()}")
    mp.setenv("DOCCHECK_SOURCE", str(bundle))
    mp.setenv("PIPELINE_MIN_INTERVAL_S", "0")
    for name in [m for m in sys.modules if m == "app" or m.startswith("app.")]:
        del sys.modules[name]
    from fastapi.testclient import TestClient
    from app import pipeline
    pipeline.run_batch(str(bundle), persist=True, note="test seed")
    main = importlib.import_module("app.api.main")
    with TestClient(main.app) as c:
        c.bundle = str(bundle)
        yield c
    mp.undo()
    for name in [m for m in sys.modules if m == "app" or m.startswith("app.")]:
        del sys.modules[name]


def ids(client, **params):
    return {r["id"] for r in client.get("/api/cases", params=params).json()["rows"]}


def test_the_fixture_is_what_the_tests_assume(client):
    got = {e["email_id"]: client.get(f"/api/cases/{e['email_id']}").json() for e in EMAILS}
    assert (got["email_101"]["category"], got["email_101"]["status"]) == ("BL_COMPARISON", "OK")
    assert got["email_102"]["category"] == "SPAM"
    assert (got["email_103"]["status"], got["email_103"]["review_reason"]) == ("NEEDS_REVIEW", "missing_attachment")
    assert got["email_104"]["status"] == "OK"


def test_reply_never_claims_a_match_when_nothing_was_compared(client):
    waiting = client.get("/api/cases/email_101").json()
    assert all(f["result"] == "not_compared" for f in waiting["fields"])
    body = waiting["draft"]["body"]
    assert "as soon as it is received" in body
    assert "match" not in body.lower() and "OK to finalize" not in body
    assert "OK to finalize" in client.get("/api/cases/email_104").json()["draft"]["body"]     # a real match still says so


def test_the_inbox_spam_tab_lists_the_junk(client):
    assert ids(client, folder="inbox", tab="spam") == {"email_102"}
    assert "email_102" not in ids(client, folder="inbox", tab="cases") | ids(client, folder="inbox", tab="other")
    assert "email_102" not in ids(client, folder="inbox")                  # the plain Inbox still leaves junk out
    assert client.get("/api/counts?user_id=1").json()["folders"]["inbox"] == 3


def test_a_confirmation_survives_a_recheck_until_the_answer_changes(client):
    assert "email_103" in ids(client, folder="review")
    assert client.post("/api/cases/email_103/confirm", json={"user_id": 1}).json()["ok"]
    assert "email_103" not in ids(client, folder="review")
    assert client.post("/api/cases/email_103/retry", json={}).json()["status"] == "NEEDS_REVIEW"
    again = client.get("/api/cases/email_103").json()
    assert (again["resolved"], again["needs_human"]) == (True, False)      # same answer: still settled
    assert "email_103" not in ids(client, folder="review")
    # the missing draft arrives: a different answer is a new question for a person
    from pathlib import Path
    (Path(client.bundle) / "attachments" / "email_103_BL.txt").write_text(BL.replace("61250", "99999"), encoding="utf-8")
    e = dict(EMAILS[2], attachments=EMAILS[2]["attachments"] + ["attachments/email_103_BL.txt"])
    (Path(client.bundle) / "inbox" / "email_103.json").write_text(json.dumps(e), encoding="utf-8")
    from app import pipeline
    pipeline.run_batch(client.bundle, persist=True, only_ids=["email_103"], note="draft arrived")
    assert client.get("/api/cases/email_103").json()["status"] == "MISMATCH"
    # "send to review" forgets the confirmation, and a re-check leaves it in the waiting line
    assert client.post("/api/cases/email_104/confirm", json={"user_id": 1}).json()["ok"]
    client.post("/api/cases/email_104/send-to-review", json={"note": "second opinion requested"})
    assert "confirmed" not in client.get("/api/cases/email_104").json()["overrides"]
    assert "email_104" in ids(client, folder="review")
    client.post("/api/cases/email_104/retry", json={})                     # a re-check must not answer for the teammate
    assert "email_104" in ids(client, folder="review")
    client.post("/api/cases/email_104/confirm", json={"user_id": 2})       # the teammate looks: settled again
    client.post("/api/cases/email_104/retry", json={})
    assert "email_104" not in ids(client, folder="review")


def test_row_answers_are_kept_and_a_second_look_brings_the_apps_answer_back(client):
    client.post("/api/cases/email_104/reset")
    d = client.post("/api/cases/email_104/correct", json={"field_results": {"consignee": "mismatch"}, "user_id": 1}).json()
    assert (d["status"], d["defect_fields"]) == ("MISMATCH", ["consignee"])
    d = client.post("/api/cases/email_104/correct", json={"field_results": {"shipper": "mismatch"}, "user_id": 1}).json()
    assert sorted(d["defect_fields"]) == ["consignee", "shipper"]                        # the first answer was not forgotten
    assert {f["field"]: f["result"] for f in d["fields"]}["consignee"] == "mismatch"     # and the row shows it
    client.post("/api/cases/email_104/send-to-review", json={"note": "second opinion requested"}, headers={"x-user": "Maya Tan"})
    again = client.get("/api/cases/email_104").json()
    assert (again["status"], again["defect_fields"]) == ("OK", [])                       # the app's own answer is back
    assert again["review_detail"].startswith("Sent to review by Maya Tan")
    client.post("/api/cases/email_104/retry", json={})
    assert client.get("/api/cases/email_104").json()["review_detail"].startswith("Sent to review by Maya Tan")   # a re-check keeps who asked
    client.post("/api/cases/email_104/reset")


def test_a_mismatch_verdict_without_a_marked_row_never_sends_an_empty_list(client):
    d = client.post("/api/cases/email_104/correct", json={"verdict": {"status": "MISMATCH", "defect_fields": []}, "user_id": 1}).json()
    assert d["status"] == "MISMATCH" and "please list the details to amend" in d["draft"]["body"]
    client.post("/api/cases/email_104/reset")


def test_ocr_results_are_read_back_from_disk_without_the_engine(client, monkeypatch):
    from app import config
    from app.extract import readers
    key = "feedfacefeedfacefeedfacefeedfacefeedface-p0"
    folder = config.VAR_DIR / "ocr_cache"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{key}.json").write_text(json.dumps([[[[10, 10], [200, 10], [200, 30], [10, 30]], "Gross Weight: 61250", 0.97]]), encoding="utf-8")

    def no_engine():
        raise ImportError("no OCR engine on this machine")
    monkeypatch.setattr(readers, "_get_ocr", no_engine)
    readers._ocr_cache.clear()
    assert readers._ocr_known(key)
    rows, confs = readers._ocr_rows(None, 0, scale=0.5, key=key)
    assert [r.text for r in rows] == ["Gross Weight: 61250"] and confs == [0.97]
    assert rows[0].loc == {"kind": "bbox", "page": 0, "bbox": [5.0, 5.0, 100.0, 15.0]}
    assert readers._ocr_rows(None, 0, key="unknown-p0") == ([], [])        # nothing known and no engine: no crash
