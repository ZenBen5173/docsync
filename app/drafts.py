"""Auto-draft replies. Deterministic templates (always available) that the
knowledge base can extend through approved `reply_rule` items."""
import re

from app.config import FIELD_LABELS

REASON_ASK = {
    "missing_attachment": "We could not find {what} in your email. Could you please resend it so we can complete the check?",
    "unreadable": "We were unable to open or read {what}. Could you please send a readable copy (a text-based PDF, Word or Excel file rather than a scan)?",
    "wrong_doc_type": "{what}. Could you please send the draft Bill of Lading so we can check it against the SI?",
    "missing_value": "Some details are blank in the documents we received: {what}. Could you please confirm these values so we can complete the check?",
}


def _first_name(sender: str, body: str) -> str:
    local = (sender or "").split("@")[0]
    part = local.replace(".", "_").split("_")[0]
    return part.title() if part.isalpha() and len(part) > 2 and part.lower() not in (
        "docs", "logistics", "exports", "sales", "info", "admin", "operations", "hr", "documentation") else "Team"


def build_draft(email: dict, case: dict, kb=None, signer: str = "Shipping Documentation Team") -> dict | None:
    """case: engine result (dict). Returns {"to","subject","body"} or None when no reply is needed."""
    if case.get("category") != "BL_COMPARISON" or case.get("status") in ("PENDING", "FAILED"):
        return None
    subject = email.get("subject", "")
    subject = subject if subject.lower().startswith(("re:", "re_")) else f"RE: {subject}"
    ref = (case.get("refs") or {}).get("bl_no") or (case.get("refs") or {}).get("oc_no")
    ref_txt = f" ({ref})" if ref else ""
    hello = f"Dear {_first_name(email.get('from', ''), email.get('body', ''))},"
    status = case["status"]
    lines = [hello, ""]
    compared = any(fr.get("result") != "not_compared" for fr in case.get("fields") or [])
    if status == "OK" and not compared:                     # nothing was compared: the sender is still waiting for a draft
        lines += [f"Noted with thanks{ref_txt}. We will check the draft BL against the SI as soon as it is received "
                  "and revert with our confirmation."]
    elif status == "OK":
        lines += [f"We have checked the draft BL{ref_txt} against the Shipping Instruction. All 7 key fields match "
                  "(shipper, consignee, notify party, port of loading, port of discharge, container count and gross weight).",
                  "", "BL checked against SI - OK to finalize."]
    elif status == "MISMATCH":
        lines += [f"We have checked the draft BL{ref_txt} against the Shipping Instruction and found the following "
                  "discrepancies. Please amend the BL to follow the SI:", ""]
        for fr in case.get("fields", []):
            if fr["field"] in case.get("defect_fields", []):
                si = (fr.get("si") or {}).get("raw") or "-"
                bl = (fr.get("bl") or {}).get("raw") or "-"
                lines += [f"  - {FIELD_LABELS[fr['field']]}", f"      SI (correct): {si}", f"      Draft BL:     {bl}"]
        if not any(fr["field"] in case.get("defect_fields", []) for fr in case.get("fields", [])):
            # a reviewer called it a mismatch without marking a row: never send an empty list
            lines += ["  - (please list the details to amend before sending)"]
        lines += ["", "All other checked fields match. Kindly send us the amended draft for re-confirmation."]
    else:
        reason = case.get("review_reason") or "unreadable"
        docs = case.get("docs") or []
        if reason == "missing_attachment":
            have = {d.get("role") for d in docs}
            what = "the draft BL" if "SI" in have else ("the SI" if "BL" in have else "the SI and the draft BL")
        elif reason == "unreadable":
            bad = [d["name"] for d in docs if not d.get("readable") or d.get("method") == "ocr"]
            what = " and ".join(bad) if bad else "the attached document(s)"
        elif reason == "wrong_doc_type":
            other = [d for d in docs if d.get("type") == "OTHER"]
            what = (f"The attachment {other[0]['name']} appears to be a {(other[0].get('subtype') or 'different document').replace('_', ' ').title()}, "
                    "not the draft BL") if other else "One of the attachments is not the draft BL"
        else:
            blanks = [FIELD_LABELS[fr["field"]] for fr in case.get("fields", []) if fr["result"] == "missing"]
            what = ", ".join(blanks) if blanks else "one or more of the key fields"
        lines += [f"Thank you for your email{ref_txt}.", "", REASON_ASK[reason].format(what=what)]
    if kb is not None:
        refs = case.get("refs") or {}
        extra = []
        for rule in kb.reply_rules(status):
            # placeholders such as {bl_no} / {oc_no}; a rule whose reference is unknown is skipped
            needed = re.findall(r"\{(\w+)\}", rule)
            if all(refs.get(k) for k in needed):
                for k in needed:
                    rule = rule.replace("{" + k + "}", str(refs[k]))
                extra.append(rule)
        if extra:
            lines += [""] + extra
    lines += ["", "Best regards,", signer]
    return {"to": email.get("from", ""), "subject": subject, "body": "\n".join(lines)}
