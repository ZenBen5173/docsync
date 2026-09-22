"""FastAPI backend: inbox, case detail, review actions, drafts, pipeline control,
live events (SSE), attachments and evidence. Admin/analytics live in admin.py."""
import asyncio
import base64
import copy
import re
import secrets
import threading
import time

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy import func, or_

from app import config, db, events, evidence, llm, store, tagging
from app.engine import process_email, to_submission
from app.extract.readers import read_document
from app.ingest.clean import clean_body
from app.ingest.inbox import Inbox

# No CORS middleware on purpose: the UI is served from this same origin (and through the Vite proxy in
# development), so no other website has any business calling this API from a visitor's browser.
app = FastAPI(title=f"{config.PRODUCT_NAME} API", docs_url=None if config.PUBLIC_DEMO else "/docs",
              redoc_url=None, openapi_url=None if config.PUBLIC_DEMO else "/openapi.json")


@app.middleware("http")
async def _gate(request: Request, call_next):
    """Optional shared-password gate (HTTP Basic, any username). OFF unless DOCCHECK_DEMO_PASSWORD is set on
    the server. Why it exists: the hosted demo shows our verdict for every email of a live competition's
    dataset - without a gate that is, in effect, a public answer key, and it republishes the organisers'
    emails. Every response also tells search engines not to index the site."""
    if config.DEMO_PASSWORD and request.url.path != "/healthz":
        scheme, _, b64 = request.headers.get("authorization", "").partition(" ")
        try:
            supplied = base64.b64decode(b64).decode("utf-8").partition(":")[2]
        except Exception:
            supplied = ""
        if scheme.lower() != "basic" or not secrets.compare_digest(supplied.encode(), config.DEMO_PASSWORD.encode()):
            return Response("Password required.", status_code=401,
                            headers={"WWW-Authenticate": f'Basic realm="{config.PRODUCT_NAME} demo", charset="UTF-8"'})
    resp = await call_next(request)
    resp.headers["X-Robots-Tag"] = "noindex, nofollow"
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/robots.txt")
def robots():
    return Response("User-agent: *\nDisallow: /\n", media_type="text/plain")


OTHER_CATS = ["SI_REQUEST", "INVOICE_QUERY", "GENERAL"]
INBOX_TABS = {
    "cases": lambda: [],
    "review": lambda: [db.Case.needs_human == True, db.Case.resolved == False],  # noqa: E712
    "mismatch": lambda: [db.Case.status == "MISMATCH"],
    "ok": lambda: [db.Case.status == "OK"],
}
CAT_SLUG = {"bl": "BL_COMPARISON", "si": "SI_REQUEST", "invoice": "INVOICE_QUERY", "general": "GENERAL", "spam": "SPAM"}
_pipeline_lock = threading.Lock()
_pipeline_state = {"running": False, "run_id": None, "done": 0, "total": 0, "error": None}


@app.on_event("startup")
def _startup():
    store.bootstrap()


def _user(request: Request) -> str:
    return request.headers.get("x-user", "system")


# ------------------------------------------------------------------ meta
@app.get("/api/meta")
def meta():
    with db.session() as s:
        users = [_user_json(u) for u in s.query(db.User).order_by(db.User.id)]
    return {"product": config.PRODUCT_NAME, "fields": config.FIELDS, "field_labels": config.FIELD_LABELS,
            "categories": config.CATEGORIES, "review_reasons": config.REVIEW_REASONS, "users": users,
            "llm": {"available": llm.available(), "provider": llm.provider(), "model": llm.model()},
            "demo": {"public": config.PUBLIC_DEMO, "reset_available": store.seed_available(),
                     "serverless": config.SERVERLESS}}


def _user_json(u: db.User):
    return {"id": u.id, "name": u.name, "email": u.email, "role": u.role, "color": u.color, "active": u.active}


# ------------------------------------------------------------------ search
TOKEN_RE = re.compile(r'(\w+):("[^"]+"|\S+)')


