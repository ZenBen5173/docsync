"""Document -> the 7 compared fields, aligned by label *meaning*.

Three deterministic paths, tried in order for every row:
  1. structural  - the format already separates label and value (xlsx cells,
                   docx table cells, PDF columns)
  2. colon       - "Label: value" text lines
  3. prefix      - a known label glued to its value with no separator
                   ("Consignee (Non-Negotiable) ACME LTD")
Knowledge-base label aliases extend path 1/2. An optional LLM pass fills fields
the rules could not find (see app/extract/llm_extract.py).
"""
import re

from app.config import FIELDS
from app.extract.model import Document, FieldValue, Row

# Meaning-level label rules, checked top to bottom on a normalised label.
_LABEL_RULES: list[tuple[str, re.Pattern]] = [
    ("notify_party", re.compile(r"\bnotify\b|\bnotif(y|ied) party\b")),
    ("consignee", re.compile(r"\bconsignee\b|\bcnee\b|\bto (the )?order( of)?\b|\breceiver\b")),
    ("shipper", re.compile(r"\bshipper\b|\bexporter\b|\bconsignor\b")),
    ("port_of_loading", re.compile(r"\bport of load(ing)?\b|\bpol\b|\bload(ing)? port\b|\bplace of loading\b")),
    ("port_of_discharge", re.compile(r"\bport of discharg\w*\b|\bpod\b|\bdischarg\w* port\b|"
                                     r"\bport of destination\b|\bdestination port\b")),
    ("container_count", re.compile(r"\b(no|nos|number|num|total|qty|quantity|count)\b.*\bcontainers?\b|"
                                   r"\bcontainers?\b.*\b(count|qty|quantity|total)\b|^containers?$|^cntrs?$")),
    # no trailing \b: PDF fonts can mangle a CJK suffix into the word ("WeightII(KGS)")
    ("gross_weight_kg", re.compile(r"\bgross\s*(weight|wt|wgt)|^g w\b|^gw\b")),
]
_LABEL_NEGATIVE = re.compile(
    r"^containers? (no|nos|number|numbers|id|ids|seal)\b|\bnet\b|\bseal\b|\btare\b|\bper container\b|"
    r"\bplace of (receipt|delivery)\b|\bfinal destination\b")

_SQUASHED = {
    "portofloading": "port_of_loading", "loadport": "port_of_loading", "loadingport": "port_of_loading",
    "portofdischarge": "port_of_discharge", "dischargeport": "port_of_discharge",
    "notifyparty": "notify_party", "grossweight": "gross_weight_kg", "grosswt": "gross_weight_kg",
    "noofcontainers": "container_count", "numberofcontainers": "container_count",
    "totalcontainers": "container_count", "containercount": "container_count",
}

# Path 3: explicit label phrases that may run straight into the value.
_PREFIX = {
    "notify_party": r"notify(?:\s+party)?(?:\s*/\s*intermediate\s+consignee)?",
    "consignee": r"consignee|to\s+the\s+order\s+of|to\s+order\s+of",
    "shipper": r"shipper(?:\s*/\s*exporter)?|exporter|consignor",
    "port_of_loading": r"port\s+of\s+loading|load(?:ing)?\s+port|pol",
    "port_of_discharge": r"port\s+of\s+discharge|discharge\s+port|pod",
    "container_count": r"(?:total\s+)?(?:no\.?|number)\s+of\s+containers(?:\s+or\s+packages)?|"
                       r"total\s+containers|container\s+count|containers",
    "gross_weight_kg": r"(?:total\s+)?gross\s*(?:weight|wt)\.?",
}
_PREFIX_RE = {f: re.compile(rf"^\s*({p})(?![a-z])((?:\s*\([^)]*\))*)\s*[:：]?\s*(.*)$", re.I)
              for f, p in _PREFIX.items()}

_CJK = re.compile(r"[⺀-鿿＀-￯]+")
BLANK_RE = re.compile(
    r"^[\s_\-–—?.*/]*$|_{3,}|\?{2,}|^\W*(tba|tbc|tbd|tbn|n\s*[/.]?\s*a|nil|none|null|pending|unknown|"
    r"to be (advised|confirmed|determined|nominated)|x{3,})\W*$", re.I)

PARTY_FIELDS = {"shipper", "consignee", "notify_party"}


def normalise_label(label: str) -> str:
    s = _CJK.sub(" ", label or "").lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def match_label(label: str, kb=None) -> tuple[str | None, float]:
    """Return (field, confidence) for a label as written in a document."""
    if not label or len(label) > 70:
        return None, 0.0
    if "毛重" in label:
        return "gross_weight_kg", 0.97
    norm = normalise_label(label)
    if not norm:
        return None, 0.0
    if kb is not None:
        hit = kb.label_alias(norm)
        if hit:
            return hit, 0.95
    if _LABEL_NEGATIVE.search(norm):
        return None, 0.0
    for fld, rx in _LABEL_RULES:
        if rx.search(norm):
            # short, label-like strings are trustworthy; long sentences less so
            return fld, 0.98 if len(norm.split()) <= 7 else 0.8
    # OCR and cramped layouts lose the spaces inside a label ("Portof Loading")
    squashed = norm.replace(" ", "")
    for key, fld in _SQUASHED.items():
        if squashed == key or (squashed.startswith(key) and len(squashed) <= len(key) + 6):
            return fld, 0.85
    return None, 0.0


