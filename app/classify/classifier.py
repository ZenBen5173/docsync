"""Stage 1: email -> one of 5 categories, with confidence and evidence.

Deterministic weighted-cue scorer. The sender's own message carries most of
the weight; the subject is a weak signal (subjects in this inbox are recycled
across threads and often misleading); quoted threads are nearly ignored.
Attachments are a signal, never proof. An optional LLM pass is only consulted
when the rule score is below the review threshold.
"""
import re
from dataclasses import dataclass, field

from app.ingest.clean import clean_body
from app.safe_regex import user_search

W_MESSAGE, W_SUBJECT, W_QUOTED = 1.0, 0.3, 0.1

# (pattern, weight). Patterns are intent-level phrases, not dataset templates.
CUES: dict[str, list[tuple[str, float]]] = {
    "BL_COMPARISON": [
        (r"\bdraft\s+(b/?l|bill of lading)\b", 3.0),
        (r"\b(b/?l|bill of lading)\s+draft\b", 3.0),
        (r"\b(check|verify|compare|confirm|review)\b.{0,60}\b(b/?l|bill of lading)\b", 2.5),
        (r"\b(b/?l|bill of lading)\b.{0,40}\b(against|matches|match|vs\.?|versus)\b.{0,20}\b(si|shipping instruction)\b", 3.0),
        (r"\b(si|shipping instruction)\b.{0,30}\band\b.{0,30}\b(b/?l|bill of lading)\b", 2.0),
        (r"\bdiscrepanc(y|ies)\b", 1.5),
        (r"\b(b/?l|bill of lading)\b.{0,30}\b(in order|for (your )?(checking|confirmation|approval))\b", 2.5),
        (r"\bok to finali[sz]e\b|\bplease amend\b", 1.5),
        # the same request in plain words, for senders who never write "BL" or "SI"
        (r"\b(check|verify|compare|review|cross-?check|validate|reconcile)\b.{0,80}\b(draft|transport document|carrier'?s? (document|paperwork))\b"
         r".{0,80}\b(against|with|to|matches?|in line with)\b", 2.5),
        (r"\b(against|matches?|in line with|consistent with)\b.{0,40}\b(the |our |my |their )?(customer'?s? )?instructions?\b", 2.0),
        (r"\b(send|share|forward|provide|email)\b.{0,40}\b(the |a |your )?(carrier'?s? )?draft\b", 2.0),
    ],
    "SI_REQUEST": [
        (r"\b(new|fresh|upcoming)\s+(shipment|booking|consignment)\b", 1.5),
        (r"\b(shipment|booking|consignment)\s+(instructions?|details|particulars)\b(?!.{0,60}\b(draft|against|verify|compare))", 2.0),
        (r"\b(please |kindly )?(arrange|book|proceed with|set up)\b.{0,30}\b(the |a |this )?(booking|shipment|space)\b", 2.0),
        (r"\b(please |pls |kindly )?find\b.{0,25}\b(shipping instructions?|s\.?i\.?)\b(?!.{0,40}\b(draft|b/?l\b|bill of lading))", 3.0),
        (r"\b(shipping instructions?|s\.?i\.?)\s+(for|as below|below|details)\b(?!.{0,40}\b(draft|bill of lading))", 1.5),
        (r"^\s*(shipper|consignee|notify party)\s*:\s*$", 1.2),          # SI typed into the body
        (r"^\s*(pol|pod|port of (loading|discharge))\s*:", 1.0),
        (r"^\s*documents? required\s*:", 1.5),
        (r"^\s*(shipping line|description of goods)\s*:", 0.8),
        (r"\b(submit|create|issue|prepare)\b.{0,20}\b(the )?(booking|si\b|shipping instruction)", 1.0),
    ],
    "INVOICE_QUERY": [
        (r"\binvoices?\b", 2.0),
        (r"\b(billing|billed|debit note|credit note|statement of account|soa)\b", 1.5),
        (r"\b(gr|goods receipt|pgi)\b.{0,40}\b(missing|post|reverse)", 2.0),
        (r"\b(charges?|thc|demurrage|detention|d\s?&\s?d|freight (amount|cost|charges?))\b", 1.5),
        (r"\b(payment|amount|breakdown|refund|overcharg\w+|outstanding balance)\b", 1.0),
        (r"\bcancel\b.{0,20}\binvoice\b", 1.5),
    ],
    "GENERAL": [
        # machine-generated notices: each signal counts on its own; together they are near-conclusive
        (r"\bautomated (notification|message|e-?mail)\b|\bauto-?generated\b", 3.0),
        (r"\bno action (is )?(required|needed)\b|\bfor (your )?information only\b", 2.5),
        (r"\b(rpa|system) bot\b|\bdo not reply\b|\bno-?reply\b", 2.0),
        (r"\b(completed|finished|ran) successfully\b", 1.5),
        (r"\b(daily|weekly|monthly)\b.{0,30}\b(report|summary|update)\b", 2.0),
        (r"\b(berthing|berthed|vessel schedule|eta|etd|delay notice)\b", 1.5),
        (r"^\s*reminder\b|\bgentle reminder\b", 2.0),
        (r"\b(outstanding|pending) (list|items|shipments|b/?l release)\b", 1.5),
        (r"\b(update summary|loading completed|documents to follow)\b", 2.0),
        (r"\b(happy|wishing|holiday|office (will be )?(closed|resumes)|time off|leave request|"
         r"townhall|meeting invite|minutes of meeting|training)\b", 2.0),
        (r"\b(management|hr|human resources)\b\s*$", 0.8),
    ],
    "SPAM": [
        (r"\b(won|winner|selected|prize|lottery|jackpot|gift card|claim (now|your))\b", 2.5),
        (r"\b(bank details|business proposal|million|inheritance|next of kin|beneficiary)\b", 2.5),
        (r"\b(verify|update|confirm) your (account|mailbox|password|identity)\b|\bmailbox (has )?exceeded\b|"
         r"\bstorage (limit|is full)\b|\bavoid (deactivation|suspension)\b", 2.5),
        (r"\b\d{1,3}\s?% off\b|\bbuy now\b|\blimited time\b|\bdeal expires\b|\bexclusive offer\b|"
         r"\bweird trick\b|\bguaranteed\b.{0,20}\breturns\b", 2.5),
        (r"\b(bitcoin|crypto|forex|investment opportunity|hot singles|viagra|casino)\b", 2.5),
        (r"\bunpaid (customs )?fee\b|\bcould not be delivered\b|\bcomplete this (short )?survey\b", 2.5),
        (r"https?://\S*(bit\.ly|tinyurl|claim|prize|verify|winner|free-|track-parcel)\S*", 2.0),
        (r"\bhello dear\b|\bdear (user|customer|valued customer|friend|winner)\b", 1.5),
        (r"!!!|\bURGENT\b|\bCLAIM NOW\b|\bCONGRATULATIONS\b", 1.0),
    ],
}
_COMPILED = {c: [(re.compile(p, re.I | re.M), w) for p, w in cues] for c, cues in CUES.items()}

