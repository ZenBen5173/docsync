"""Admin centre + analytics routes: labels & rules, routing, team, thresholds,
knowledge base (with history), learning report, analytics."""
from fastapi import Body, HTTPException, Request
from fastapi.responses import PlainTextResponse

from app import analytics, config, db, events, learning, store, tagging
from app.api.main import _user, _user_json, app
from app.config import DEFAULT_SETTINGS
from app.safe_regex import check_user_regex


# ------------------------------------------------------------------ demo reset
@app.post("/api/demo/reset")
def demo_reset(request: Request):
    """Back to the seeded state: every correction, sent reply, rule, label, threshold and KB change is undone.
    On a public demo anyone can change anything, so anyone can also put it back."""
    from app.api.main import _pipeline_state
    if not store.seed_available():
        raise HTTPException(404, "no seed snapshot on this server")
    if _pipeline_state["running"]:
        raise HTTPException(409, "the pipeline is running - reset once it has finished")
    store.restore_seed()
    return {"ok": True}


def _retag():
    with db.session() as s:
        n = tagging.retag_all(s)
    events.publish("retag", {"cases": n})
    return n


# ------------------------------------------------------------------ labels
@app.post("/api/labels")
def create_label(payload: dict = Body(...)):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(422, "name is required")
    with db.session() as s:
        if s.query(db.Label).filter(db.Label.name == name).first():
            raise HTTPException(409, "a label with this name already exists")
        lab = db.Label(name=name, color=payload.get("color") or tagging._color(name), kind="custom")
        s.add(lab)
        s.flush()
        out = {"id": lab.id, "name": lab.name, "color": lab.color, "kind": lab.kind}
    events.publish("labels", {})
    return out


@app.put("/api/labels/{label_id}")
def update_label(label_id: int, payload: dict = Body(...)):
    with db.session() as s:
        lab = s.get(db.Label, label_id)
        if not lab:
            raise HTTPException(404)
        lab.name = payload.get("name", lab.name)
        lab.color = payload.get("color", lab.color)
    events.publish("labels", {})
    return {"ok": True}


@app.delete("/api/labels/{label_id}")
def delete_label(label_id: int):
    with db.session() as s:
        s.query(db.CaseLabel).filter(db.CaseLabel.label_id == label_id).delete()
        s.query(db.Rule).filter(db.Rule.label_id == label_id).delete()
        s.query(db.Route).filter(db.Route.label_id == label_id).delete()
        lab = s.get(db.Label, label_id)
        if lab:
            s.delete(lab)
    events.publish("labels", {})
    return {"ok": True}


# ------------------------------------------------------------------ rules
@app.get("/api/rules")
def list_rules():
    with db.session() as s:
        return [{"id": r.id, "name": r.name, "conditions": r.conditions, "label_id": r.label_id, "enabled": r.enabled}
                for r in s.query(db.Rule).order_by(db.Rule.id)]


@app.post("/api/rules")
def save_rule(payload: dict = Body(...)):
    conditions = payload.get("conditions") or []
    if not isinstance(conditions, list) or len(conditions) > 8:
        raise HTTPException(422, "a rule takes at most 8 conditions")
    for c in conditions:
        if not isinstance(c, dict) or len(str(c.get("value", ""))) > 200:
            raise HTTPException(422, "condition values are limited to 200 characters")
        if c.get("op") == "regex":
            problem = check_user_regex(str(c.get("value", "")))
            if problem:
                raise HTTPException(422, f"Regex not accepted: {problem}")
    with db.session() as s:
        r = s.get(db.Rule, payload["id"]) if payload.get("id") else db.Rule()
        r.name, r.conditions = payload.get("name") or "Untitled rule", payload.get("conditions") or []
        r.label_id, r.enabled = payload.get("label_id"), payload.get("enabled", True)
        s.add(r)
    return {"ok": True, "retagged": _retag()}


@app.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: int):
    with db.session() as s:
        r = s.get(db.Rule, rule_id)
        if r:
            s.delete(r)
    return {"ok": True, "retagged": _retag()}


# ------------------------------------------------------------------ routing
@app.get("/api/routes")
def list_routes():
    with db.session() as s:
        return [{"id": r.id, "label_id": r.label_id, "user_id": r.user_id, "backup_user_id": r.backup_user_id,
                 "priority": r.priority} for r in s.query(db.Route).order_by(db.Route.priority.desc(), db.Route.id)]


@app.post("/api/routes")
def save_route(payload: dict = Body(...)):
    with db.session() as s:
        r = s.get(db.Route, payload["id"]) if payload.get("id") else db.Route()
        r.label_id, r.user_id = payload.get("label_id"), payload.get("user_id")
        r.backup_user_id, r.priority = payload.get("backup_user_id"), payload.get("priority") or 0
        s.add(r)
    return {"ok": True, "retagged": _retag()}


@app.delete("/api/routes/{route_id}")
def delete_route(route_id: int):
    with db.session() as s:
        r = s.get(db.Route, route_id)
        if r:
            s.delete(r)
    return {"ok": True, "retagged": _retag()}