def _apply_query(s, q, text: str):
    """Gmail-style operators: from: label: status: category: carrier: customer: assignee: has: is:"""
    for key, val in TOKEN_RE.findall(text or ""):
        val = val.strip('"')
        key = key.lower()
        if key == "from":
            q = q.filter(db.Email.sender.ilike(f"%{val}%"))
        elif key == "label":
            sub = (s.query(db.CaseLabel.email_id).join(db.Label, db.Label.id == db.CaseLabel.label_id)
                   .filter(func.replace(func.lower(db.Label.name), " ", "-").like(f"%{val.lower().replace(' ', '-')}%")))
            q = q.filter(db.Case.email_id.in_(sub))
        elif key == "status":
            v = val.upper().replace("-", "_")
            v = {"REVIEW": "NEEDS_REVIEW", "NEEDS-REVIEW": "NEEDS_REVIEW"}.get(v, v)
            q = q.filter(db.Case.status == v)
        elif key == "category":
            q = q.filter(db.Case.category == CAT_SLUG.get(val.lower(), val.upper()))
        elif key == "carrier":
            q = q.filter(db.Case.carrier.ilike(f"%{val}%"))
        elif key == "customer":
            q = q.filter(db.Case.customer.ilike(f"%{val}%"))
        elif key == "assignee":
            sub = s.query(db.User.id).filter(db.User.name.ilike(f"%{val}%"))
            q = q.filter(db.Case.assignee_id.in_(sub))
        elif key == "has" and val.lower().startswith("attach"):
            q = q.filter(func.json_array_length(db.Email.attachments) > 0)
        elif key == "is":
            if val.lower() == "unread":
                q = q.filter(db.Email.is_read == False)  # noqa: E712
            elif val.lower() == "starred":
                q = q.filter(db.Email.starred == True)  # noqa: E712
        elif key == "field":
            q = q.filter(func.instr(func.json(db.Case.defect_fields), val.lower()) > 0)
    free = TOKEN_RE.sub("", text or "").strip()
    for word in free.split():
        like = f"%{word}%"
        q = q.filter(or_(db.Email.subject.ilike(like), db.Email.body.ilike(like), db.Email.sender.ilike(like),
                         db.Email.id.ilike(like)))
    return q


def _folder_filter(q, folder: str, user_id: int | None, tab: str | None = None):
    E, C = db.Email, db.Case
    if folder == "inbox":
        if tab == "spam":                       # the Inbox's own Spam tab: junk that has not been tidied away
            return q.filter(E.archived == False)  # noqa: E712
        return q.filter(E.archived == False, or_(C.category != "SPAM", C.category.is_(None)))  # noqa: E712
    if folder == "assigned":
        return q.filter(C.assignee_id == (user_id or -1), E.archived == False)  # noqa: E712
    if folder == "review":
        return q.filter(C.needs_human == True, C.resolved == False)  # noqa: E712
    if folder == "mismatch":
        return q.filter(C.status == "MISMATCH")
    if folder == "ok":
        return q.filter(C.status == "OK", C.category == "BL_COMPARISON")
    if folder == "failed":
        return q.filter(C.status == "FAILED")
    if folder == "spam":
        return q.filter(C.category == "SPAM")
    if folder == "other":
        return q.filter(C.category.in_(OTHER_CATS), E.archived == False)  # noqa: E712
    if folder == "starred":
        return q.filter(E.starred == True)  # noqa: E712
    if folder == "archived":
        return q.filter(E.archived == True)  # noqa: E712
    if folder in CAT_SLUG:
        return q.filter(C.category == CAT_SLUG[folder])
    return q  # all


def _row(case: db.Case, email: db.Email, labels: list[dict]) -> dict:
    body = clean_body(email.body or "")
    return {
        "id": email.id, "sender": email.sender, "subject": email.subject,
        "snippet": re.sub(r"\s+", " ", body.message)[:140], "received_at": email.received_at,
        "attachments": len(email.attachments or []), "is_read": email.is_read, "starred": email.starred,
        "archived": email.archived, "category": case.category, "status": case.status,
        "review_reason": case.review_reason, "confidence": case.confidence, "needs_human": case.needs_human,
        "resolved": case.resolved, "carrier": case.carrier, "customer": case.customer,
        "assignee_id": case.assignee_id, "defect_fields": case.defect_fields or [], "labels": labels,
        "error": case.error, "preview": (case.result or {}).get("preview"),
    }


