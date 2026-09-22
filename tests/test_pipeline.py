"""Comparison, extraction, classification and routing behaviour on small
synthetic emails (no dataset, no ground truth, no database)."""
import pytest

from app.classify.classifier import classify_email
from app.compare.compare import compare_documents
from app.engine import process_email, to_submission
from app.extract.doctype import detect_doc_type
from app.extract.fields import extract_fields, is_blank, match_label
from app.extract.model import FieldValue
from app.extract.readers import read_document
from app.ingest.clean import clean_body
from app.kb.store import KnowledgeBase

SI = """SHIPPING INSTRUCTION
====================

Shipper/Exporter: ACME PAPER SDN BHD
  12 JALAN SATU; 50000 KUALA LUMPUR, MALAYSIA
Consignee (Non-Negotiable): GLOBEX TRADING LLC
  PO BOX 1; DUBAI, UAE
Notify: GLOBEX TRADING LLC
Port of Loading (POL): PORT KLANG (WESTPORT), MALAYSIA (MYPKG)
POD: JEBEL ALI, UAE (AEJEA)
No. of Containers: 3 x 40'HC
Gross Wt (kgs): 61,250 KG
Vessel: TEST VESSEL V.001
"""
BL = """BILL OF LADING (DRAFT)
======================

SHIPPER: ACME PAPER SDN. BHD.
  12 JALAN SATU; 50000 KUALA LUMPUR, MALAYSIA
To the Order of: GLOBEX TRADING L.L.C.
Notify Party/Intermediate Consignee: GLOBEX TRADING LLC
Load Port: Port Kelang, Malaysia
Discharge Port: JEBEL ALI, UNITED ARAB EMIRATES
Container Count: THREE (3)
Gross Weight毛重(KGS): 61250
B/L No.: MEDU1234567
"""


class FakeInbox:
    def __init__(self, files):
        self.files = files

    def read_bytes(self, path):
        return self.files[path]


def email(body, files=None, subject="RE_ something unrelated", sender="docs@example.com"):
    files = files or {}
    return {"email_id": "email_t", "from": sender, "subject": subject, "body": body,
            "attachments": list(files)}, FakeInbox(files)


def fields(text, name="x_SI.txt"):
    return extract_fields(read_document(name, text.encode()))


def fv(field, raw, label=""):
    return FieldValue(field=field, raw=raw, label=label, confidence=0.98)


# ---------------------------------------------------------------- labels / extraction
@pytest.mark.parametrize("label,field", [
    ("Load Port", "port_of_loading"), ("Port of Loading (POL)", "port_of_loading"), ("POL", "port_of_loading"),
    ("Discharge Port", "port_of_discharge"), ("POD (卸货港)", "port_of_discharge"), ("To the Order of", "consignee"),
    ("Consignee (Non-Negotiable)", "consignee"), ("Notify Party/Intermediate Consignee", "notify_party"),
    ("Shipper (Principal or Seller)", "shipper"), ("Shipper/Exporter", "shipper"), ("No. of Containers or Packages", "container_count"),
    ("Total Containers (箱数)", "container_count"), ("Gross Weight毛重(KGS)", "gross_weight_kg"), ("TOTAL Gross WeightII(KGS)", "gross_weight_kg"),
    ("Gross Wt (kgs)", "gross_weight_kg"), ("CONTAINER NO.", None), ("NET WEIGHT", None), ("Vessel", None), ("Booking Ref", None),
])
def test_match_label(label, field):
    assert match_label(label)[0] == field


def test_extract_aligns_by_meaning():
    si, bl = fields(SI), fields(BL, "x_BL.txt")
    assert si["consignee"].raw == "GLOBEX TRADING LLC" and bl["consignee"].raw == "GLOBEX TRADING L.L.C."
    assert si["shipper"].full.count("\n") == 1                      # address kept as continuation
    assert bl["port_of_loading"].raw == "Port Kelang, Malaysia"
    assert si["gross_weight_kg"].loc == {"kind": "line", "line": 12}