# ------------------------------------------------------------------ team
@app.get("/api/users")
def list_users():
    with db.session() as s:
        return [_user_json(u) for u in s.query(db.User).order_by(db.User.id)]


@app.post("/api/users")
def save_user(payload: dict = Body(...)):
    with db.session() as s:
        u = s.get(db.User, payload["id"]) if payload.get("id") else db.User()
        was_active = u.active
        new_role = payload.get("role") or u.role or "reviewer"
        new_active = bool(payload.get("active", True if u.active is None else u.active))
        if new_role not in ("admin", "reviewer", "viewer"):
            raise HTTPException(422, "unknown role")
        # never let the last active admin be demoted or deactivated: on a shared demo that would lock
        # every visitor out of the admin centre with no way back
        if u.id and u.role == "admin" and u.active and (new_role != "admin" or not new_active):
            others = s.query(db.User).filter(db.User.role == "admin", db.User.active == True,  # noqa: E712
                                             db.User.id != u.id).count()
            if not others:
                raise HTTPException(409, "At least one active admin is required - make someone else an admin first.")
        if s.query(db.User).count() >= 50 and not u.id:
            raise HTTPException(409, "team size limit reached")
        u.name = str(payload.get("name") or u.name or "New teammate")[:80]
        u.email = str(payload.get("email", u.email) or "")[:120]
        u.role, u.color = new_role, str(payload.get("color") or u.color or "#1a73e8")[:9]
        u.active = new_active
        s.add(u)
        changed = was_active != u.active
    if changed:
        _retag()   # an inactive person's queue moves to their backup
    return {"ok": True}


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int):
    with db.session() as s:
        u = s.get(db.User, user_id)
        if u and u.role == "admin" and u.active and not s.query(db.User).filter(
                db.User.role == "admin", db.User.active == True, db.User.id != u.id).count():  # noqa: E712
            raise HTTPException(409, "At least one active admin is required.")
        if u:
            u.active = False
    _retag()
    return {"ok": True}


# ------------------------------------------------------------------ thresholds
@app.get("/api/settings")
def get_settings():
    return {"values": store.load_settings(), "defaults": DEFAULT_SETTINGS}


def _clean_settings(payload: dict) -> dict:
    """Only known keys, only sane values - this endpoint is reachable by anyone on the public demo."""
    out: dict = {}
    for key, default in DEFAULT_SETTINGS.items():
        if key not in payload:
            continue
        val = payload[key]
        if isinstance(default, bool):
            out[key] = bool(val)
        elif isinstance(default, (int, float)):
            if not isinstance(val, (int, float)) or isinstance(val, bool):
                raise HTTPException(422, f"{key} must be a number")
            hi = 1000.0 if key == "weight_tolerance_kg" else 100.0 if key == "weight_tolerance_pct" else 1.0
            out[key] = min(max(float(val), 0.0), hi)
        elif isinstance(default, dict):
            if not isinstance(val, dict):
                raise HTTPException(422, f"{key} must be an object")
            allowed = set(config.FIELDS) if key == "field_thresholds" else {"ocr", "llm", "text"}
            out[key] = {k: min(max(float(v), 0.0), 1.0) for k, v in val.items()
                        if k in allowed and isinstance(v, (int, float)) and not isinstance(v, bool)}
    return out


@app.put("/api/settings")
def put_settings(payload: dict = Body(...)):
    with db.session() as s:
        row = s.get(db.Setting, "thresholds")
        # {**a, **b} on purpose: dict(a, **b, **c) raises TypeError as soon as b and c share a key
        merged = {**DEFAULT_SETTINGS, **(row.value if row else {}), **_clean_settings(payload)}
        if row:
            row.value = merged
        else:
            s.add(db.Setting(key="thresholds", value=merged))
    return {"ok": True, "values": merged, "note": "applies to the next run / retry"}


# ------------------------------------------------------------------ knowledge base
def _kb_json(i: db.KBItem):
    return {"id": i.id, "kind": i.kind, "key": i.key, "value": i.value, "note": i.note, "meta": i.meta or {},
            "source": i.source, "active": i.active, "created_at": i.created_at}


@app.get("/api/kb")
def kb_list():
    with db.session() as s:
        return {"items": [_kb_json(i) for i in s.query(db.KBItem).order_by(db.KBItem.kind, db.KBItem.key)],
                "history": [{"id": h.id, "item_id": h.item_id, "action": h.action, "before": h.before, "after": h.after,
                             "user": h.user, "at": h.at} for h in s.query(db.KBHistory).order_by(db.KBHistory.id.desc()).limit(60)]}


