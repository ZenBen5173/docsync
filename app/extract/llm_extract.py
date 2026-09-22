"""LLM fallback for fields the deterministic parser could not find.
Strict JSON, temperature 0, cached. The model must quote the value verbatim
and give the row number it came from, so the evidence viewer still works."""
from app import llm
from app.extract.fields import is_blank
from app.extract.model import Document, FieldValue

SCHEMA = '{"fields": {"<field>": {"value": "verbatim text or null", "row": 0, "label": "label as written"}}}'


def llm_fill_fields(doc: Document, wanted: list[str], kb=None) -> dict[str, FieldValue]:
    numbered = "\n".join(f"{i}: {r.text}" for i, r in enumerate(doc.rows) if r.text.strip())[:6000]
    examples = ""
    if kb is not None and kb.examples():
        examples = "\nPast corrections by staff (follow them):\n" + "\n".join(
            f"- {e['key']}: {e['value']}" for e in kb.examples())
    data = llm.complete_json(
        "You extract shipping-document fields. Labels vary (e.g. 'Load Port' = port_of_loading, "
        "'To the Order of' = consignee). For parties return the company name line only. "
        "Copy values verbatim. Use null when the document does not contain the field or it is blank." + examples,
        f"Fields wanted: {', '.join(wanted)}\n\nDocument rows (row number: text):\n{numbered}", SCHEMA)
    out: dict[str, FieldValue] = {}
    for f, v in ((data or {}).get("fields") or {}).items():
        if f not in wanted or not isinstance(v, dict) or not v.get("value"):
            continue
        row = v.get("row")
        ok_row = isinstance(row, int) and 0 <= row < len(doc.rows)
        # only trust values that really appear in the document
        grounded = str(v["value"]).strip().lower() in doc.text.lower()
        out[f] = FieldValue(field=f, raw=str(v["value"]).strip(), full=str(v["value"]).strip(),
                            label=v.get("label"), loc=doc.rows[row].loc if ok_row else None,
                            row_index=row if ok_row else None, confidence=0.8 if grounded else 0.4,
                            method="llm", blank=is_blank(str(v["value"])),
                            note=None if grounded else "LLM value not found verbatim in the document")
    return out
