"""Manual-trigger analytics: compute metrics from the case data, then ask the
LLM for a short plain-language report (templated summary when no LLM)."""
import datetime as dt
import json
from collections import Counter, defaultdict

from app import config, db, llm
from app.config import FIELD_LABELS


def _parse_date(v):
    try:
        return dt.datetime.fromisoformat(v) if v else None
    except ValueError:
        return None


def compute(filters: dict) -> dict:
    f = filters or {}
    d_from, d_to = _parse_date(f.get("date_from")), _parse_date(f.get("date_to"))
    with db.session() as s:
        users = {u.id: u.name for u in s.query(db.User)}
        labels = {l.id: l.name for l in s.query(db.Label)}
        by_case_labels = defaultdict(set)
        for cl in s.query(db.CaseLabel):
            by_case_labels[cl.email_id].add(labels.get(cl.label_id))
        rows = []
        for case, email in s.query(db.Case, db.Email).join(db.Email, db.Email.id == db.Case.email_id):
            if d_from and email.received_at < d_from:
                continue
            if d_to and email.received_at > d_to + dt.timedelta(days=1):
                continue
            if f.get("carrier") and (case.carrier or "") != f["carrier"]:
                continue
            if f.get("customer") and (case.customer or "") != f["customer"]:
                continue
            if f.get("label") and f["label"] not in by_case_labels[case.email_id]:
                continue
            rows.append((case, email))
        corrections = s.query(db.Correction).all()
        sent = {x.email_id for x in s.query(db.Sent)}

        checks = [c for c, _ in rows if c.category == "BL_COMPARISON" and (c.result or {}).get("fields")]
        compared = [c for c in checks if any(fr["result"] != "not_compared" for fr in c.result["fields"])]
        total_bl = sum(1 for c, _ in rows if c.category == "BL_COMPARISON")
        status = Counter(c.status for c, _ in rows if c.category == "BL_COMPARISON")
        cat = Counter(c.category for c, _ in rows)
        field_mis = Counter(f_ for c in compared for f_ in (c.defect_fields or []))
        reasons = Counter(c.review_reason for c in checks if c.status == "NEEDS_REVIEW" and c.review_reason)

        def hotspot(attr):
            tot, bad = Counter(), Counter()
            for c in compared:
                k = getattr(c, attr) or "Unknown"
                tot[k] += 1
                bad[k] += c.status == "MISMATCH"
            return sorted(({"name": k, "checked": tot[k], "mismatch": bad[k],
                            "rate": round(bad[k] / tot[k], 3)} for k in tot), key=lambda x: (-x["mismatch"], -x["rate"]))

        workload = Counter()
        open_review = Counter()
        for c, _ in rows:
            if c.assignee_id:
                workload[users.get(c.assignee_id, "?")] += 1
                if c.needs_human and not c.resolved:
                    open_review[users.get(c.assignee_id, "?")] += 1
        resolved = [c for c, _ in rows if c.resolved and c.resolved_at and c.processed_at]
        ttr = [(c.resolved_at - c.processed_at).total_seconds() / 60 for c in resolved if c.resolved_at >= c.processed_at]
        ids = {c.email_id for c, _ in rows}
        corr_in = [c for c in corrections if c.email_id in ids]
        corr_by_day = Counter(c.at.strftime("%Y-%m-%d") for c in corr_in)
        corr_by_kind = Counter(c.kind for c in corr_in)
        by_day = defaultdict(lambda: Counter())
        for c, e in rows:
            if c.category == "BL_COMPARISON":
                by_day[e.received_at.strftime("%m-%d")][c.status] += 1
        auto = sum(1 for c, _ in rows if c.category == "BL_COMPARISON" and not c.needs_human)
        # ---- how well the APP is doing (for a manager): how often people had to overrule it, what the AI did and cost
        overruled = [c for c in corr_in if c.kind in ("verdict", "field_result", "field_value", "category")]
        overruled_fields = Counter(FIELD_LABELS.get(c.field, c.field) for c in overruled if c.field)
        results = [c.result or {} for c, _ in rows]
        ai_sorted = sum(1 for r in results if (r.get("classification") or {}).get("decided_by") == "llm")
        ai_read = sum(1 for r in results if any(((fr.get(side) or {}).get("method") == "llm") for fr in r.get("fields") or [] for side in ("si", "bl")))
        sugg = Counter(x.status for x in s.query(db.Suggestion))
        low_conf = [c for c in compared if c.confidence and c.confidence < 0.8]
        return {
            "filters": f, "emails": len(rows), "bl_checks": total_bl, "compared": len(compared),
            "categories": dict(cat), "status": dict(status),
            "auto_rate": round(auto / total_bl, 3) if total_bl else 0,
            "review_rate": round(1 - auto / total_bl, 3) if total_bl else 0,
            "mismatch_rate": round(status.get("MISMATCH", 0) / len(compared), 3) if compared else 0,
            "review_queue_open": sum(1 for c, _ in rows if c.needs_human and not c.resolved),
            "review_resolved": len(resolved),
            "avg_minutes_to_resolve": round(sum(ttr) / len(ttr), 1) if ttr else None,
            "replies_sent": len(sent & ids),
            "field_mismatches": [{"field": k, "label": FIELD_LABELS[k], "count": v} for k, v in field_mis.most_common()],
            "review_reasons": dict(reasons),
            "carriers": hotspot("carrier")[:12], "customers": hotspot("customer")[:12],
            "workload": [{"name": k, "assigned": v, "open_review": open_review.get(k, 0)} for k, v in workload.most_common()],
            "corrections_total": len(corr_in), "corrections_by_kind": dict(corr_by_kind),
            "corrections_by_day": [{"day": k, "count": v} for k, v in sorted(corr_by_day.items())],
            "correction_rate": round(len({c.email_id for c in corr_in}) / total_bl, 3) if total_bl else 0,
            "timeline": [{"day": d, **dict(v)} for d, v in sorted(by_day.items())],
            "low_confidence_cases": len(low_conf),
            # the four things a check request can turn out to be, in plain counts (they add up to bl_checks)
            "outcome": {"clean": sum(1 for c in compared if c.status == "OK"), "mistake": status.get("MISMATCH", 0),
                        "person": status.get("NEEDS_REVIEW", 0), "failed": status.get("FAILED", 0),
                        "nothing_yet": sum(1 for c, _ in rows if c.category == "BL_COMPARISON" and c.status == "OK" and c not in compared)},
            "app": {
                "auto_count": auto,
                "overruled_cases": len({c.email_id for c in overruled}),
                "overruled_rate": round(len({c.email_id for c in overruled}) / total_bl, 3) if total_bl else 0,
                "overruled_by_kind": dict(Counter(c.kind for c in overruled)),
                "overruled_fields": [{"label": k, "count": v} for k, v in overruled_fields.most_common(7)],
                "replies_edited": corr_by_kind.get("draft", 0),
                "failed": sum(1 for c, _ in rows if c.status == "FAILED"),
            },
            "cost": _cost(len(rows), total_bl),
            "ai": {"connected": llm.available(), "model": llm.model() if llm.available() else None, **llm.usage(),
                   "budget_usd": config.LLM_BUDGET_USD or None, "emails_sorted": ai_sorted, "documents_read": ai_read,
                   "previews": sum(1 for r in results if r.get("preview"))},
            "learning": {"pending": sugg.get("pending", 0), "approved": sugg.get("approved", 0), "rejected": sugg.get("rejected", 0)},
        }


