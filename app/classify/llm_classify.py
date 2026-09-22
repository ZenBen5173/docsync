"""LLM second opinion for emails the rule scorer is unsure about."""
from app import llm
from app.classify.classifier import Classification
from app.config import CATEGORIES

SCHEMA = '{"category": "one of the five", "confidence": 0.0, "reason": "short"}'


def llm_classify(email: dict, body, rule: Classification, kb=None) -> Classification | None:
    data = llm.complete_json(
        "You triage a shipping-documentation inbox. Categories: BL_COMPARISON (asks to check/compare a draft "
        "Bill of Lading against the Shipping Instruction, or asks the carrier for the draft), SI_REQUEST (hands "
        "over or asks for a shipping instruction), INVOICE_QUERY (invoices, charges, billing, GR/PGI), GENERAL "
        "(reports, reminders, notifications, HR), SPAM. Judge by the sender's own message; subjects are often "
        "recycled and misleading. What the writer ASKS FOR decides: if they ask anyone to check, verify, compare or "
        "review a carrier's draft or transport document (in any words), it is BL_COMPARISON even when only one file "
        "arrived or a file is missing. SI_REQUEST is only when they hand over instructions to START a booking and ask "
        "for no checking.",
        f"From: {email.get('from')}\nSubject: {email.get('subject')}\nAttachments: {email.get('attachments')}\n\n"
        f"Message:\n{body.message[:2500]}", SCHEMA)
    if not data or data.get("category") not in CATEGORIES:
        return None
    return Classification(data["category"], float(data.get("confidence") or 0.7), rule.scores,
                          rule.evidence + [f"LLM: {data.get('reason', '')}"], decided_by="llm")
