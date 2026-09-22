"""Process ONE email through all stages. Pure (no database): returns a dict
that the batch runner persists and the UI renders. Every stage is isolated so
a failure is recorded on the case instead of crashing the batch, and a single
stage can be re-run later.

Stages: ingest -> classify -> completeness -> extract -> compare -> route
"""
import re
import time
import traceback

from app import llm
from app.classify.classifier import classify_email
from app.compare.compare import compare_documents
from app.config import DEFAULT_SETTINGS, FIELDS
from app.extract.doctype import OTHER_LABELS, detect_doc_type, filename_role
from app.extract.fields import extract_fields
from app.extract.llm_extract import llm_fill_fields
from app.extract.readers import read_document
from app.ingest.clean import clean_body
from app.kb.store import KnowledgeBase

STAGES = ["ingest", "classify", "completeness", "extract", "compare", "route"]
REASON_PRIORITY = ["unreadable", "wrong_doc_type", "missing_attachment", "missing_value"]

# Carrier from a B/L or booking number prefix (SCAC-style). Longest prefix wins.
# Admins can add more in the knowledge base (kind "carrier_prefix").
CARRIER_PREFIXES = {
    "MAEU": "Maersk", "MSKU": "Maersk", "MRKU": "Maersk", "MEDU": "MSC", "MSDU": "MSC", "MSCU": "MSC",
    "CMDU": "CMA CGM", "CMAU": "CMA CGM", "ONEY": "ONE", "OOLU": "OOCL",
    "EGLV": "Evergreen", "EISU": "Evergreen", "HLCU": "Hapag-Lloyd", "YMJA": "Yang Ming", "YMLU": "Yang Ming",
    "COSU": "COSCO", "PCIU": "PIL", "ZIMU": "ZIM", "HDMU": "HMM", "WHLC": "Wan Hai",
}   # inbox-specific numbering (SINF, SIJ, MCLSIN, SIN…) lives in the knowledge base seed, where admins can edit it
# Carrier names that are safe to match as plain words ("ONE", "PIL", "ZIM" are not).
CARRIER_NAMES = [("Maersk", r"\bMAERSK\b"), ("MSC", r"\bMSC\b"), ("CMA CGM", r"\bCMA(\s?CGM)?\b"), ("OOCL", r"\bOOCL\b"),
                 ("Evergreen", r"\bEVERGREEN\b"), ("Hapag-Lloyd", r"\bHAPAG\b"), ("Yang Ming", r"\bYANG\s?MING\b"),
                 ("COSCO", r"\bCOSCO\b"), ("Wan Hai", r"\bWAN\s?HAI\b"), ("HMM", r"\bHMM\b")]
SUBJECT_CARRIER = {"EVER": "Evergreen", "YM": "Yang Ming", "CMA": "CMA CGM", "HAPAG": "Hapag-Lloyd", "MONTER": "Monter"}
CLAIMS_ATTACHMENT_RE = re.compile(
    r"\b(attached|attachments?|attaching|enclosed|herewith)\b|"
    r"\b(compare|check|verify|review)\b.{0,40}\b(si|shipping instruction)\b.{0,30}\b(b/?l|bill of lading)\b", re.I)
ASKS_FOR_DRAFT_RE = re.compile(
    r"\b(send|share|provide|forward|issue|release)\b.{0,40}\b(draft|b/?l|bill of lading)\b|"
    r"\bawaiting\b.{0,30}\bdraft\b", re.I)


def detect_carrier(refs: list, texts: list, extra_prefixes: dict | None = None) -> str | None:
    """1) prefix of a B/L / booking number, 2) "CARRIER(BLNO)" in the subject when the
    number is one of ours, 3) an unambiguous carrier name in the text."""
    table = dict(CARRIER_PREFIXES, **{k.upper(): v for k, v in (extra_prefixes or {}).items()})
    refs = [r.upper() for r in refs if r]
    for ref in refs:
        for prefix in sorted(table, key=len, reverse=True):
            if ref.startswith(prefix):
                return table[prefix]
    for t in texts:
        for name, ref in re.findall(r"\b([A-Z][A-Z ]{1,12})\(([A-Z0-9]{7,})\)", (t or "").upper()):
            if ref in refs:
                name = name.strip()
                return SUBJECT_CARRIER.get(name, name if len(name) <= 4 else name.title())
    for t in texts:
        for name, rx in CARRIER_NAMES:
            if t and re.search(rx, t.upper()):
                return name
    return None


