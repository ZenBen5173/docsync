"""Stage 4: compare SI (source of truth) against BL, field by field.
Each field returns match / mismatch / unsure / missing with a reason and a
confidence, so the router can decide between auto-result and human review."""
from dataclasses import dataclass, asdict

from rapidfuzz import fuzz

from app.config import DEFAULT_SETTINGS, FIELDS
from app.compare.normalize import (is_order_only, normalise_party, normalise_port, parse_container_count,
                                   parse_weight_kg, party_core)
from app.extract.model import FieldValue


@dataclass
class FieldResult:
    field: str
    result: str                 # match | mismatch | unsure | missing
    reason: str
    confidence: float
    si_value: str | None = None
    bl_value: str | None = None
    si_norm: str | None = None
    bl_norm: str | None = None
    missing_side: str | None = None   # SI | BL | both  (when result == missing)

    def to_dict(self):
        return asdict(self)


def compare_documents(si: dict[str, FieldValue], bl: dict[str, FieldValue],
                      kb=None, settings: dict | None = None) -> list[FieldResult]:
    cfg = dict(DEFAULT_SETTINGS, **(settings or {}))
    out = []
    for f in FIELDS:
        a, b = si.get(f), bl.get(f)
        a_missing = a is None or a.blank
        b_missing = b is None or b.blank
        if a_missing or b_missing:
            side = "both" if a_missing and b_missing else ("SI" if a_missing else "BL")
            why = []
            for name, fv in (("SI", a), ("BL", b)):
                if fv is None:
                    why.append(f"{name}: field not found")
                elif fv.blank:
                    why.append(f"{name}: value is blank/placeholder (“{fv.raw or ''}”)")
            out.append(FieldResult(f, "missing", "; ".join(why), 0.9, a.raw if a else None,
                                   b.raw if b else None, missing_side=side))
            continue
        extraction_conf = min(a.confidence, b.confidence)
        if f in ("shipper", "consignee", "notify_party"):
            r = _compare_party(f, a, b, kb, cfg)
        elif f in ("port_of_loading", "port_of_discharge"):
            r = _compare_port(f, a, b, kb)
        elif f == "container_count":
            r = _compare_count(f, a, b)
        else:
            r = _compare_weight(f, a, b, cfg)
        r.si_value, r.bl_value = a.raw, b.raw
        r.confidence = round(min(r.confidence, extraction_conf), 3)
        out.append(r)
    return out


def _compare_party(f, a: FieldValue, b: FieldValue, kb, cfg) -> FieldResult:
    na, nb = normalise_party(a.raw), normalise_party(b.raw)
    if kb is not None:
        na, nb = kb.canonical_party(na), kb.canonical_party(nb)
    res = FieldResult(f, "match", "", 0.99, si_norm=na, bl_norm=nb)
    if na == nb:
        res.reason = "same company name" + ("" if a.raw == b.raw else " (formatting differs)")
        return res
    if is_order_only(a.raw) or is_order_only(b.raw):
        res.result, res.confidence = "unsure", 0.5
        res.reason = "one side is a bare “TO ORDER” - negotiable BL wording needs a human check"
        return res
    ratio = fuzz.ratio(na, nb) / 100
    ca, cb = party_core(na), party_core(nb)
    if ca and ca == cb:
        res.result, res.confidence = "unsure", 0.55
        res.reason = "same name but the legal form differs (e.g. LTD / LLC dropped)"
    elif ratio >= cfg["party_fuzzy_match"] and abs(len(na) - len(nb)) <= 2:
        res.result, res.confidence = "match", 0.75
        res.reason = f"spelling variation only (similarity {ratio:.0%})"
    elif ratio >= cfg["party_fuzzy_unsure"]:
        res.result, res.confidence = "unsure", 0.5
        res.reason = f"names are close but not identical (similarity {ratio:.0%})"
    else:
        res.result, res.confidence = "mismatch", 0.97
        res.reason = f"different company (similarity {ratio:.0%})"
    return res


def _compare_port(f, a: FieldValue, b: FieldValue, kb) -> FieldResult:
    extra = kb.port_aliases() if kb is not None else None
    pa, pb = normalise_port(a.raw, extra), normalise_port(b.raw, extra)
    res = FieldResult(f, "match", "", 0.99, si_norm=pa["key"], bl_norm=pb["key"])
    if pa["key"] == pb["key"]:
        if pa["country"] and pb["country"] and pa["country"] != pb["country"]:
            res.result, res.confidence = "unsure", 0.5
            res.reason = f"same port name but different country ({pa['country']} vs {pb['country']})"
        elif pa["locode"] and pb["locode"] and pa["locode"] != pb["locode"]:
            res.result, res.confidence = "unsure", 0.55
            res.reason = f"same port name but UN/LOCODE differs ({pa['locode']} vs {pb['locode']})"
        else:
            res.reason = "same port" + ("" if a.raw == b.raw else " (format / code suffix differs)")
        return res
    ratio = fuzz.ratio(pa["key"], pb["key"]) / 100
    if ratio >= 0.9 and (not pa["country"] or not pb["country"] or pa["country"] == pb["country"]):
        res.result, res.confidence = "unsure", 0.5
        res.reason = f"port names nearly identical (similarity {ratio:.0%}) - possible spelling variant"
        return res
    res.result, res.confidence = "mismatch", 0.97
    note = ""
    if pa["locode"] and pa["locode"] == pb["locode"]:
        note = f"; note the code {pa['locode']} is the same on both, the port NAME was changed"
    res.reason = f"different port: {pa['key']} vs {pb['key']}{note}"
    return res


def _compare_count(f, a: FieldValue, b: FieldValue) -> FieldResult:
    (ca, ta), (cb, tb) = parse_container_count(a.raw), parse_container_count(b.raw)
    res = FieldResult(f, "match", "", 0.99, si_norm=str(ca), bl_norm=str(cb))
    if ca is None or cb is None:
        res.result, res.confidence = "unsure", 0.4
        res.reason = "could not read a container count from " + ("SI" if ca is None else "BL")
    elif ca != cb:
        res.result, res.confidence = "mismatch", 0.98
        res.reason = f"SI says {ca} container(s), BL says {cb}"
    else:
        res.reason = f"{ca} container(s) on both"
        sa, sb = sorted(t[:2] for t in ta), sorted(t[:2] for t in tb)
        if sa and sb and sa != sb:
            res.confidence = 0.8
            res.reason += f" (container size differs: {','.join(ta)} vs {','.join(tb)} - count still matches)"
    return res


def _compare_weight(f, a: FieldValue, b: FieldValue, cfg) -> FieldResult:
    wa, wb = parse_weight_kg(a.raw, a.label or ""), parse_weight_kg(b.raw, b.label or "")
    res = FieldResult(f, "match", "", 0.99, si_norm=_fmt(wa), bl_norm=_fmt(wb))
    if wa is None or wb is None:
        res.result, res.confidence = "unsure", 0.4
        res.reason = "could not read a weight from " + ("SI" if wa is None else "BL")
        return res
    tol = max(cfg["weight_tolerance_kg"], cfg["weight_tolerance_pct"] / 100 * wa)
    diff = abs(wa - wb)
    if diff <= tol:
        res.reason = "same weight" if diff == 0 else f"within tolerance ({diff:g} kg ≤ {tol:g} kg)"
    else:
        res.result, res.confidence = "mismatch", 0.98
        res.reason = f"SI {wa:,.0f} kg vs BL {wb:,.0f} kg (difference {diff:,.0f} kg)"
    return res


def _fmt(x):
    return None if x is None else f"{x:g}"