SPAMMY_DOMAIN_RE = re.compile(
    r"@[\w.-]*(deals|offers|promo|prize|winner|crypto|invest|verify|secure-mail|webmail|"
    r"lottery|free-|click)[\w.-]*\.|\.(biz|info|xyz|top|click|win|loan)$", re.I)


@dataclass
class Classification:
    category: str
    confidence: float
    scores: dict[str, float]
    evidence: list[str] = field(default_factory=list)
    decided_by: str = "rule"


def _score(text: str, weight: float, scores: dict, evidence: list, where: str):
    if not text:
        return
    for cat, cues in _COMPILED.items():
        for rx, w in cues:
            m = rx.search(text)
            if m:
                scores[cat] += w * weight
                if weight >= W_SUBJECT:
                    evidence.append(f"{cat} +{w * weight:.1f} [{where}] “{m.group(0).strip()[:60]}”")


def classify_email(email: dict, doc_types: list[str] | None = None, kb=None) -> Classification:
    """`doc_types`: detected types of the attachments (SI/BL/OTHER/...), if any."""
    body = clean_body(email.get("body", ""))
    scores = {c: 0.0 for c in CUES}
    evidence: list[str] = []
    _score(body.message, W_MESSAGE, scores, evidence, "body")
    _score(email.get("subject", ""), W_SUBJECT, scores, evidence, "subject")
    _score(body.quoted, W_QUOTED, scores, evidence, "quoted")

    sender = email.get("from", "")
    if SPAMMY_DOMAIN_RE.search(sender):
        scores["SPAM"] += 1.5
        evidence.append(f"SPAM +1.5 [sender] suspicious domain {sender.split('@')[-1]}")

    doc_types = doc_types or []
    if "BL" in doc_types:
        scores["BL_COMPARISON"] += 2.5
        evidence.append("BL_COMPARISON +2.5 [attachment] a bill of lading is attached")
    elif "SI" in doc_types:
        # SI alone: either a BL check whose draft is missing, or an SI hand-off.
        scores["BL_COMPARISON"] += 0.8
        scores["SI_REQUEST"] += 0.8

    # Learned sender/phrase hints from the knowledge base (approved by an admin).
    if kb is not None:
        for hint in kb.classifier_hints():
            if user_search(hint["pattern"], body.message + "\n" + email.get("subject", "")):
                scores[hint["category"]] = scores.get(hint["category"], 0) + float(hint.get("weight", 2.0))
                evidence.append(f"{hint['category']} +{hint.get('weight', 2.0)} [kb] {hint['pattern']}")

    total = sum(scores.values())
    if total <= 0:
        return Classification("GENERAL", 0.35, scores, ["no cue matched; defaulting to GENERAL"])
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    (top, s1), (_, s2) = ranked[0], ranked[1]
    share = s1 / total
    margin = (s1 - s2) / s1
    strength = min(1.0, s1 / 3.0)            # one strong cue (~3.0) = full strength
    confidence = round(max(0.05, min(0.99, (0.5 * share + 0.5 * margin) * (0.6 + 0.4 * strength))), 3)
    return Classification(top, confidence, {k: round(v, 2) for k, v in scores.items()}, evidence[:12])