def _stage(result: dict, name: str, fn):
    t0 = time.perf_counter()
    try:
        fn()
        result["stages"][name] = {"status": "done", "ms": round((time.perf_counter() - t0) * 1000, 1)}
        return True
    except Exception as e:
        result["stages"][name] = {"status": "failed", "error": f"{type(e).__name__}: {e}",
                                  "trace": traceback.format_exc()[-1500:],
                                  "ms": round((time.perf_counter() - t0) * 1000, 1)}
        result["status"] = "FAILED"
        result["error"] = f"[{name}] {type(e).__name__}: {e}"
        return False


def process_email(email: dict, inbox, kb: KnowledgeBase | None = None, settings: dict | None = None,
                  overrides: dict | None = None) -> dict:
    """overrides: human decisions that must survive a re-run, e.g. {"category": "GENERAL"}."""
    kb = kb or KnowledgeBase()
    cfg = dict(DEFAULT_SETTINGS, **(settings or {}))
    overrides = overrides or {}
    body = clean_body(email.get("body", ""))
    res: dict = {
        "email_id": email["email_id"], "category": None, "category_confidence": 0.0,
        "classification": {}, "status": "PENDING", "review_reason": None, "review_detail": None,
        "defect_fields": [], "confidence": 0.0, "needs_human": False, "docs": [], "fields": [],
        "carrier": None, "customer": None, "pod": None, "refs": {}, "stages": {}, "error": None,
        "kb_version": kb.version(),
    }
    docs: list = []
    state: dict = {}

    # ---- ingest: read every attachment, detect what it is ------------------
    def ingest():
        for path in email.get("attachments") or []:
            try:
                data = inbox.read_bytes(path)
            except Exception as e:
                from app.extract.model import Document
                d = Document(path=path, fmt="unknown", readable=False, error=f"could not fetch attachment: {e}")
                docs.append((d, None))
                continue
            d = read_document(path, data)
            docs.append((d, detect_doc_type(d) if d.readable else None))
        for d, dt in docs:
            res["docs"].append({
                "path": d.path, "name": d.path.rsplit("/", 1)[-1], "format": d.fmt, "readable": d.readable,
                "error": d.error, "method": d.method, "ocr_confidence": d.ocr_confidence,
                "type": dt.type if dt else None, "subtype": dt.subtype if dt else None,
                "type_confidence": dt.confidence if dt else None, "type_evidence": dt.evidence if dt else None,
                "role": None,
            })
    if not _stage(res, "ingest", ingest):
        return res

    # ---- classify ---------------------------------------------------------
    def classify():
        types = [dt.type for d, dt in docs if dt]
        # an unreadable attachment named like a BL still signals a BL check
        types += [filename_role(d.path) for d, dt in docs if dt is None and filename_role(d.path)]
        c = classify_email(email, types, kb)
        if c.confidence < cfg["classify_review_below"] and cfg.get("llm_enabled") and llm.available():
            from app.classify.llm_classify import llm_classify
            c = llm_classify(email, body, c, kb) or c
        res["category"], res["category_confidence"] = c.category, c.confidence
        res["classification"] = {"scores": c.scores, "evidence": c.evidence, "decided_by": c.decided_by}
        if overrides.get("category"):
            res["category"], res["category_confidence"] = overrides["category"], 1.0
            res["classification"]["decided_by"] = "human"
    if not _stage(res, "classify", classify):
        return res

    res["refs"] = _refs(email, body)
    res["customer"] = _customer(email)
    if res["category"] != "BL_COMPARISON":
        res["status"], res["confidence"] = "OK", res["category_confidence"]
        res["carrier"] = detect_carrier([res["refs"].get("bl_no")], [body.message], kb.carrier_prefixes())
        res["needs_human"] = res["category_confidence"] < cfg["classify_review_below"]
        if res["needs_human"]:
            res["review_detail"] = "low classification confidence"
        for s in STAGES[2:]:
            res["stages"][s] = {"status": "skipped"}
        return res

    # ---- completeness: do we have a readable SI and a readable BL? ---------
    def completeness():
        reasons: list[tuple[str, str]] = []
        si = bl = None
        if not docs:
            if CLAIMS_ATTACHMENT_RE.search(body.message) and not ASKS_FOR_DRAFT_RE.search(body.message):
                reasons.append(("missing_attachment", "the email refers to SI/BL attachments but none arrived"))
            else:
                state["awaiting_draft"] = True
            state["reasons"] = reasons
            return
        for idx, (d, dt) in enumerate(docs):
            meta = res["docs"][idx]
            if not d.readable:
                reasons.append(("unreadable", f"{meta['name']}: {d.error}"))
                meta["role"] = filename_role(d.path)
                continue
            if d.method == "ocr":
                # a scan is trusted only when auto-accept is on AND it was read cleanly enough (Admin -> Thresholds)
                ocr_min = float((cfg.get("doctype_thresholds") or {}).get("ocr", 0.99))
                if not cfg["ocr_auto_accept"]:
                    reasons.append(("unreadable", f"{meta['name']} is an image-only scan (OCR values are proposals only)"))
                elif (d.ocr_confidence or 0.0) < ocr_min:
                    reasons.append(("unreadable", f"{meta['name']} is a scan read at {(d.ocr_confidence or 0.0):.0%} confidence, "
                                                  f"below the {ocr_min:.0%} needed to accept it without a person"))
            role = dt.type if dt.type in ("SI", "BL") else None
            if dt.type == "OTHER":
                reasons.append(("wrong_doc_type", f"{meta['name']} is a {OTHER_LABELS.get(dt.subtype, 'different document')}, "
                                                  "not an SI or draft BL"))
            elif dt.type == "UNKNOWN":
                role = filename_role(d.path)
            if role == "SI" and si is None:
                si = idx
            elif role == "BL" and bl is None:
                bl = idx
            elif role in ("SI", "BL"):
                role = None     # duplicate of a role we already have
            meta["role"] = role
        # One side is known and ONE other readable, untitled document looks like a shipping form: it is the other side.
        # (New senders do not title their files the way this dataset does; two forms in one email are a pair.)
        if (si is None) != (bl is None):
            spare = [i for i, (d, dt) in enumerate(docs) if d.readable and dt and dt.type == "UNKNOWN" and res["docs"][i]["role"] is None]
            if len(spare) == 1 and len(extract_fields(docs[spare[0]][0], kb)) >= 3:
                other = "SI" if si is None else "BL"
                res["docs"][spare[0]]["role"] = other
                res["docs"][spare[0]]["type_evidence"] = "paired with the other document in this email"
                si, bl = (spare[0], bl) if other == "SI" else (si, spare[0])
        unreadable_roles ={res["docs"][i]["role"] for i, (d, _) in enumerate(docs) if not d.readable}
        for role, idx in (("SI", si), ("BL", bl)):
            if idx is None and role not in unreadable_roles:
                if not any(r == "wrong_doc_type" for r, _ in reasons) or len(docs) < 2:
                    reasons.append(("missing_attachment", f"no {'shipping instruction' if role == 'SI' else 'draft BL'} "
                                                          "among the attachments"))
        state.update(si=si, bl=bl, reasons=reasons)
    if not _stage(res, "completeness", completeness):
        return res

    # ---- extract ----------------------------------------------------------
    extracted: dict[str, dict] = {"SI": {}, "BL": {}}

    def extract():
        for role in ("SI", "BL"):
            idx = state.get(role.lower())
            if idx is None:
                continue
            d = docs[idx][0]
            fields = extract_fields(d, kb)
            missing = [f for f in FIELDS if f not in fields]
            if missing and cfg.get("llm_enabled") and llm.available():
                fields.update(llm_fill_fields(d, missing, kb))
            # values a reviewer corrected by hand win over anything extracted
            for f, sides in (overrides.get("field_values") or {}).items():
                if role.lower() in sides and f in FIELDS:
                    from app.extract.model import FieldValue
                    prev = fields.get(f)
                    fields[f] = FieldValue(field=f, raw=sides[role.lower()], full=sides[role.lower()],
                                           label=prev.label if prev else None, loc=prev.loc if prev else None,
                                           row_index=prev.row_index if prev else None, confidence=1.0,
                                           method="human", blank=False, note="corrected by a reviewer")
            extracted[role] = fields
        bl_doc = docs[state["bl"]][0] if state.get("bl") is not None else None
        bl_no = _find_ref(bl_doc, r"b/?l\s*(no|number)|bill of lading no") if bl_doc else None
        booking = _find_ref(bl_doc, r"booking\s*(no|ref|reference|number)") if bl_doc else None
        res["carrier"] = detect_carrier([bl_no, res["refs"].get("bl_no"), booking],
                                        [email.get("subject"), body.message], kb.carrier_prefixes())
        if bl_no:
            res["refs"]["bl_no"] = bl_no
        pod = (extracted["SI"].get("port_of_discharge") or extracted["BL"].get("port_of_discharge"))
        if pod and pod.raw and not pod.blank:
            from app.compare.normalize import normalise_port
            res["pod"] = normalise_port(pod.raw, kb.port_aliases())["city"].title()
    if not _stage(res, "extract", extract):
        return res

    # ---- compare ----------------------------------------------------------
    def compare():
        si, bl = extracted["SI"], extracted["BL"]
        if state.get("si") is not None and state.get("bl") is not None:
            results = compare_documents(si, bl, kb, cfg)
        else:
            results = []
        by_field = {r.field: r for r in results}
        role_doc = {role: (docs[state[role.lower()]][0] if state.get(role.lower()) is not None else None)
                    for role in ("SI", "BL")}
        for f in FIELDS:
            r = by_field.get(f)
            res["fields"].append({
                "field": f,
                "si": _with_context(si.get(f), role_doc["SI"]),
                "bl": _with_context(bl.get(f), role_doc["BL"]),
                "result": r.result if r else "not_compared",
                "reason": r.reason if r else "comparison not possible",
                "confidence": r.confidence if r else 0.0,
                "si_norm": r.si_norm if r else None, "bl_norm": r.bl_norm if r else None,
            })
    if not _stage(res, "compare", compare):
        return res

    # ---- route ------------------------------------------------------------
    def route():
        reasons = list(state.get("reasons") or [])
        if state.get("awaiting_draft"):
            res["status"], res["confidence"] = "OK", res["category_confidence"]
            res["review_detail"] = "Request for a draft BL - nothing to compare yet"
            return
        thresholds = cfg.get("field_thresholds") or {}
        unsure = []
        for fr in res["fields"]:
            limit = thresholds.get(fr["field"], cfg["field_review_below"])
            if fr["result"] == "missing":
                reasons.append(("missing_value", f"{fr['field']}: {fr['reason']}"))
            elif fr["result"] == "unsure" or (fr["result"] in ("match", "mismatch") and fr["confidence"] < limit):
                if fr["result"] != "unsure":
                    fr["reason"] += f" (confidence {fr['confidence']:.0%} is below the {limit:.0%} threshold)"
                    fr["result_before_threshold"], fr["result"] = fr["result"], "unsure"
                unsure.append(fr)
        mism = [fr["field"] for fr in res["fields"] if fr["result"] == "mismatch"]
        if reasons:
            reasons.sort(key=lambda r: REASON_PRIORITY.index(r[0]))
            res["status"], res["review_reason"] = "NEEDS_REVIEW", reasons[0][0]
            res["review_detail"] = "; ".join(dict.fromkeys(r[1] for r in reasons))
            res["needs_human"] = True
            res["proposed_defect_fields"] = mism
        elif unsure:
            ocr = any((fr["si"] or {}).get("method") == "ocr" or (fr["bl"] or {}).get("method") == "ocr" for fr in unsure)
            res["status"], res["review_reason"] = "NEEDS_REVIEW", ("unreadable" if ocr else "missing_value")
            res["review_detail"] = "AI is not confident: " + "; ".join(f"{fr['field']}: {fr['reason']}" for fr in unsure)
            res["needs_human"] = True
            res["proposed_defect_fields"] = mism
        elif mism:
            res["status"], res["defect_fields"] = "MISMATCH", mism
        else:
            res["status"] = "OK"
        confs = [fr["confidence"] for fr in res["fields"] if fr["result"] in ("match", "mismatch")]
        res["confidence"] = round(min([res["category_confidence"]] + confs), 3) if confs else res["category_confidence"]
        if res["category_confidence"] < cfg["classify_review_below"]:
            res["needs_human"] = True
    _stage(res, "route", route)
    return res