@app.post("/api/kb")
def kb_save(request: Request, payload: dict = Body(...)):
    with db.session() as s:
        item = s.get(db.KBItem, payload["id"]) if payload.get("id") else None
        before = _kb_json(item) if item else None
        if not item:
            item = db.KBItem(source="manual")
        item.kind, item.key = payload.get("kind") or item.kind, (payload.get("key") or "").strip()
        item.value, item.note = (payload.get("value") or "").strip(), payload.get("note")
        item.meta, item.active = payload.get("meta") or item.meta or {}, payload.get("active", True)
        if not item.kind or not item.key:
            raise HTTPException(422, "kind and key are required")
        if len(item.key) > 300 or len(item.value) > 600:
            raise HTTPException(422, "knowledge-base entries are limited to 300 / 600 characters")
        if item.kind == "classifier_hint":
            problem = check_user_regex(item.key)
            if problem:
                raise HTTPException(422, f"Regex not accepted: {problem}")
        s.add(item)
        s.flush()
        after = _kb_json(item)
        for d in (before, after):
            if d:
                d.pop("created_at", None)
        s.add(db.KBHistory(item_id=item.id, action="edit" if before else "add", before=before, after=after,
                           user=_user(request)))
    return {"ok": True, "item": after}


@app.delete("/api/kb/{item_id}")
def kb_delete(item_id: int, request: Request):
    with db.session() as s:
        item = s.get(db.KBItem, item_id)
        if item:
            before = _kb_json(item)
            before.pop("created_at", None)
            s.add(db.KBHistory(item_id=item.id, action="remove", before=before, after=None, user=_user(request)))
            s.delete(item)
    return {"ok": True}


# ------------------------------------------------------------------ learning report
@app.get("/api/learning")
def learning_list():
    with db.session() as s:
        reports = [{"id": r.id, "created_at": r.created_at, "summary": r.summary, "corrections": r.corrections,
                    "engine": r.engine} for r in s.query(db.LearningReport).order_by(db.LearningReport.id.desc()).limit(15)]
        sugg = [{"id": g.id, "report_id": g.report_id, "kind": g.kind, "payload": g.payload, "title": g.title,
                 "rationale": g.rationale, "evidence_count": g.evidence_count, "evidence": g.evidence,
                 "status": g.status, "created_at": g.created_at, "decided_by": g.decided_by}
                for g in s.query(db.Suggestion).order_by(db.Suggestion.id.desc()).limit(100)]
        open_corr = s.query(db.Correction).filter(db.Correction.consumed == False).count()  # noqa: E712
        recent = [{"id": c.id, "email_id": c.email_id, "kind": c.kind, "field": c.field,
                   "ai_value": (c.ai_value or "")[:300], "final_value": (c.final_value or "")[:300],
                   "user": c.user, "at": c.at, "consumed": c.consumed}
                  for c in s.query(db.Correction).order_by(db.Correction.id.desc()).limit(40)]
    return {"reports": reports, "suggestions": sugg, "unprocessed_corrections": open_corr, "corrections": recent}


@app.post("/api/learning/generate")
def learning_generate(payload: dict = Body(default={})):
    out = learning.generate_report(include_consumed=bool(payload.get("include_consumed")))
    events.publish("learning", out)
    return out


@app.post("/api/learning/suggestions/{sid}/{decision}")
def learning_decide(sid: int, decision: str, request: Request):
    if decision not in ("approve", "reject"):
        raise HTTPException(422)
    out = learning.decide(sid, decision == "approve", _user(request))
    if not out.get("ok"):
        raise HTTPException(409, out.get("error"))
    events.publish("learning", {})
    return out


# ------------------------------------------------------------------ analytics
@app.get("/api/analytics/options")
def analytics_options():
    with db.session() as s:
        carriers = sorted({c for (c,) in s.query(db.Case.carrier).distinct() if c})
        customers = sorted({c for (c,) in s.query(db.Case.customer).distinct() if c})
        labels = [l.name for l in s.query(db.Label).order_by(db.Label.name)]
        dates = s.query(db.Email.received_at).order_by(db.Email.received_at).all()
        last = s.query(db.AnalyticsReport).order_by(db.AnalyticsReport.id.desc()).first()
        last_json = {"id": last.id, "created_at": last.created_at, "metrics": last.metrics, "summary": last.summary,
                     "engine": last.engine} if last else None
    return {"carriers": carriers, "customers": customers, "labels": labels,
            "date_min": dates[0][0] if dates else None, "date_max": dates[-1][0] if dates else None, "last": last_json}


@app.post("/api/analytics/analyze")
def analytics_analyze(payload: dict = Body(default={})):
    return analytics.analyze(payload.get("filters") or {})


@app.get("/api/analytics/{report_id}/export.md", response_class=PlainTextResponse)
def analytics_export(report_id: int):
    with db.session() as s:
        r = s.get(db.AnalyticsReport, report_id)
        if not r:
            raise HTTPException(404)
        rep = {"created_at": r.created_at, "metrics": r.metrics, "summary": r.summary}
    return PlainTextResponse(analytics.to_markdown(rep, config.PRODUCT_NAME), media_type="text/markdown",
                             headers={"Content-Disposition": f'attachment; filename="analytics-{report_id}.md"'})