@pytest.mark.parametrize("v", ["", "   ", "???", "____", "_______ MTS", "TBA", "N/A", "n.a.", "To be advised", "-"])
def test_blank_values(v):
    assert is_blank(v)


def test_not_blank():
    assert not is_blank("SINGAPORE") and not is_blank("3 x 40'HC")


def test_doc_types():
    assert detect_doc_type(read_document("a.txt", SI.encode())).type == "SI"
    assert detect_doc_type(read_document("a.txt", BL.encode())).type == "BL"
    assert detect_doc_type(read_document("a.txt", b"BILL OF LADING INSTRUCTION\nShipper: X")).type == "SI"
    inv = detect_doc_type(read_document("email_1_BL.txt", b"COMMERCIAL INVOICE\nSeller: X\nBuyer: Y"))
    assert (inv.type, inv.subtype) == ("OTHER", "COMMERCIAL_INVOICE")      # content beats the file name
    assert detect_doc_type(read_document("a.txt", b"PACKING LIST\nCarton No.  Net Wt")).subtype == "PACKING_LIST"


def test_unreadable_files():
    assert not read_document("a.pdf", b"%PDF-1.5\n\x94garbage").readable
    assert not read_document("a.txt", b"").readable
    assert not read_document("a.docx", b"PK\x03\x04broken").readable


# ---------------------------------------------------------------- comparison
def test_formatting_differences_match():
    res = {r.field: r for r in compare_documents(fields(SI), fields(BL, "b.txt"))}
    assert all(r.result == "match" for r in res.values()), {k: (v.result, v.reason) for k, v in res.items()}


@pytest.mark.parametrize("field,si,bl,result", [
    ("shipper", "APRIL FINE PAPER TRADING", "APRIL FINE PAPER TRADING (MIDDLE EAST) FZE", "mismatch"),
    ("consignee", "EAST BRIGHT FZ-LLC", "UAB NOVAKOPA", "mismatch"),
    ("consignee", "ROXCEL TRADING GMBH", "ROXCEL TRADING", "unsure"),             # legal form dropped -> human
    ("consignee", "GLOBEX TRADING LLC", "TO ORDER", "unsure"),
    ("notify_party", "MOORIM SP CO., LTD", "MOORIM SP CO LTD", "match"),
    ("port_of_discharge", "MOMBASA, KENYA (KEMBA)", "TUTICORIN, INDIA (KEMBA)", "mismatch"),
    ("port_of_loading", "SINGAPORE", "SINGAPORE (SGSIN)", "match"),
    ("container_count", "6 x 40'HC", "5 x 40'HC", "mismatch"),
    ("container_count", "3 x 40HC", "THREE (3)", "match"),
    ("gross_weight_kg", "131,058 KG", "131058", "match"),
    ("gross_weight_kg", "131,058 KG", "131,058.4 KG", "match"),                   # rounding tolerance
    ("gross_weight_kg", "20,842 KG", "21,342 KG", "mismatch"),
    ("gross_weight_kg", "21.5 MT", "21,500 KG", "match"),
])
def test_field_comparison(field, si, bl, result):
    base = fields(SI)
    a, b = dict(base), dict(base)
    a[field], b[field] = fv(field, si), fv(field, bl)
    got = next(r for r in compare_documents(a, b) if r.field == field)
    assert got.result == result, got.reason


def test_blank_is_missing_not_mismatch():
    a, b = fields(SI), fields(BL, "b.txt")
    a["consignee"] = FieldValue(field="consignee", raw="", blank=True, confidence=0.9)
    r = next(x for x in compare_documents(a, b) if x.field == "consignee")
    assert r.result == "missing" and r.missing_side == "SI"


def test_kb_alias_turns_mismatch_into_match():
    a, b = fields(SI), fields(BL, "b.txt")
    a["port_of_discharge"], b["port_of_discharge"] = fv("port_of_discharge", "JAKARTA, INDONESIA"), fv("port_of_discharge", "TG PRIOK, INDONESIA")
    get = lambda kb: next(r for r in compare_documents(a, b, kb) if r.field == "port_of_discharge").result  # noqa: E731
    assert get(None) == "mismatch"
    assert get(KnowledgeBase([{"kind": "port_alias", "key": "TG PRIOK", "value": "JAKARTA"}])) == "match"