@app.get("/api/cases")
def list_cases(folder: str = "inbox", tab: str | None = None, label: int | None = None, tags: str = "", q: str = "",
               page: int = 1, page_size: int = 50, user_id: int | None = None):
    page, page_size, q = max(1, page), min(max(1, page_size), 200), q[:300]
    with db.session() as s:
        if folder == "sent":
            sent = s.query(db.Sent).order_by(db.Sent.sent_at.desc()).all()
            return {"total": len(sent), "page": 1, "page_size": len(sent) or 1, "sent": True, "rows": [
                {"id": x.email_id, "sent_id": x.id, "sender": f"To: {x.to}", "subject": x.subject,
                 "snippet": re.sub(r"\s+", " ", x.body)[:140], "received_at": x.sent_at, "attachments": 0,
                 "is_read": True, "starred": False, "labels": [], "category": None, "status": "SENT",
                 "confidence": None, "assignee_id": None, "defect_fields": [], "user": x.user} for x in sent]}
        query = s.query(db.Case, db.Email).join(db.Email, db.Email.id == db.Case.email_id)
        query = _folder_filter(query, folder, user_id, tab)
        if tab in INBOX_TABS:                    # the Inbox tabs sort the document checks by how they turned out
            query = query.filter(db.Case.category == "BL_COMPARISON", *INBOX_TABS[tab]())
        elif tab == "other":
            query = query.filter(db.Case.category.in_(OTHER_CATS))
        elif tab == "spam":
            query = query.filter(db.Case.category == "SPAM")
        for tag_id in [int(t) for t in tags.split(",") if t.strip().isdigit()][:8]:      # filters: every chosen tag must be on the email
            query = query.filter(db.Case.email_id.in_(
                s.query(db.CaseLabel.email_id).filter(db.CaseLabel.label_id == tag_id)))
        if label:
            query = query.filter(db.Case.email_id.in_(
                s.query(db.CaseLabel.email_id).filter(db.CaseLabel.label_id == label)))
        query = _apply_query(s, query, q)
        total = query.count()
        items = (query.order_by(db.Email.received_at.desc(), db.Email.id.desc())
                 .offset((page - 1) * page_size).limit(page_size).all())
        ids = [c.email_id for c, _ in items]
        lab_map: dict[str, list] = {i: [] for i in ids}
        if ids:
            for cl, lab in (s.query(db.CaseLabel, db.Label).join(db.Label, db.Label.id == db.CaseLabel.label_id)
                            .filter(db.CaseLabel.email_id.in_(ids))):
                lab_map[cl.email_id].append({"id": lab.id, "name": lab.name, "color": lab.color, "group": lab.group})
        return {"total": total, "page": page, "page_size": page_size,
                "rows": [_row(c, e, lab_map[c.email_id]) for c, e in items]}


@app.get("/api/counts")
def counts(user_id: int | None = None):
    with db.session() as s:
        base = s.query(func.count()).select_from(db.Case).join(db.Email, db.Email.id == db.Case.email_id)

        def n(folder, unread_only=False):
            q = _folder_filter(base, folder, user_id)
            if unread_only:
                q = q.filter(db.Email.is_read == False)  # noqa: E712
            return q.scalar()
        folders = {f: n(f) for f in ["inbox", "assigned", "review", "mismatch", "ok", "failed", "all", "spam", "other",
                                     "bl", "si", "invoice", "general", "starred"]}
        folders["sent"] = s.query(func.count(db.Sent.id)).scalar()
        unread = {f: n(f, True) for f in ["inbox", "assigned"]}
        tabs = {}
        for t, cats in (("cases", ["BL_COMPARISON"]), ("other", OTHER_CATS), ("spam", ["SPAM"])):
            tabs[t] = (s.query(func.count()).select_from(db.Case).join(db.Email, db.Email.id == db.Case.email_id)
                       .filter(db.Case.category.in_(cats), db.Email.archived == False,  # noqa: E712
                               db.Email.is_read == False).scalar())  # noqa: E712
        for t, cond in INBOX_TABS.items():       # how many checks each Inbox tab holds
            tabs[t] = (s.query(func.count()).select_from(db.Case).join(db.Email, db.Email.id == db.Case.email_id)
                       .filter(db.Case.category == "BL_COMPARISON", db.Email.archived == False, *cond()).scalar())  # noqa: E712
        lab_counts = dict(s.query(db.CaseLabel.label_id, func.count()).group_by(db.CaseLabel.label_id).all())
        labels = [{"id": l.id, "name": l.name, "color": l.color, "kind": l.kind, "group": l.group,
                   "count": lab_counts.get(l.id, 0)} for l in s.query(db.Label).order_by(db.Label.name)]
        pending = s.query(func.count(db.Suggestion.id)).filter(db.Suggestion.status == "pending").scalar()
    return {"folders": folders, "unread": unread, "tabs": tabs, "labels": labels,
            "pending_suggestions": pending, "pipeline": _pipeline_state}


