"""Glue between the pure engine and the database: seeding, saving results,
human overrides, settings and knowledge-base loading."""
import datetime as dt
import re

from app import config, db, events, tagging
from app.config import DEFAULT_SETTINGS
from app.drafts import build_draft
from app.kb.store import SEED_ITEMS, KnowledgeBase

# Fictional demo team (invented names, reserved .example addresses) - nobody real is published.
SEED_USERS = [
    ("Maya Tan", "maya.tan@doccheck.example", "admin", "#1a73e8"),
    ("Arif Rahman", "arif.rahman@doccheck.example", "reviewer", "#188038"),
    ("Dewi Lestari", "dewi.lestari@doccheck.example", "reviewer", "#e37400"),
    ("Jun Wei Lim", "junwei.lim@doccheck.example", "reviewer", "#9334e6"),
    ("Guest Viewer", "guest@doccheck.example", "viewer", "#007b83"),
]
# carrier -> (primary, backup) by user index above; shows the "own your carrier's queue" idea
SEED_ROUTES = {"MSC": (1, 2), "OOCL": (1, 3), "Evergreen": (2, 1), "Yang Ming": (2, 3), "CMA CGM": (3, 1),
               "ONE": (3, 2), "Hapag-Lloyd": (1, 2), "Monter": (2, 1), "PIL": (3, 2), "Maersk": (3, 1)}

_bootstrapped = False


def bootstrap():
    global _bootstrapped
    if _bootstrapped:
        return
    db.init_db()
    with db.session() as s:
        if not s.query(db.User).count():
            for name, email, role, color in SEED_USERS:
                s.add(db.User(name=name, email=email, role=role, color=color))
        if not s.query(db.KBItem).count():
            for it in SEED_ITEMS:
                s.add(db.KBItem(kind=it["kind"], key=it["key"], value=it["value"], note=it.get("note"),
                                source="seed", meta=it.get("meta") or {}))
        if not s.get(db.Setting, "thresholds"):
            s.add(db.Setting(key="thresholds", value=dict(DEFAULT_SETTINGS)))
        s.flush()
        if not s.query(db.Route).count():
            users = s.query(db.User).order_by(db.User.id).all()
            for carrier, (p, b) in SEED_ROUTES.items():
                lab = tagging.get_or_create_label(s, carrier, "auto", "carrier")
                s.add(db.Route(label_id=lab.id, user_id=users[p].id, backup_user_id=users[b].id))
        if not s.query(db.Rule).count():
            urgent = tagging.get_or_create_label(s, "Needs amendment", "custom")
            s.add(db.Rule(name="Mismatch -> Needs amendment", label_id=urgent.id,
                          conditions=[{"field": "status", "op": "is", "value": "MISMATCH"}]))
            ext = tagging.get_or_create_label(s, "External sender", "custom")
            s.add(db.Rule(name="Non-APRIL sender domain", label_id=ext.id,
                          conditions=[{"field": "sender_domain", "op": "regex", "value": r"^(?!.*april).*$"},
                                      {"field": "category", "op": "is_not", "value": "SPAM"}]))
    _bootstrapped = True


# ------------------------------------------------------------------ source + demo snapshot
def inbox_source() -> str:
    """Where emails and attachments are read from: server configuration only, never request input,
    and never a path remembered in the database (a database seeded on another machine would carry
    that machine's absolute path)."""
    return config.DEFAULT_SOURCE


def _seed_file():
    """The snapshot to restore: one taken on this machine, else the one shipped with the deployment."""
    return config.SEED_DB if config.SEED_DB.exists() else (config.BUNDLED_SEED if config.BUNDLED_SEED.exists() else None)


def seed_available() -> bool:
    return _seed_file() is not None


def snapshot_seed():
    """Freeze the current database as the clean demo state (done once, right after seeding)."""
    import sqlite3
    src, dst = sqlite3.connect(db.engine.url.database), sqlite3.connect(config.SEED_DB)
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()


def restore_seed():
    """Put the demo back to its seeded state. SQLite's online-backup API overwrites the live
    database inside one write transaction, so open connections simply see the restored data."""
    import sqlite3
    # open the snapshot read-only: a bundled seed sits on a read-only filesystem
    src = sqlite3.connect(f"file:{_seed_file().as_posix()}?mode=ro&immutable=1", uri=True)
    dst = sqlite3.connect(db.engine.url.database, timeout=30)
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()
    db.engine.dispose()
    events.publish("reset", {})


# ------------------------------------------------------------------ loading
def load_kb() -> KnowledgeBase:
    with db.session() as s:
        items = [{"kind": i.kind, "key": i.key, "value": i.value, "meta": i.meta or {}, "active": i.active}
                 for i in s.query(db.KBItem).all()]
    return KnowledgeBase(items)


def load_settings() -> dict:
    with db.session() as s:
        row = s.get(db.Setting, "thresholds")
        return dict(DEFAULT_SETTINGS, **(row.value if row else {}))


def load_overrides() -> dict[str, dict]:
    with db.session() as s:
        return {c.email_id: c.overrides for c in s.query(db.Case).filter(db.Case.overrides.isnot(None)) if c.overrides}


def load_override(email_id: str) -> dict:
    with db.session() as s:
        c = s.get(db.Case, email_id)
        return dict(c.overrides or {}) if c else {}


def failed_ids() -> list[str]:
    with db.session() as s:
        return [c.email_id for c in s.query(db.Case).filter(db.Case.status == "FAILED")]