def is_blank(value: str | None) -> bool:
    return value is None or bool(BLANK_RE.search(value.strip()))


def _split_row(row: Row, kb) -> tuple[str | None, str, str, float, str, dict | None]:
    """-> (field, label, value, confidence, method, value_loc)"""
    if row.label is not None:
        label = row.label.rstrip(":： ")
        fld, conf = match_label(label, kb)
        if fld:
            return fld, label, (row.value or "").strip(), conf, "rule", row.value_loc
    m = re.match(r"^\s*([^:：]{1,70})[:：](.*)$", row.text)
    if m:
        fld, conf = match_label(m.group(1), kb)
        if fld:
            return fld, m.group(1).strip(), m.group(2).strip(), conf, "rule", row.value_loc
    if not _LABEL_NEGATIVE.search(normalise_label(row.text[:40])):
        for fld, rx in _PREFIX_RE.items():
            pm = rx.match(row.text)
            if pm:
                label = (pm.group(1) + pm.group(2)).strip()
                return fld, label, pm.group(3).strip(), 0.92, "prefix", row.value_loc
    return None, "", "", 0.0, "", None


def _value_bbox(row: Row, value: str) -> dict | None:
    """PDF rows: the box of just the value words (the tail of the line), so the
    evidence highlight sits on the value rather than on the whole line."""
    if not row.words or not value or row.loc.get("kind") != "bbox":
        return None
    want = re.sub(r"\s+", "", value)
    for k in range(len(row.words)):
        if re.sub(r"\s+", "", "".join(w[0] for w in row.words[k:])) == want:
            boxes = [w[1] for w in row.words[k:]]
            return {"kind": "bbox", "page": row.loc["page"],
                    "bbox": [min(b[0] for b in boxes), min(b[1] for b in boxes),
                             max(b[2] for b in boxes), max(b[3] for b in boxes)]}
    return None


def _looks_like_label(row: Row, kb) -> bool:
    if _split_row(row, kb)[0]:
        return True
    if row.label is not None and not row.indent:
        return len(row.label) <= 45
    return bool(re.match(r"^\s*[A-Za-z][^:：]{0,45}[:：]", row.text)) and not row.indent


def extract_fields(doc: Document, kb=None) -> dict[str, FieldValue]:
    """Best candidate per field. A field that is labelled but empty comes back
    with blank=True (-> missing_value); a field with no label at all is absent."""
    cands: dict[str, list[FieldValue]] = {f: [] for f in FIELDS}
    rows = doc.rows
    for i, row in enumerate(rows):
        if not row.text.strip() or row.indent:
            continue
        fld, label, value, conf, method, vloc = _split_row(row, kb)
        if not fld:
            continue
        vloc = vloc or _value_bbox(row, value)
        lines = [value] if value else []
        value_row = i
        # continuation: address lines under a party, or a value printed below its label
        j = i + 1
        while j < len(rows) and len(lines) < 8:
            nxt = rows[j]
            if not nxt.text.strip():
                if lines:
                    break
                j += 1
                continue
            if nxt.indent or (not lines and not _looks_like_label(nxt, kb)):
                lines.append(nxt.text.strip())
                if not value and value_row == i:
                    value_row = j           # the value is printed on the line below its label
                    vloc = vloc or nxt.loc
                j += 1
                continue
            break
        full = "\n".join(lines)
        first = re.split(r"\n|\s+\|\s+", full, maxsplit=1)[0].strip() if full else ""
        raw = first if fld in PARTY_FIELDS else (value or first)
        if doc.method == "ocr":
            conf = round(conf * min(0.9, doc.ocr_confidence or 0.5), 3)
            method = "ocr"
        fv = FieldValue(field=fld, raw=raw or None, full=full or None, label=label,
                        loc=vloc or row.loc, row_index=value_row, confidence=conf, method=method,
                        blank=is_blank(raw))
        if fv.blank:
            fv.confidence = min(conf, 0.9)
            fv.note = "value is blank or a placeholder"
        cands[fld].append(fv)

    out: dict[str, FieldValue] = {}
    for fld, lst in cands.items():
        if not lst:
            continue
        filled = [c for c in lst if not c.blank]
        pool = filled or lst
        if fld == "gross_weight_kg" and len(pool) > 1:
            totals = [c for c in pool if re.search(r"\btotal\b", c.label or "", re.I)]
            pool = totals or pool
        out[fld] = pool[0]
    return out