def _templated_summary(m: dict) -> str:
    lines = [f"**{m['emails']} emails** analysed, of which **{m['bl_checks']} were BL checks** "
             f"({m['compared']} had both documents and were compared field by field)."]
    lines.append(f"The AI closed **{m['auto_rate']:.0%}** of BL checks on its own and sent **{m['review_rate']:.0%}** "
                 f"to a person. **{m['mismatch_rate']:.0%}** of compared drafts had at least one discrepancy.")
    if m["field_mismatches"]:
        top = m["field_mismatches"][:3]
        lines.append("Most common mismatch fields: " + ", ".join(f"**{t['label']}** ({t['count']})" for t in top) + ".")
    hot = [c for c in m["carriers"] if c["checked"] >= 3 and c["mismatch"]]
    if hot:
        worst = max(hot, key=lambda c: c["rate"])
        lines.append(f"Error hotspot by carrier: **{worst['name']}** - {worst['mismatch']} of {worst['checked']} drafts "
                     f"({worst['rate']:.0%}) needed amendment.")
    hotc = [c for c in m["customers"] if c["checked"] >= 3 and c["mismatch"]]
    if hotc:
        worst = max(hotc, key=lambda c: c["rate"])
        lines.append(f"By sender/customer: **{worst['name']}** has the highest amendment rate ({worst['rate']:.0%} "
                     f"of {worst['checked']}).")
    if m["workload"]:
        w = m["workload"][0]
        lines.append(f"Workload: **{w['name']}** holds the largest queue ({w['assigned']} cases, {w['open_review']} awaiting review).")
    lines.append(f"Review queue: **{m['review_queue_open']} open**, {m['review_resolved']} resolved"
                 + (f", average {m['avg_minutes_to_resolve']} min to resolve." if m["avg_minutes_to_resolve"] is not None else "."))
    lines.append(f"Staff corrected the AI on **{m['correction_rate']:.1%}** of BL checks ({m['corrections_total']} edits).")
    sug = []
    if m["review_reasons"].get("unreadable", 0) >= 3:
        sug.append("several scans were escalated - ask those senders for text PDFs, or enable OCR auto-accept above a high confidence")
    if m["correction_rate"] == 0 and m["low_confidence_cases"] == 0 and m["review_rate"] < 0.15:
        sug.append("no corrections and no low-confidence results - the current thresholds look safe; keep them")
    if m["correction_rate"] > 0.1:
        sug.append("correction rate is above 10% - run the learning report and review the proposed aliases")
    if hot and max(c["rate"] for c in hot) > 0.35:
        sug.append("add a rule that tags the hotspot carrier's drafts for a second pair of eyes")
    if sug:
        lines.append("Suggested changes: " + "; ".join(sug) + ".")
    return "\n\n".join(lines)