# ------------------------------------------------------------------ ingest
def _received_at(email_id: str, total: int) -> dt.datetime:
    """The dataset has no timestamps; give the inbox a stable, realistic timeline
    (newest = highest id, office hours, last ~2 weeks)."""
    n = int(re.sub(r"\D", "", email_id) or 0)
    base = dt.datetime(2026, 9, 18, 17, 30)
    back = total - n
    day, slot = divmod(back, 45)
    return base - dt.timedelta(days=day, minutes=slot * 11 + (n * 7) % 9)


def upsert_emails(emails: list[dict], source: str):
    with db.session() as s:
        total = max(len(emails), s.query(db.Email).count())
        for e in emails:
            row = s.get(db.Email, e["email_id"])
            if not row:
                row = db.Email(id=e["email_id"], received_at=_received_at(e["email_id"], total))
                s.add(row)
            row.sender, row.subject, row.body = e.get("from"), e.get("subject"), e.get("body")
            row.attachments, row.source = e.get("attachments") or [], source
            if not s.get(db.Case, e["email_id"]):
                s.add(db.Case(email_id=e["email_id"], status="PENDING", overrides={}))


# ------------------------------------------------------------------ runs
def start_run(total: int, note: str) -> int:
    with db.session() as s:
        run = db.Run(total=total, note=note)
        s.add(run)
        s.flush()
        events.publish("run", {"run_id": run.id, "state": "running", "done": 0, "total": total})
        return run.id


def finish_run(run_id: int, score: dict | None = None):
    with db.session() as s:
        run = s.get(db.Run, run_id)
        if run:
            run.finished_at, run.state = db.now(), "done"
            if score:
                run.score = score
            events.publish("run", {"run_id": run.id, "state": "done", "done": run.done, "total": run.total,
                                   "failed": run.failed})


# ------------------------------------------------------------------ results
def save_result(res: dict, run_id: int | None = None, done: int | None = None, failed: int | None = None):
    with db.session() as s:
        email = s.get(db.Email, res["email_id"])
        case = s.get(db.Case, res["email_id"]) or db.Case(email_id=res["email_id"], overrides={})
        s.add(case)
        ov = case.overrides or {}
        verdict = ov.get("verdict")
        if verdict and res["status"] != "FAILED":
            # a reviewer already decided this case; the AI result is kept for reference only
            res["ai_status"], res["ai_defect_fields"] = res["status"], res.get("defect_fields", [])
            res["status"] = verdict["status"]
            res["defect_fields"] = verdict.get("defect_fields", [])
            res["review_reason"] = verdict.get("review_reason")
            res["needs_human"] = False
            for fr in res.get("fields") or []:              # show the rows the way the person decided them
                decided = (ov.get("field_results") or {}).get(fr["field"])
                if decided and decided != fr.get("result"):
                    fr["ai_result"], fr["result"] = fr.get("result"), decided
        # a person pressed Confirm on exactly this answer: a re-check that comes back the same stays settled,
        # and one that comes back different goes to a person again
        confirmed = ov.get("confirmed") or {}
        agreed = (not verdict and res["status"] not in ("FAILED", "PENDING") and confirmed.get("status") == res["status"]
                  and confirmed.get("review_reason") == res.get("review_reason"))
        if agreed:
            res["needs_human"] = False
        elif ov.get("review_requested") and not verdict:
            res["needs_human"] = True                       # someone asked for a second look and nobody has answered yet
        case.category, case.category_confidence = res.get("category"), res.get("category_confidence") or 0
        case.status, case.review_reason = res["status"], res.get("review_reason")
        case.review_detail, case.defect_fields = res.get("review_detail"), res.get("defect_fields") or []
        asked = ov.get("review_requested")
        if asked and not verdict and not agreed and res["status"] in ("OK", "MISMATCH"):
            who = asked.get("by") if isinstance(asked, dict) else None
            case.review_detail = f"Sent to review by {who or 'a teammate'}: second opinion requested"
        case.confidence, case.needs_human = res.get("confidence") or 0, bool(res.get("needs_human"))
        case.carrier, case.customer, case.pod = res.get("carrier"), res.get("customer"), res.get("pod")
        case.refs, case.error, case.result = res.get("refs") or {}, res.get("error"), res
        case.processed_at = db.now()
        case.resolved = bool(verdict) or agreed or (case.resolved and not case.needs_human)
        if email:
            kb = KnowledgeBase([{"kind": i.kind, "key": i.key, "value": i.value, "meta": i.meta or {}, "active": i.active}
                                for i in s.query(db.KBItem).filter(db.KBItem.kind == "reply_rule")])
            draft = build_draft({"from": email.sender, "subject": email.subject, "body": email.body}, res, kb)
            edited = case.draft and case.ai_draft and case.draft != case.ai_draft
            case.ai_draft = draft
            if not edited:
                case.draft = draft
            s.flush()
            tagging.apply_tags(s, case, email)
        if run_id and done is not None:
            run = s.get(db.Run, run_id)
            if run:
                run.done, run.failed = done, failed or 0
        payload = {"email_id": case.email_id, "status": case.status, "category": case.category}
        if run_id and done is not None:
            payload.update(run_id=run_id, done=done)
    events.publish("case", payload)


def log_activity(s, email_id: str, user: str, action: str, detail: str = ""):
    s.add(db.Activity(email_id=email_id, user=user, action=action, detail=detail))
