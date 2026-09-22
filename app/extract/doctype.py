"""What kind of document is this attachment? SI, BL, or something else
(invoice, packing list, certificate ...). Content decides; the file name is
only a tie-breaker because senders mislabel files."""
import re
from dataclasses import dataclass

from app.extract.model import Document

OTHER_TYPES = [
    ("CERTIFICATE_OF_ORIGIN", r"certificate\s+of\s+origin|\bform\s+[ae]\b.*origin"),
    ("COMMERCIAL_INVOICE", r"(commercial|proforma|pro-forma|tax)\s+invoice|^\s*invoice\b"),
    ("PACKING_LIST", r"packing\s+(list|declaration)|weight\s+list"),
    ("CERTIFICATE", r"(fumigation|phytosanitary|insurance|inspection|quality|analysis|health)\s+certificate|"
                    r"certificate\s+of\s+(insurance|analysis|quality|fumigation)"),
    ("BOOKING_CONFIRMATION", r"booking\s+(confirmation|acknowledg\w+)"),
    ("ARRIVAL_NOTICE", r"arrival\s+notice|delivery\s+order|debit\s+note|credit\s+note|purchase\s+order"),
]
SI_RE = r"shipping\s+instructions?|b/?l\s+instructions?|bill\s+of\s+lading\s+instructions?|^\s*s\.?\s?i\.?\s*$"
BL_RE = r"bill\s+of\s+lading|\bb/l\b|\bdraft\s+bl\b|\bbl\s+draft\b|sea\s*way\s*bill|^\s*bl\s*$"
# other companies' names for the same two papers (only tried when the classic titles above did not match)
SI_LOOSE_RE = r"(customer'?s?|shipment|shipper'?s?|booking|forwarding)\s+instructions?|instructions?\s+(for|to)\s+(the\s+)?(carrier|shipment|booking)|letter\s+of\s+instructions?"
BL_LOOSE_RE = r"(carrier'?s?|transport|shipping\s+line'?s?)\s+(draft|document)|draft\s+(transport|shipping)\s+document|\b(m|h)bl\b"

OTHER_LABELS = {k: k.replace("_", " ").title() for k, _ in OTHER_TYPES}


@dataclass
class DocType:
    type: str            # SI | BL | OTHER | UNKNOWN
    subtype: str | None  # e.g. PACKING_LIST when OTHER
    confidence: float
    evidence: str


def _classify_title(text: str) -> tuple[str, str | None] | None:
    for name, rx in OTHER_TYPES:
        if re.search(rx, text, re.I | re.M):
            return "OTHER", name
    if re.search(SI_RE, text, re.I | re.M):
        return "SI", None
    if re.search(BL_RE, text, re.I | re.M):
        return "BL", None
    if re.search(SI_LOOSE_RE, text, re.I | re.M):
        return "SI", None
    if re.search(BL_LOOSE_RE, text, re.I | re.M):
        return "BL", None
    return None


def detect_doc_type(doc: Document) -> DocType:
    fname = doc.path.replace("\\", "/").rsplit("/", 1)[-1]
    # 1) the title: the first few non-empty rows (plus sheet names for workbooks)
    heads = [r.text for r in doc.rows if r.text.strip()][:6]
    for sheet in doc.meta.get("sheets", []):
        heads.append(sheet)
    for h in heads:
        if len(h) > 90:
            continue
        # a title row may carry a reference next to it ("BL INSTRUCTION   31543")
        hit = _classify_title(re.split(r"\s{3,}", h)[0])
        if hit:
            return DocType(hit[0], hit[1], 0.97, f"title “{h.strip()[:60]}”")
    # 2) anywhere in the body
    body = doc.text[:6000]
    hit = _classify_title(body)
    if hit:
        return DocType(hit[0], hit[1], 0.75, "phrase found in document body")
    # 3) file name hint
    stem = re.sub(r"\.[a-z0-9]+$", "", fname, flags=re.I)
    if re.search(r"(^|[_\-\s])(si|shipping[_\-\s]?instructions?|instructions?)($|[_\-\s])", stem, re.I):
        return DocType("SI", None, 0.5, f"file name {fname}")
    if re.search(r"(^|[_\-\s])(bl|b_l|mbl|hbl|draft|waybill|bill[_\-\s]?of[_\-\s]?lading)($|[_\-\s])", stem, re.I):
        return DocType("BL", None, 0.5, f"file name {fname}")
    return DocType("UNKNOWN", None, 0.2, "no document title recognised")


def filename_role(path: str) -> str | None:
    stem = re.sub(r"\.[a-z0-9]+$", "", path.replace("\\", "/").rsplit("/", 1)[-1], flags=re.I)
    if re.search(r"(^|[_\-\s])si($|[_\-\s])", stem, re.I):
        return "SI"
    if re.search(r"(^|[_\-\s])bl($|[_\-\s])", stem, re.I):
        return "BL"
    return None
