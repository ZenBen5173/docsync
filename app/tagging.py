"""Gmail-style labels: auto-tags (carrier / customer / port of discharge),
admin-defined rules, and tag -> employee routing with a backup person.
`retag_all` re-applies everything live when a rule or route changes."""
from app import db
from app.safe_regex import user_search

PALETTE = ["#1a73e8", "#d93025", "#188038", "#e37400", "#9334e6", "#007b83", "#c5221f", "#b06000",
           "#3c4043", "#a142f4", "#12805c", "#e52592", "#0b57d0", "#7b5a00", "#5f6368", "#6d4c41"]


def _color(name: str) -> str:
    return PALETTE[sum(ord(c) for c in name) % len(PALETTE)]


def get_or_create_label(s, name: str, kind: str = "auto", group: str | None = None) -> db.Label:
    lab = s.query(db.Label).filter(db.Label.name == name).first()
    if not lab:
        lab = db.Label(name=name, kind=kind, group=group, color=_color(name))
        s.add(lab)
        s.flush()
    return lab


def _case_facts(case: db.Case, email: db.Email) -> dict:
    return {
        "carrier": case.carrier or "", "customer": case.customer or "", "pod": case.pod or "",
        "category": case.category or "", "status": case.status or "",
        "sender": email.sender or "", "sender_domain": (email.sender or "").split("@")[-1],
        "subject": email.subject or "", "body": email.body or "",
        "review_reason": case.review_reason or "", "defect_field": " ".join(case.defect_fields or []),
    }


def rule_matches(conditions: list[dict], facts: dict) -> bool:
    """All conditions must hold. ops: contains | is | is_not | starts_with | ends_with | regex"""
    if not conditions:
        return False
    for c in conditions:
        have = str(facts.get(c.get("field"), "")).lower()
        want = str(c.get("value", "")).lower()
        op = c.get("op", "contains")
        ok = {"contains": want in have, "is": have == want, "is_not": have != want,
              "starts_with": have.startswith(want), "ends_with": have.endswith(want)}.get(op)
        if op == "regex":
            ok = user_search(c.get("value", ""), str(facts.get(c.get("field"), "")))
        if not ok:
            return False
    return True


def apply_tags(s, case: db.Case, email: db.Email):
    """Recompute auto + rule labels (manual labels are kept) and the assignee."""
    s.query(db.CaseLabel).filter(db.CaseLabel.email_id == case.email_id,
                                 db.CaseLabel.source.in_(["auto", "rule"])).delete(synchronize_session=False)
    s.flush()
    have = {cl.label_id for cl in s.query(db.CaseLabel).filter(db.CaseLabel.email_id == case.email_id)}

    def add(label: db.Label, source: str):
        if label.id not in have:
            s.add(db.CaseLabel(email_id=case.email_id, label_id=label.id, source=source))
            have.add(label.id)

    if case.category in ("BL_COMPARISON", "SI_REQUEST", "INVOICE_QUERY"):
        if case.carrier:
            add(get_or_create_label(s, case.carrier, "auto", "carrier"), "auto")
        if case.customer:
            add(get_or_create_label(s, case.customer, "auto", "customer"), "auto")
        if case.pod:
            add(get_or_create_label(s, f"POD {case.pod}", "auto", "pod"), "auto")
    facts = _case_facts(case, email)
    for rule in s.query(db.Rule).filter(db.Rule.enabled == True):  # noqa: E712
        if rule.label_id and rule_matches(rule.conditions or [], facts):
            lab = s.get(db.Label, rule.label_id)
            if lab:
                add(lab, "rule")
    s.flush()
    route_case(s, case, have)


def route_case(s, case: db.Case, label_ids: set[int]):
    """First matching route wins (by priority). Falls back to the backup person
    when the primary is inactive. Manual assignments are never overwritten."""
    if (case.overrides or {}).get("assignee_locked"):
        return
    if case.category == "SPAM":
        case.assignee_id = None
        return
    routes = s.query(db.Route).order_by(db.Route.priority.desc(), db.Route.id).all()
    for r in routes:
        if r.label_id in label_ids:
            primary = s.get(db.User, r.user_id) if r.user_id else None
            backup = s.get(db.User, r.backup_user_id) if r.backup_user_id else None
            chosen = primary if primary and primary.active else backup
            if chosen:
                case.assignee_id = chosen.id
                return
    case.assignee_id = None


def retag_all(s) -> int:
    n = 0
    for case in s.query(db.Case).all():
        email = s.get(db.Email, case.email_id)
        if email:
            apply_tags(s, case, email)
            n += 1
    return n