def _cost(emails: int, checks: int) -> dict:
    """What the AI has cost, and what that means per email - a manager's first question."""
    u = llm.usage()
    spent = float(u.get("cost_usd") or 0)
    return {"spent_usd": round(spent, 4), "budget_usd": config.LLM_BUDGET_USD or None, "calls": u.get("calls", 0),
            "per_email_usd": round(spent / emails, 6) if emails else 0, "per_check_usd": round(spent / checks, 6) if checks else 0,
            "per_1000_emails_usd": round(spent / emails * 1000, 2) if emails else 0,
            "by_task": [{"task": k, "calls": v["calls"], "cost_usd": round(v["cost_usd"], 4)}
                        for k, v in sorted((u.get("by_task") or {}).items(), key=lambda kv: -kv[1]["cost_usd"])]}


def _facts(m: dict) -> dict:
    """The same numbers under names that cannot be misread (the raw metrics confused the model)."""
    a, ai = m["app"], m["ai"]
    return {
        "emails_in_total": m["emails"], "emails_asking_for_a_document_check": m["bl_checks"],
        "checks_where_both_documents_were_compared": m["compared"],
        "share_of_document_checks_that_needed_no_person": f"{m['auto_rate']:.0%}",
        "share_of_document_checks_where_the_app_itself_asked_a_person_to_decide": f"{m['review_rate']:.0%}",
        "share_of_compared_drafts_with_a_mistake": f"{m['mismatch_rate']:.0%}", "drafts_with_a_mistake": m["status"].get("MISMATCH", 0),
        "details_that_go_wrong_most": m["field_mismatches"][:4],
        "shipping_lines_with_most_wrong_drafts": m["carriers"][:4], "customers_with_most_wrong_drafts": m["customers"][:4],
        "waiting_for_a_person_now": m["review_queue_open"], "settled_by_a_person": m["review_resolved"],
        "average_minutes_to_settle": m["avg_minutes_to_resolve"], "replies_sent": m["replies_sent"], "workload_per_person": m["workload"],
        "checks_a_person_had_to_correct": a["overruled_cases"], "share_of_checks_corrected": f"{a['overruled_rate']:.0%}",
        "details_people_corrected_most": a["overruled_fields"], "replies_reworded_before_sending": a["replies_edited"], "checks_that_failed": a["failed"],
        "ai_connected": ai["connected"], "ai_calls": ai["calls"], "ai_cost_so_far_usd": m["cost"]["spent_usd"], "ai_budget_cap_usd": ai["budget_usd"],
        "ai_cost_per_1000_emails_usd": m["cost"]["per_1000_emails_usd"], "ai_cost_by_task": m["cost"]["by_task"],
        "ai_wrote_email_previews": ai["previews"], "ai_sorted_unclear_emails": ai["emails_sorted"], "ai_read_hard_documents": ai["documents_read"],
        "suggestions_learned_from_corrections": m["learning"],
    }


