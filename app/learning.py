"""Learning loop. Staff edits (field corrections, verdict/category changes,
draft edits) are stored as diffs. The end-of-day job groups them into PROPOSED
knowledge-base changes; nothing enters the KB until an admin clicks Add.

Two engines, same output: an LLM grouping pass when a key is configured,
otherwise a deterministic grouper (so the loop always works)."""
import json
import re
from collections import defaultdict

from app import db, llm
from app.compare.normalize import normalise_party, normalise_port

PARTY = {"shipper", "consignee", "notify_party"}
PORT = {"port_of_loading", "port_of_discharge"}


_ABBREV = re.compile(r"\b(no|nos|ref|refs|mr|mrs|ms|dr|st|co|ltd|inc|approx|etc|attn|tel|fax|vs|e\.g|i\.e)\.$", re.I)


def _sentences(text: str) -> list[str]:
    out: list[str] = []
    for line in (text or "").splitlines():
        for piece in re.split(r"(?<=[.!?])\s+", line):
            piece = piece.strip()
            if not piece:
                continue
            if out and out[-1].endswith(".") and _ABBREV.search(out[-1]) and out[-1] in line:
                out[-1] = f"{out[-1]} {piece}"      # "BL no. 123" is one sentence, not two
            else:
                out.append(piece)
    return out


def draft_added_lines(ai_body: str, final_body: str) -> tuple[list[str], list[str]]:
    """Sentence-level diff: what staff added to / removed from the AI draft."""
    a, b = _sentences(ai_body), _sentences(final_body)
    sa, sb = set(a), set(b)
    return [x for x in b if x not in sa], [x for x in a if x not in sb]


def _templatise(line: str, refs: dict) -> str:
    for key in ("bl_no", "oc_no", "booking", "invoice"):
        v = (refs or {}).get(key)
        if v and v in line:
            line = line.replace(v, "{" + key + "}")
    return line


def _heuristic(corrs: list[db.Correction]) -> list[dict]:
    out: list[dict] = []
    alias: dict[tuple, list[str]] = defaultdict(list)
    hints: dict[tuple, list[str]] = defaultdict(list)
    reply: dict[tuple, list[str]] = defaultdict(list)
    for c in corrs:
        ctx = c.context or {}
        if c.kind == "field_result" and c.final_value == "match" and c.ai_value in ("mismatch", "unsure"):
            si, bl = ctx.get("si_value"), ctx.get("bl_value")
            if si and bl and c.field in PARTY | PORT:
                kind = "party_alias" if c.field in PARTY else "port_alias"
                norm = normalise_party if c.field in PARTY else (lambda v: normalise_port(v)["key"])
                if norm(si) != norm(bl):
                    alias[(kind, norm(bl), norm(si))].append(c.email_id)
        elif c.kind == "category":
            sender_dom = (ctx.get("sender") or "").split("@")[-1]
            first = " ".join(re.findall(r"[A-Za-z]{3,}", ctx.get("message", ""))[:5])
            if first:
                hints[(re.escape(first).replace("\\ ", r"\s+"), c.final_value, sender_dom)].append(c.email_id)
        elif c.kind == "draft":
            added, _ = draft_added_lines(c.ai_value, c.final_value)
            for line in added:
                if len(line) > 12 and not line.lower().startswith(("dear", "best regards", "hi ")):
                    reply[(ctx.get("status", "ALL"), _templatise(line, ctx.get("refs")))].append(c.email_id)
    for (kind, key, value), ids in alias.items():
        what = "company" if kind == "party_alias" else "port"
        out.append({"kind": kind, "title": f"Add alias {key} = {value}",
                    "payload": {"kind": kind, "key": key, "value": value,
                                "note": f"Staff marked these as the same {what}"},
                    "rationale": f"Reviewers overrode the AI and treated “{key}” and “{value}” as the same {what} "
                                 f"in {len(ids)} correction(s). With the alias the comparison will match automatically.",
                    "evidence": ids})
    for (pattern, category, dom), ids in hints.items():
        out.append({"kind": "classifier_hint", "title": f"Emails like “{pattern[:40]}…” are {category}",
                    "payload": {"kind": "classifier_hint", "key": pattern, "value": category,
                                "note": f"Learned from category corrections (sender {dom})", "meta": {"weight": 4.0}},
                    "rationale": f"A reviewer re-categorised {len(ids)} email(s) with this opening to {category}.",
                    "evidence": ids})
    for (status, line), ids in reply.items():
        out.append({"kind": "reply_rule", "title": f"Add to {status} reply: “{line[:60]}”",
                    "payload": {"kind": "reply_rule", "key": status, "value": line,
                                "note": "Sentence staff keep adding to the auto-draft"},
                    "rationale": f"Staff added this line to {len(ids)} {status} draft(s) before sending.",
                    "evidence": ids})
    return out