# ------------------------------------------------------------------ detail
@app.get("/api/cases/{email_id}")
def case_detail(email_id: str):
    with db.session() as s:
        email, case = s.get(db.Email, email_id), s.get(db.Case, email_id)
        if not email or not case:
            raise HTTPException(404, "case not found")
        labels = [{"id": lab.id, "name": lab.name, "color": lab.color, "group": lab.group, "source": cl.source}
                  for cl, lab in s.query(db.CaseLabel, db.Label).join(db.Label, db.Label.id == db.CaseLabel.label_id)
                  .filter(db.CaseLabel.email_id == email_id)]
        body = clean_body(email.body or "")
        sent = [{"id": x.id, "to": x.to, "subject": x.subject, "body": x.body, "user": x.user, "sent_at": x.sent_at}
                for x in s.query(db.Sent).filter(db.Sent.email_id == email_id).order_by(db.Sent.sent_at)]
        activity = [{"user": a.user, "action": a.action, "detail": a.detail, "at": a.at}
                    for a in s.query(db.Activity).filter(db.Activity.email_id == email_id).order_by(db.Activity.at.desc()).limit(30)]
        res = case.result or {}
        return {
            "id": email.id, "sender": email.sender, "subject": email.subject, "received_at": email.received_at,
            "body": {"message": body.message, "signature": body.signature, "quoted": body.quoted, "banner": body.banner,
                     "raw": email.body},
            "attachments": [{"path": p, "name": p.rsplit("/", 1)[-1]} for p in (email.attachments or [])],
            "is_read": email.is_read, "starred": email.starred, "archived": email.archived,
            "category": case.category, "category_confidence": case.category_confidence,
            "classification": res.get("classification"), "status": case.status, "review_reason": case.review_reason,
            "review_detail": case.review_detail, "defect_fields": case.defect_fields or [],
            "proposed_defect_fields": res.get("proposed_defect_fields") or [],
            "ai_status": res.get("ai_status"), "confidence": case.confidence, "needs_human": case.needs_human,
            "resolved": case.resolved, "resolved_by": case.resolved_by, "carrier": case.carrier,
            "customer": case.customer, "pod": case.pod, "refs": case.refs, "docs": res.get("docs") or [],
            "fields": res.get("fields") or [], "stages": res.get("stages") or {}, "error": case.error,
            "assignee_id": case.assignee_id, "labels": labels, "draft": case.draft, "ai_draft": case.ai_draft,
            "overrides": case.overrides or {}, "sent": sent, "activity": activity, "preview": (case.result or {}).get("preview"),
        }


def _case_or_404(s, email_id: str) -> db.Case:
    case = s.get(db.Case, email_id)
    if not case:
        raise HTTPException(404, "case not found")
    return case


def _inbox_for(s, email_id: str) -> Inbox:
    return Inbox(store.inbox_source())


def _find_attachment(s, email_id: str, name: str) -> tuple[str, bytes]:
    email = s.get(db.Email, email_id)
    if not email:
        raise HTTPException(404)
    for p in email.attachments or []:
        if p.rsplit("/", 1)[-1] == name:
            try:
                return p, _inbox_for(s, email_id).read_bytes(p)
            except Exception as e:
                raise HTTPException(404, f"attachment unavailable: {e}")
    raise HTTPException(404, "no such attachment")