def analyze(filters: dict) -> dict:
    m = compute(filters)
    summary, engine = None, "template"
    if llm.available():
        data = llm.complete_json(
            "You write a short report for the MANAGER of a shipping-documents team, in plain English, no jargon "
            "(6-9 short sentences, markdown, bold the key numbers). Cover: how much of the work the app handled without a "
            "person, how often people overruled the app and on what ('app'), where the mistakes come from, workload, the "
            "waiting line, what the AI cost so far and per 1,000 emails, and one or two concrete suggestions. "
            "IMPORTANT: 'carriers' are SHIPPING LINES (the companies that move containers); 'customers' are the SENDERS of "
            "the emails. Never call a customer a carrier. Use only the numbers given, exactly as labelled; do not "
            "work out new percentages. Do not praise; state facts. With zero corrections say 'nobody has corrected the "
            "app yet', not that it is trusted. The app ASKING a person to decide is not the same as a person CORRECTING "
            "the app: never mix the two. Suggestions must be about the work (a shipping line, a customer, a detail, the "
            "waiting line), never about budget or training.",
            json.dumps(_facts(m)), '{"summary": "markdown"}', max_tokens=900)
        if data and data.get("summary"):
            summary, engine = data["summary"], "llm"
    summary = summary or _templated_summary(m)
    m["cost"] = _cost(m["emails"], m["bl_checks"])      # again, so the bill includes the summary that was just written
    m["ai"].update({k: v for k, v in llm.usage().items() if k != "by_task"})
    with db.session() as s:
        rep = db.AnalyticsReport(filters=filters, metrics=m, summary=summary, engine=engine)
        s.add(rep)
        s.flush()
        rid, created = rep.id, rep.created_at
    return {"id": rid, "created_at": created, "metrics": m, "summary": summary, "engine": engine}


def to_markdown(rep: dict, product: str) -> str:
    m = rep["metrics"]
    out = [f"# {product} analytics report", f"_Generated {rep['created_at']} - filters: {json.dumps(m['filters'])}_", "",
           "## Summary", rep["summary"], "", "## Key numbers",
           f"- Emails: {m['emails']}  |  BL checks: {m['bl_checks']}  |  compared: {m['compared']}",
           f"- Auto rate: {m['auto_rate']:.0%}  |  review rate: {m['review_rate']:.0%}  |  mismatch rate: {m['mismatch_rate']:.0%}",
           f"- Review queue open: {m['review_queue_open']}  |  resolved: {m['review_resolved']}  |  correction rate: {m['correction_rate']:.1%}",
           "", "## Mismatch fields", "| Field | Count |", "|---|---|"]
    out += [f"| {x['label']} | {x['count']} |" for x in m["field_mismatches"]]
    out += ["", "## Carriers", "| Carrier | Checked | Mismatch | Rate |", "|---|---|---|---|"]
    out += [f"| {x['name']} | {x['checked']} | {x['mismatch']} | {x['rate']:.0%} |" for x in m["carriers"]]
    out += ["", "## Customers / senders", "| Sender | Checked | Mismatch | Rate |", "|---|---|---|---|"]
    out += [f"| {x['name']} | {x['checked']} | {x['mismatch']} | {x['rate']:.0%} |" for x in m["customers"]]
    if m.get("cost"):
        c = m["cost"]
        out += ["", "## Cost of the AI", f"- Spent so far: ${c['spent_usd']:.4f}" + (f" of a ${c['budget_usd']:.2f} cap" if c.get("budget_usd") else ""),
                f"- Per email: ${c['per_email_usd']:.6f}  |  per 1,000 emails: ${c['per_1000_emails_usd']:.2f}", "", "| Task | Calls | Cost |", "|---|---|---|"]
        out += [f"| {x['task']} | {x['calls']} | ${x['cost_usd']:.4f} |" for x in c["by_task"]]
    out += ["", "## Workload", "| Person | Assigned | Open review |", "|---|---|---|"]
    out += [f"| {x['name']} | {x['assigned']} | {x['open_review']} |" for x in m["workload"]]
    return "\n".join(out)