def _llm(corrs: list[db.Correction]) -> list[dict] | None:
    diffs = [{"email_id": c.email_id, "kind": c.kind, "field": c.field, "ai": (c.ai_value or "")[:600],
              "final": (c.final_value or "")[:600], "context": {k: v for k, v in (c.context or {}).items()
                                                                 if k in ("si_value", "bl_value", "status", "sender")}}
             for c in corrs][:60]
    data = llm.complete_json(
        "You maintain the knowledge base of a shipping-document checker. Group the staff corrections below into "
        "a SHORT list of proposed knowledge-base changes. Allowed kinds: port_alias (key=variant, value=canonical), "
        "party_alias (key=variant, value=canonical), label_alias (key=label text, value=one of the 7 field ids), "
        "classifier_hint (key=regex, value=category), reply_rule (key=OK|MISMATCH|NEEDS_REVIEW|ALL, value=sentence "
        "to add to the reply template; placeholders {bl_no} {oc_no}). Merge duplicates and count them. "
        "Do not invent changes that the corrections do not support.",
        json.dumps(diffs, ensure_ascii=False),
        '{"summary": "2-3 sentences", "suggestions": [{"kind": "", "title": "", "key": "", "value": "", '
        '"rationale": "", "evidence": ["email_id"]}]}', max_tokens=2000)
    if not data or not isinstance(data.get("suggestions"), list):
        return None
    out = []
    for sg in data["suggestions"]:
        if sg.get("kind") in ("port_alias", "party_alias", "label_alias", "classifier_hint", "reply_rule") and sg.get("key"):
            out.append({"kind": sg["kind"], "title": sg.get("title") or f"{sg['kind']}: {sg['key']}",
                        "payload": {"kind": sg["kind"], "key": sg["key"], "value": sg.get("value", ""),
                                    "note": "Proposed by the daily learning report"},
                        "rationale": sg.get("rationale", ""), "evidence": sg.get("evidence") or []})
    return [{"_summary": data.get("summary", "")}] + out


def generate_report(include_consumed: bool = False) -> dict:
    with db.session() as s:
        q = s.query(db.Correction)
        if not include_consumed:
            q = q.filter(db.Correction.consumed == False)  # noqa: E712
        corrs = q.order_by(db.Correction.at).all()
        engine, summary = "heuristic", ""
        suggestions = None
        if corrs and llm.available():
            suggestions = _llm(corrs)
            if suggestions is not None:
                engine, summary = "llm", suggestions[0].get("_summary", "")
                suggestions = suggestions[1:]
        if suggestions is None:
            suggestions = _heuristic(corrs)
        kinds = defaultdict(int)
        for c in corrs:
            kinds[c.kind] += 1
        if not summary:
            summary = (f"{len(corrs)} staff correction(s) reviewed ("
                       + ", ".join(f"{n} {k.replace('_', ' ')}" for k, n in kinds.items())
                       + f"). {len(suggestions)} knowledge-base change(s) proposed.") if corrs else \
                "No new staff corrections since the last report."
        report = db.LearningReport(summary=summary, corrections=len(corrs), engine=engine)
        s.add(report)
        s.flush()
        existing = {(i.kind, i.key.lower(), (i.value or "").lower()) for i in s.query(db.KBItem).filter(db.KBItem.active == True)}  # noqa: E712
        pending = {(g.payload.get("kind"), g.payload.get("key", "").lower(), g.payload.get("value", "").lower())
                   for g in s.query(db.Suggestion).filter(db.Suggestion.status == "pending")}
        made = 0
        for sg in suggestions:
            p = sg["payload"]
            sig = (p["kind"], p["key"].lower(), (p.get("value") or "").lower())
            if sig in existing or sig in pending:
                continue
            s.add(db.Suggestion(report_id=report.id, kind=sg["kind"], payload=p, title=sg["title"],
                                rationale=sg["rationale"], evidence=sorted(set(sg["evidence"])),
                                evidence_count=len(sg["evidence"])))
            made += 1
        for c in corrs:
            c.consumed = True
        return {"report_id": report.id, "summary": summary, "corrections": len(corrs), "suggestions": made,
                "engine": engine}


def decide(suggestion_id: int, approve: bool, user: str) -> dict:
    with db.session() as s:
        sg = s.get(db.Suggestion, suggestion_id)
        if not sg or sg.status != "pending":
            return {"ok": False, "error": "suggestion not found or already decided"}
        sg.status, sg.decided_at, sg.decided_by = ("approved" if approve else "rejected"), db.now(), user
        item_id = None
        if approve:
            p = sg.payload
            item = db.KBItem(kind=p["kind"], key=p["key"], value=p.get("value", ""), note=p.get("note"),
                             meta=p.get("meta") or {}, source="learned")
            s.add(item)
            s.flush()
            item_id = item.id
            s.add(db.KBHistory(item_id=item.id, action="add", before=None, user=user,
                               after={"kind": item.kind, "key": item.key, "value": item.value,
                                      "from_suggestion": sg.id}))
        return {"ok": True, "status": sg.status, "kb_item_id": item_id}