MIME = {"pdf": "application/pdf", "txt": "text/plain; charset=utf-8",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


@app.get("/api/cases/{email_id}/attachments/{name}")
def attachment_raw(email_id: str, name: str):
    with db.session() as s:
        path, data = _find_attachment(s, email_id, name)
    ext = name.rsplit(".", 1)[-1].lower()
    return Response(data, media_type=MIME.get(ext, "application/octet-stream"),
                    headers={"Content-Disposition": f'inline; filename="{name}"'})


@app.get("/api/cases/{email_id}/attachments/{name}/preview")
def attachment_preview(email_id: str, name: str):
    """Format-neutral preview: the parsed rows (with locations) the pipeline saw."""
    with db.session() as s:
        path, data = _find_attachment(s, email_id, name)
    doc = read_document(path, data)
    return {"name": name, "format": doc.fmt, "readable": doc.readable, "error": doc.error, "method": doc.method,
            "pages": doc.meta.get("pages"), "sheets": doc.meta.get("sheets"),
            "rows": [{"text": r.text, "label": r.label, "value": r.value, "loc": r.loc, "indent": r.indent}
                     for r in doc.rows][:400]}


@app.get("/api/cases/{email_id}/attachments/{name}/page/{page_no}.png")
def attachment_page(email_id: str, name: str, page_no: int):
    with db.session() as s:
        path, data = _find_attachment(s, email_id, name)
    try:
        return Response(evidence.page_png(data, page_no), media_type="image/png")
    except Exception as e:
        raise HTTPException(422, f"cannot render: {e}")


@app.get("/api/cases/{email_id}/evidence/{side}/{field}.png")
def evidence_png(email_id: str, side: str, field: str):
    with db.session() as s:
        case = _case_or_404(s, email_id)
        if not case:
            raise HTTPException(404)
        fr = next((f for f in (case.result or {}).get("fields", []) if f["field"] == field), None)
        fv = (fr or {}).get(side.lower())
        if not fv or not fv.get("loc") or fv["loc"].get("kind") != "bbox":
            raise HTTPException(404, "no image evidence for this field")
        _, data = _find_attachment(s, email_id, fv["doc"])
    return Response(evidence.crop_png(data, fv["loc"], fv.get("format") or "pdf"), media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


# ------------------------------------------------------------------ flags / labels / assignment
@app.patch("/api/cases/{email_id}")
def patch_case(email_id: str, request: Request, payload: dict = Body(...)):
    with db.session() as s:
        email, case = s.get(db.Email, email_id), s.get(db.Case, email_id)
        if not email:
            raise HTTPException(404)
        for k in ("is_read", "starred", "archived"):
            if k in payload:
                setattr(email, k, bool(payload[k]))
        if "assignee_id" in payload:
            case.assignee_id = payload["assignee_id"]
            case.overrides = dict(case.overrides or {}, assignee_locked=payload["assignee_id"] is not None)
            who = s.get(db.User, payload["assignee_id"]).name if payload["assignee_id"] else "nobody"
            store.log_activity(s, email_id, _user(request), "assigned", f"to {who}")
    events.publish("case", {"email_id": email_id})
    return {"ok": True}


@app.post("/api/cases/bulk")
def bulk(request: Request, payload: dict = Body(...)):
    ids, action = payload.get("ids") or [], payload.get("action")
    with db.session() as s:
        for eid in ids:
            email, case = s.get(db.Email, eid), s.get(db.Case, eid)
            if not email:
                continue
            if action in ("archive", "unarchive"):
                email.archived = action == "archive"
            elif action in ("read", "unread"):
                email.is_read = action == "read"
            elif action in ("star", "unstar"):
                email.starred = action == "star"
            elif action == "assign":
                case.assignee_id = payload.get("user_id")
                case.overrides = dict(case.overrides or {}, assignee_locked=payload.get("user_id") is not None)
            elif action == "label":
                if not s.get(db.CaseLabel, (eid, payload["label_id"])):
                    s.add(db.CaseLabel(email_id=eid, label_id=payload["label_id"], source="manual"))
            elif action == "unlabel":
                cl = s.get(db.CaseLabel, (eid, payload["label_id"]))
                if cl:
                    s.delete(cl)
    if action == "retry" and ids:          # an empty selection must never turn into a full run
        _run_ids(ids, note="bulk retry")
    events.publish("bulk", {"ids": ids, "action": action})
    return {"ok": True, "count": len(ids)}


# ------------------------------------------------------------------ review actions
def _reprocess(email_id: str):
    with db.session() as s:
        email = s.get(db.Email, email_id)
        if not email:
            raise HTTPException(404, "case not found")
        inbox = _inbox_for(s, email_id)
        raw = {"email_id": email.id, "from": email.sender, "subject": email.subject, "body": email.body,
               "attachments": email.attachments or []}
        overrides = (_case_or_404(s, email_id).overrides or {})
    from app.preview import add_preview
    settings = store.load_settings()
    res = add_preview(process_email(raw, inbox, store.load_kb(), settings, overrides), raw, settings)
    store.save_result(res)
    return res


@app.post("/api/cases/{email_id}/confirm")
def confirm(email_id: str, request: Request, payload: dict = Body(default={})):
    """Reviewer accepts the result as shown (AI verdict, or the AI's proposal for a review case)."""
    with db.session() as s:
        case = _case_or_404(s, email_id)
        if not case:
            raise HTTPException(404)
        uid = payload.get("user_id")
        case.resolved, case.needs_human, case.resolved_by, case.resolved_at = True, False, uid, db.now()
        ov = copy.deepcopy(case.overrides or {})
        ov["confirmed"] = {"status": case.status, "review_reason": case.review_reason}
        ov.pop("review_requested", None)
        case.overrides = ov
        store.log_activity(s, email_id, _user(request), "confirmed", f"{case.status}")
    events.publish("case", {"email_id": email_id})
    return {"ok": True}


@app.post("/api/cases/{email_id}/correct")
def correct(email_id: str, request: Request, payload: dict = Body(...)):
    """payload: {category?, verdict?: {status, defect_fields, review_reason}, field_values?: {field: {si?, bl?}},
    field_results?: {field: "match"|"mismatch"}, user_id?}. Every change is logged as a correction (the learning loop's input)."""
    user = _user(request)
    with db.session() as s:
        case, email = s.get(db.Case, email_id), s.get(db.Email, email_id)
        if not case:
            raise HTTPException(404)
        ov = copy.deepcopy(case.overrides or {})
        res = case.result or {}
        by_field = {f["field"]: f for f in res.get("fields", [])}
        ctx_base = {"sender": email.sender, "status": case.status, "refs": case.refs,
                    "message": clean_body(email.body or "").message[:400]}
        if payload.get("category") and payload["category"] != case.category:
            s.add(db.Correction(email_id=email_id, kind="category", ai_value=case.category,
                                final_value=payload["category"], context=ctx_base, user=user))
            ov["category"] = payload["category"]
            ov.pop("verdict", None)
            store.log_activity(s, email_id, user, "category changed", f"{case.category} -> {payload['category']}")
        for f, sides in (payload.get("field_values") or {}).items():
            fv = dict((ov.get("field_values") or {}).get(f) or {})
            for side, val in sides.items():
                old = ((by_field.get(f) or {}).get(side) or {}).get("raw")
                if val is not None and val != old:
                    s.add(db.Correction(email_id=email_id, kind="field_value", field=f, ai_value=old, final_value=val,
                                        context=dict(ctx_base, side=side), user=user))
                    fv[side] = val
                    store.log_activity(s, email_id, user, "value corrected", f"{f} ({side.upper()}): {old!r} -> {val!r}")
            if fv:
                ov.setdefault("field_values", {})[f] = fv
        verdict = payload.get("verdict")
        field_results = payload.get("field_results") or {}
        if field_results and not verdict:
            # derive the verdict from per-field decisions
            merged = {**(ov.get("field_results") or {}), **field_results}
            ov["field_results"] = merged
            final = {f: (merged.get(f) or by_field.get(f, {}).get("result")) for f in config.FIELDS}
            defects = [f for f, r in final.items() if r == "mismatch"]
            verdict = {"status": "MISMATCH" if defects else "OK", "defect_fields": defects, "review_reason": None}
        for f, r in field_results.items():
            old = (by_field.get(f) or {}).get("result")
            if old != r:
                fr = by_field.get(f) or {}
                s.add(db.Correction(email_id=email_id, kind="field_result", field=f, ai_value=old, final_value=r,
                                    context=dict(ctx_base, si_value=(fr.get("si") or {}).get("raw"),
                                                 bl_value=(fr.get("bl") or {}).get("raw")), user=user))
        if verdict:
            old_v = {"status": case.status, "defect_fields": case.defect_fields}
            if (verdict.get("status"), sorted(verdict.get("defect_fields") or [])) != (case.status, sorted(case.defect_fields or [])):
                s.add(db.Correction(email_id=email_id, kind="verdict", ai_value=str(old_v),
                                    final_value=str({k: verdict.get(k) for k in ("status", "defect_fields")}),
                                    context=ctx_base, user=user))
                store.log_activity(s, email_id, user, "verdict changed", f"{case.status} -> {verdict['status']}")
            ov["verdict"] = {"status": verdict["status"], "defect_fields": verdict.get("defect_fields") or [],
                             "review_reason": verdict.get("review_reason") if verdict["status"] == "NEEDS_REVIEW" else None}
            ov.pop("review_requested", None)            # the second pair of eyes has answered
            ov.pop("confirmed", None)
            case.resolved_by, case.resolved_at = payload.get("user_id"), db.now()
        case.overrides = ov
        case.draft = None  # regenerate the reply for the corrected result
    _reprocess(email_id)
    return case_detail(email_id)


@app.post("/api/cases/{email_id}/send-to-review")
def send_to_review(email_id: str, request: Request, payload: dict = Body(default={})):
    with db.session() as s:
        case = _case_or_404(s, email_id)
        case.needs_human, case.resolved = True, False
        ov = copy.deepcopy(case.overrides or {})
        had_verdict = ov.pop("verdict", None) is not None
        ov.pop("field_results", None)
        ov.pop("confirmed", None)
        ov["review_requested"] = {"by": _user(request)}       # who asked survives every later re-check
        case.overrides = ov
        if payload.get("note"):
            case.review_detail = f"Sent to review by {_user(request)}: {payload['note']}"
        if had_verdict:
            case.draft = None
        store.log_activity(s, email_id, _user(request), "sent to review", payload.get("note", ""))
    if had_verdict:
        _reprocess(email_id)
    events.publish("case", {"email_id": email_id})
    return {"ok": True}


@app.post("/api/cases/{email_id}/reset")
def reset_overrides(email_id: str, request: Request):
    with db.session() as s:
        case = _case_or_404(s, email_id)
        case.overrides, case.resolved, case.draft = {}, False, None
        store.log_activity(s, email_id, _user(request), "reset to AI result", "")
    _reprocess(email_id)
    return case_detail(email_id)


@app.post("/api/cases/{email_id}/retry")
def retry(email_id: str, request: Request, payload: dict = Body(default={})):
    with db.session() as s:
        _case_or_404(s, email_id)
        store.log_activity(s, email_id, _user(request), "retry", str(payload.get("stage") or "all stages")[:40])
    res = _reprocess(email_id)
    return {"ok": res["status"] != "FAILED", "status": res["status"], "error": res.get("error"), "stages": res["stages"]}


# ------------------------------------------------------------------ drafts / sent
@app.put("/api/cases/{email_id}/draft")
def save_draft(email_id: str, payload: dict = Body(...)):
    with db.session() as s:
        case = _case_or_404(s, email_id)
        case.draft = {"to": payload.get("to"), "subject": payload.get("subject"), "body": payload.get("body")}
    return {"ok": True}


@app.post("/api/cases/{email_id}/send")
def send(email_id: str, request: Request, payload: dict = Body(...)):
    """Simulated send: stored in Sent. The AI-vs-final diff feeds the learning loop."""
    user = _user(request)
    with db.session() as s:
        case = _case_or_404(s, email_id)
        ai = (case.ai_draft or {}).get("body", "")
        final = payload.get("body", "")
        if ai.strip() != final.strip():
            s.add(db.Correction(email_id=email_id, kind="draft", ai_value=ai, final_value=final, user=user,
                                context={"status": case.status, "refs": case.refs}))
        sent = db.Sent(email_id=email_id, to=payload.get("to"), subject=payload.get("subject"), body=final, user=user)
        s.add(sent)
        case.draft = {"to": payload.get("to"), "subject": payload.get("subject"), "body": final}
        if not case.needs_human:
            case.resolved = True
        store.log_activity(s, email_id, user, "reply sent", payload.get("subject", ""))
        s.flush()
        sid = sent.id
    events.publish("sent", {"email_id": email_id, "sent_id": sid})
    return {"ok": True, "sent_id": sid}


@app.delete("/api/sent/{sent_id}")
def unsend(sent_id: int):
    with db.session() as s:
        x = s.get(db.Sent, sent_id)
        if x:
            s.delete(x)
    events.publish("sent", {"sent_id": sent_id, "undone": True})
    return {"ok": True}


# ------------------------------------------------------------------ pipeline control
_last_full_run = 0.0


def _run_ids(ids: list[str] | None, note: str):
    """The inbox source is ALWAYS the server's own configuration. A caller-supplied source would let
    any visitor point the server at an internal URL or a local folder (SSRF / arbitrary read)."""
    global _last_full_run
    from app.pipeline import run_batch, write_outputs
    heavy = not ids or len(ids) > 25            # a full run, or a "retry" of most of the inbox
    if config.SERVERLESS:
        # No long-lived process here: a background thread is frozen as soon as the response is sent. Small
        # retries run inside the request instead; the full inbox is shipped pre-computed.
        if heavy:
            raise HTTPException(409, "This hosted copy shows pre-computed results - a full pipeline run needs the "
                                     "local app (python run.py). Retrying a few selected emails works here.")
        from app.pipeline import run_batch
        run_batch(store.inbox_source(), persist=True, only_ids=ids, note=note)
        return
    if heavy and config.PIPELINE_MIN_INTERVAL_S:
        wait = config.PIPELINE_MIN_INTERVAL_S - (time.monotonic() - _last_full_run)
        if _last_full_run and wait > 0:
            raise HTTPException(429, f"The pipeline just ran. On the public demo a large run is allowed every "
                                     f"{config.PIPELINE_MIN_INTERVAL_S} s - try again in {int(wait) + 1} s.")
    if not _pipeline_lock.acquire(blocking=False):
        raise HTTPException(409, "pipeline is already running")
    if heavy:
        _last_full_run = time.monotonic()

    def work():
        try:
            _pipeline_state.update(running=True, done=0, total=len(ids) if ids else 0, error=None)
            src = store.inbox_source()

            def progress(n, total, res):
                _pipeline_state.update(done=n, total=total)
            out = run_batch(src, persist=True, only_ids=ids, progress=progress, note=note)
            if not ids and not config.PUBLIC_DEMO:
                write_outputs(out, config.ROOT / "submission.json")
        except Exception as e:
            _pipeline_state["error"] = f"{type(e).__name__}: {e}"
            events.publish("run", {"state": "error", "error": _pipeline_state["error"]})
        finally:
            global _last_full_run
            if heavy:
                _last_full_run = time.monotonic()      # the cool-down counts from the END of a run
            _pipeline_state["running"] = False
            _pipeline_lock.release()
    threading.Thread(target=work, daemon=True).start()


@app.post("/api/pipeline/run")
def pipeline_run(payload: dict = Body(default={})):
    ids = payload.get("ids")
    if payload.get("failed"):
        ids = store.failed_ids()
        if not ids:
            return {"ok": True, "started": False, "message": "no failed cases"}
    if ids is not None and (not isinstance(ids, list) or len(ids) > 1000 or not all(isinstance(i, str) for i in ids)):
        raise HTTPException(422, "ids must be a list of email ids")
    _run_ids(ids, str(payload.get("note") or ("retry" if ids else "run from UI"))[:200])
    return {"ok": True, "started": True}


@app.get("/api/pipeline/status")
def pipeline_status():
    with db.session() as s:
        runs = [{"id": r.id, "started_at": r.started_at, "finished_at": r.finished_at, "note": r.note, "total": r.total,
                 "done": r.done, "failed": r.failed, "state": r.state, "score": r.score}
                for r in s.query(db.Run).order_by(db.Run.id.desc()).limit(10)]
    return {"state": _pipeline_state, "runs": runs}


@app.post("/api/pipeline/score")
def pipeline_score(payload: dict = Body(default={})):
    """Export submission.json from the current database state and POST it to the scorer.
    The scorer address is server configuration (DOCCHECK_SCORING_URL), never a request parameter: a
    caller-supplied URL would make the server POST the whole submission to any host (SSRF / exfiltration)."""
    if config.PUBLIC_DEMO:
        raise HTTPException(404, "scoring is not available on the public demo")
    from app.pipeline import submit_and_log
    with db.session() as s:
        sub = {c.email_id: to_submission(dict(c.result or {}, status=c.status, category=c.category,
                                              review_reason=c.review_reason, defect_fields=c.defect_fields or []))
               for c in s.query(db.Case)}
    import json
    (config.ROOT / "submission.json").write_text(json.dumps(sub, indent=2), encoding="utf-8")
    board = submit_and_log(sub, str(payload.get("note") or "scored from UI")[:200])
    if not board:
        raise HTTPException(502, "the scoring server configured in DOCCHECK_SCORING_URL is not reachable")
    return {"final_score": board["final_score"], "stage1": board["stage1"]["macro_f1"],
            "stage3": board["stage3"]["defect_f1"], "end_to_end": board["end_to_end"],
            "reliability": board["reliability"]}


@app.get("/api/events")
async def sse(request: Request):
    if config.SERVERLESS:
        # a stream would hold a function invocation open per browser tab, and events published by another
        # instance would never arrive anyway; the UI refetches after its own actions instead
        raise HTTPException(404, "live events are not available on the serverless deployment")
    q = events.subscribe()

    async def gen():
        try:
            yield "retry: 2000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            events.unsubscribe(q)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


from app.api import admin  # noqa: E402,F401  (registers the admin / analytics routes)

# ------------------------------------------------------------------ static frontend (production build)
_DIST = config.ROOT / "web" / "dist"
if _DIST.exists():
    from fastapi.staticfiles import StaticFiles
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    _DIST_ROOT = _DIST.resolve()

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404, "no such API route")       # never answer an API typo with index.html
        # The path comes straight from the URL: resolve it and serve it only if it is still INSIDE web/dist.
        # Without this, GET /../../var/doccheck.db (sent with --path-as-is) would read any file on the server.
        try:
            f = (_DIST_ROOT / full_path).resolve()
        except (OSError, ValueError):
            f = None
        if full_path and f is not None and f.is_relative_to(_DIST_ROOT) and f.is_file():
            return FileResponse(f)
        return FileResponse(_DIST_ROOT / "index.html")