# ---------------------------------------------------------------- classification
@pytest.mark.parametrize("body,category", [
    ("Hi Team,\n\nPls check the draft BL against the SI and revert with any discrepancy.\n\nBest Regards,\nA", "BL_COMPARISON"),
    ("Dear Hari,\n\nPlease assist to send the draft BL for ABC123 for checking asap.", "BL_COMPARISON"),
    ("Hi\n\nPlease find Shipping instruction for 5RCY-1.\n\nPOL: SINGAPORE\nPOD: MOMBASA\n\nShipper:\nACME\n\nConsignee:\nGLOBEX\n\nDocuments Required:\n3 BL", "SI_REQUEST"),
    ("Dear Team,\n\nQuery on invoice 5250076524: is the THC included or billed separately?", "INVOICE_QUERY"),
    ("This is an automated notification. The billing process has completed successfully. No action required.\n\n-- RPA Bot", "GENERAL"),
    ("Reminder: Please submit SI & AED for all pending shipments by end of day.", "GENERAL"),
    ("CONGRATULATIONS!!! You have won a $1,000 gift card. Click here to claim: http://bit.ly/claim-prize-now", "SPAM"),
    ("Hello Dear, I am a bank officer with an urgent business proposal involving USD 4.5 million. Reply with your bank details.", "SPAM"),
])
def test_classifier_uses_the_body_not_the_subject(body, category):
    e, _ = email(body, subject="TO CONFIRM DOCS _ 5RMY-34778 _ FREMANTLE _ SI - draft BL - invoice")
    assert classify_email(e).category == category


def test_clean_body_strips_banner_signature_and_thread():
    b = clean_body("WARNING: This email originated outside of our organisation. Exercise caution with links or attachments.\n\n"
                   "Hi Lee,\n\nPlease check the draft BL.\n\nBest Regards,\nSam\nShipping\n\n"
                   "______________________________\nFrom: X <x@y.com>\nSent: Monday\nSubject: RE: invoice 123\n\nold text about invoice")
    assert b.message == "Please check the draft BL."
    assert "invoice" in b.quoted and "Sam" in b.signature and b.banner


# ---------------------------------------------------------------- end to end routing
BODY = "Hi Team,\n\nAttached are the SI and draft BL. Please check the details and confirm.\n\nBest Regards,\nA"


def run(body=BODY, files=None):
    e, inbox = email(body, files)
    return to_submission(process_email(e, inbox))


def test_ok_and_mismatch():
    assert run(files={"a/e_SI.txt": SI.encode(), "a/e_BL.txt": BL.encode()})["status"] == "OK"
    out = run(files={"a/e_SI.txt": SI.encode(), "a/e_BL.txt": BL.replace("THREE (3)", "4 x 40'HC").encode()})
    assert (out["status"], out["has_defect"], out["defect_fields"]) == ("MISMATCH", True, ["container_count"])


@pytest.mark.parametrize("files,body,reason", [
    ({"a/e_SI.txt": SI.encode(), "a/e_BL.txt": b"PACKING LIST\nConsignee: GLOBEX\nCarton No.  Gross Wt"}, BODY, "wrong_doc_type"),
    ({"a/e_SI.txt": SI.encode()}, BODY, "missing_attachment"),
    ({}, "Dear Team,\n\nPlease compare the SI and draft BL for X and confirm.", "missing_attachment"),
    ({"a/e_SI.txt": SI.encode(), "a/e_BL.pdf": b"%PDF-1.5\n\x00broken"}, BODY, "unreadable"),
    ({"a/e_SI.txt": SI.replace("GLOBEX TRADING LLC\n  PO", "\n  PO").replace("Notify: GLOBEX TRADING LLC", "Notify: TBA").encode(),
      "a/e_BL.txt": BL.encode()}, BODY, "missing_value"),
])
def test_needs_review_reasons(files, body, reason):
    out = run(body, files)
    assert (out["status"], out["review_reason"], out["has_defect"], out["defect_fields"]) == ("NEEDS_REVIEW", reason, False, [])


