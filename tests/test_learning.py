from app.drafts import build_draft
from app.kb.store import KnowledgeBase
from app.learning import _templatise, draft_added_lines
from app.tagging import rule_matches

AI = "Dear Team,\n\nWe found discrepancies. Please amend.\n\nAll other fields match. Kindly send us the amended draft.\n\nBest regards,\nDocs"


def test_draft_diff_is_sentence_level():
    final = AI.replace("Kindly send", "Please quote BL no. MEDU123 in your reply. Kindly send")
    added, removed = draft_added_lines(AI, final)
    assert added == ["Please quote BL no. MEDU123 in your reply."] and removed == []
    assert _templatise(added[0], {"bl_no": "MEDU123"}) == "Please quote BL no. {bl_no} in your reply."


def test_reply_rule_is_applied_with_placeholders():
    case = {"category": "BL_COMPARISON", "status": "MISMATCH", "defect_fields": [], "fields": [], "refs": {"bl_no": "OOLU999"}}
    kb = KnowledgeBase([{"kind": "reply_rule", "key": "MISMATCH", "value": "Please quote BL no. {bl_no} in your reply."},
                        {"kind": "reply_rule", "key": "MISMATCH", "value": "Invoice {invoice} refers."},      # unknown ref -> skipped
                        {"kind": "reply_rule", "key": "OK", "value": "never shown here"}])
    body = build_draft({"from": "a@b.c", "subject": "x", "body": ""}, case, kb)["body"]
    assert "Please quote BL no. OOLU999 in your reply." in body
    assert "Invoice" not in body and "never shown" not in body


def test_draft_wording_per_status():
    mk = lambda **k: build_draft({"from": "hari_m@x.com", "subject": "Draft BL", "body": ""},  # noqa: E731
                                 dict({"category": "BL_COMPARISON", "refs": {}, "docs": [], "fields": [], "defect_fields": []}, **k))
    assert "OK to finalize" in mk(status="OK", fields=[{"field": "shipper", "result": "match"}])["body"]
    assert "could not find the SI and the draft BL" in mk(status="NEEDS_REVIEW", review_reason="missing_attachment")["body"]
    assert mk(status="OK")["subject"] == "RE: Draft BL" and mk(status="OK")["body"].startswith("Dear Hari,")
    assert build_draft({"from": "a@b.c", "subject": "x", "body": ""}, {"category": "SPAM", "status": "OK"}) is None


def test_auto_tag_rule_conditions():
    facts = {"carrier": "Maersk", "sender_domain": "vitalsolutions.sg", "status": "MISMATCH", "subject": "Draft BL"}
    assert rule_matches([{"field": "carrier", "op": "contains", "value": "maersk"}], facts)
    assert rule_matches([{"field": "sender_domain", "op": "is", "value": "vitalsolutions.sg"},
                         {"field": "status", "op": "is", "value": "mismatch"}], facts)
    assert not rule_matches([{"field": "carrier", "op": "is", "value": "msc"}], facts)
    assert rule_matches([{"field": "subject", "op": "regex", "value": r"^draft\s+bl"}], facts)
    assert not rule_matches([], facts)