# ---------------------------------------------------------------- helpers
def _with_context(fv, doc, before: int = 2, after: int = 3) -> dict | None:
    """FieldValue -> dict plus the neighbouring rows, so the evidence viewer can
    show the value in place without re-opening the document."""
    if fv is None:
        return None
    d = fv.to_dict()
    d["doc"] = doc.path.rsplit("/", 1)[-1] if doc else None
    d["format"] = doc.fmt if doc else None
    if doc is not None and fv.row_index is not None:
        lo, hi = max(0, fv.row_index - before), min(len(doc.rows), fv.row_index + after + 1)
        d["context"] = [{"i": i, "text": doc.rows[i].text, "label": doc.rows[i].label, "value": doc.rows[i].value,
                         "loc": doc.rows[i].loc, "hit": i == fv.row_index} for i in range(lo, hi)
                        if doc.rows[i].text.strip()]
    return d


def _find_ref(doc, label_rx: str) -> str | None:
    for r in doc.rows:
        m = re.search(rf"({label_rx})[^:：A-Za-z0-9]{{0,12}}[:：]?\s*([A-Z0-9][A-Z0-9\-]{{5,}})", r.text, re.I)
        if m:
            return m.group(m.lastindex)
    return None


def _refs(email: dict, body) -> dict:
    text = f"{email.get('subject', '')}\n{body.message}"
    out = {}
    m = re.search(r"\b(\d[A-Z]{2,3}-\d{5})\b", text)
    if m:
        out["oc_no"] = m.group(1)
    m = re.search(r"\b(?:draft\s+)?b/?l\s*(?:no\.?|number)?\s*[:#]?\s*([A-Z]{3,5}[A-Z0-9]{6,14})\b", body.message, re.I)
    if m:
        out["bl_no"] = m.group(1)
    if "bl_no" not in out:
        # "please send the draft BL for SIJ0342811": a bare shipment reference after "for"
        m = re.search(r"\b(?:draft|b/?l|bill of lading)\b.{0,40}?\bfor\s+([A-Z]{2,8}\d[A-Z0-9]{5,16})\b", body.message)
        if m:
            out["bl_no"] = m.group(1)
    m = re.search(r"\binvoice\s*(?:no\.?)?\s*[:#]?\s*(\d{6,12})\b", text, re.I)
    if m:
        out["invoice"] = m.group(1)
    return out


def _customer(email: dict) -> str | None:
    sender = (email.get("from") or "").lower()
    dom = sender.split("@")[-1] if "@" in sender else ""
    if not dom:
        return None
    name = dom.split(".")[0]
    return {"aprilasia": "APRIL", "april": "APRIL"}.get(name, name.replace("-", " ").title())


def to_submission(res: dict) -> dict:
    """The exact shape the scorer expects."""
    status = res["status"] if res["status"] in ("OK", "MISMATCH", "NEEDS_REVIEW") else "NEEDS_REVIEW"
    if res["category"] != "BL_COMPARISON":
        return {"category": res["category"] or "GENERAL", "status": "OK", "review_reason": None,
                "has_defect": False, "defect_fields": []}
    reason = res["review_reason"] if status == "NEEDS_REVIEW" else None
    if status == "NEEDS_REVIEW" and not reason:
        reason = "unreadable"
    return {"category": "BL_COMPARISON", "status": status, "review_reason": reason,
            "has_defect": status == "MISMATCH",
            "defect_fields": list(res["defect_fields"]) if status == "MISMATCH" else []}