def test_request_for_draft_without_attachments_is_ok():
    out = run("Dear Hari,\n\nPlease assist to send the draft BL for ABC123 for checking asap.\n\nThank you.")
    assert (out["category"], out["status"]) == ("BL_COMPARISON", "OK")


def test_non_comparison_shape():
    out = run("Dear Team,\n\nQuery on invoice 5250076524: is the THC included? Please advise the breakdown.")
    assert out == {"category": "INVOICE_QUERY", "status": "OK", "review_reason": None, "has_defect": False, "defect_fields": []}


def test_a_crashing_attachment_never_crashes_the_batch():
    class Boom:
        def read_bytes(self, path):
            raise OSError("disk on fire")
    e, _ = email(BODY, {"a/e_SI.txt": b"", "a/e_BL.txt": b""})
    res = process_email(e, Boom())
    assert res["status"] == "NEEDS_REVIEW" and res["review_reason"] == "unreadable"


# ---------------------------------------------------------------- carrier tagging
def test_carrier_from_reference_not_from_common_words():
    from app.engine import detect_carrier
    assert detect_carrier(["MEDUUD646871"], []) == "MSC"
    assert detect_carrier(["OOLU8243017646"], ["whatever"]) == "OOCL"
    assert detect_carrier([None], ["Please advise which one is correct, pil or not"]) is None      # "one"/"pil" are words
    assert detect_carrier([None], ["Vessel operated by Maersk Line"]) == "Maersk"
    assert detect_carrier(["SINF123456"], [], {"SINF": "ONE", "SIN": "PIL"}) == "ONE"              # longest prefix wins
    assert detect_carrier(["SIN204711671"], [], {"SINF": "ONE", "SIN": "PIL"}) == "PIL"
    assert detect_carrier(["XYZ1234567"], ["AFRT - CALLAO_PERU - ACME(XYZ1234567) - 5RVN-1"]) == "ACME"
    assert detect_carrier(["XYZ1234567"], ["AFRT - CALLAO_PERU - ACME(OTHER999999) - 5RVN-1"]) is None   # recycled subject


# ---------------------------------------------------------------- scans: the two Admin switches both count
@pytest.mark.parametrize("settings,ocr_conf,status", [
    ({}, 0.999, "NEEDS_REVIEW"),                                                          # default: a scan always goes to a person
    ({"ocr_auto_accept": True}, 0.95, "NEEDS_REVIEW"),                                    # accepted in principle, but read too poorly (default minimum 0.99)
    ({"ocr_auto_accept": True, "doctype_thresholds": {"ocr": 0.9}}, 0.95, "OK"),          # the admin lowered the minimum
    ({"ocr_auto_accept": True, "doctype_thresholds": {"ocr": 0.9}}, 0.80, "NEEDS_REVIEW"),
])
def test_scan_is_trusted_only_above_the_ocr_minimum(monkeypatch, settings, ocr_conf, status):
    # patch the globals process_email really runs with: another test file reloads app.engine, and a
    # reloaded module is a different object from the one imported at the top of this file
    scope = process_email.__globals__
    real = scope["read_document"]

    def as_scan(path, data):
        d = real(path, data)
        if path.endswith("_BL.txt"):
            d.method, d.ocr_confidence = "ocr", ocr_conf
        return d
    monkeypatch.setitem(scope, "read_document", as_scan)
    e, inbox = email(BODY, {"a/e_SI.txt": SI.encode(), "a/e_BL.txt": BL.encode()})
    # field_review_below=0 isolates the completeness gate from the per-field confidence cap that scans also get
    out = to_submission(process_email(e, inbox, settings=dict(settings, field_review_below=0.0, field_thresholds={})))
    assert out["status"] == status
    assert out["review_reason"] == ("unreadable" if status == "NEEDS_REVIEW" else None)
