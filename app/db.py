"""SQLite persistence (SQLAlchemy 2.0). JSON columns hold stage outputs so the
UI can show every stage's result, confidence and evidence."""
import datetime as dt
from contextlib import contextmanager

from sqlalchemy import (JSON, Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text,
                        create_engine, event)
from sqlalchemy.orm import declarative_base, sessionmaker

from app import config

def _start_from_bundled_seed():
    """No database yet, but the deployment ships a pre-seeded one: start as a copy of it. This is how a
    serverless instance (empty /tmp on every cold start) comes up with all emails already processed."""
    import shutil
    from pathlib import Path
    from sqlalchemy.engine import make_url
    url = make_url(config.DB_URL)
    if not url.drivername.startswith("sqlite") or not url.database:
        return
    live = Path(url.database)
    if not live.exists() and config.BUNDLED_SEED.exists():
        live.parent.mkdir(parents=True, exist_ok=True)
        tmp = live.with_suffix(".copying")
        shutil.copyfile(config.BUNDLED_SEED, tmp)
        tmp.replace(live)                   # atomic: a concurrent cold request never sees half a file


_start_from_bundled_seed()
engine = create_engine(config.DB_URL, connect_args={"check_same_thread": False, "timeout": 30})


@event.listens_for(engine, "connect")
def _sqlite_pragmas(conn, _):
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
Base = declarative_base()


def now():
    return dt.datetime.utcnow()


class Email(Base):
    __tablename__ = "emails"
    id = Column(String, primary_key=True)
    sender = Column(String, index=True)
    subject = Column(String)
    body = Column(Text)
    attachments = Column(JSON, default=list)
    received_at = Column(DateTime, index=True)
    is_read = Column(Boolean, default=False)
    starred = Column(Boolean, default=False)
    archived = Column(Boolean, default=False)
    source = Column(String)


class Case(Base):
    __tablename__ = "cases"
    email_id = Column(String, ForeignKey("emails.id"), primary_key=True)
    category = Column(String, index=True)
    category_confidence = Column(Float, default=0)
    status = Column(String, index=True, default="PENDING")   # OK | MISMATCH | NEEDS_REVIEW | FAILED | PENDING
    review_reason = Column(String)
    review_detail = Column(Text)
    defect_fields = Column(JSON, default=list)
    confidence = Column(Float, default=0)
    needs_human = Column(Boolean, default=False, index=True)
    resolved = Column(Boolean, default=False)
    resolved_by = Column(Integer)
    resolved_at = Column(DateTime)
    overrides = Column(JSON, default=dict)     # human decisions that survive re-runs
    carrier = Column(String, index=True)
    customer = Column(String, index=True)
    pod = Column(String)
    refs = Column(JSON, default=dict)
    result = Column(JSON, default=dict)        # full engine output (docs, fields, stages, classification)
    error = Column(Text)
    assignee_id = Column(Integer, ForeignKey("users.id"))
    ai_draft = Column(JSON)                    # {"subject","body"} as generated
    draft = Column(JSON)                       # current (possibly edited) draft
    processed_at = Column(DateTime)
    updated_at = Column(DateTime, default=now, onupdate=now)


class Label(Base):
    __tablename__ = "labels"
    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True)
    color = Column(String, default="#5f6368")
    kind = Column(String, default="custom")    # auto | custom
    group = Column(String)                     # carrier | customer | pod | None


class CaseLabel(Base):
    __tablename__ = "case_labels"
    email_id = Column(String, ForeignKey("cases.email_id"), primary_key=True)
    label_id = Column(Integer, ForeignKey("labels.id"), primary_key=True)
    source = Column(String, default="auto")    # auto | rule | manual


class Rule(Base):
    __tablename__ = "rules"
    id = Column(Integer, primary_key=True)
    name = Column(String)
    conditions = Column(JSON, default=list)    # [{"field":"carrier","op":"contains","value":"maersk"}]
    label_id = Column(Integer, ForeignKey("labels.id"))
    enabled = Column(Boolean, default=True)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String)
    email = Column(String)
    role = Column(String, default="reviewer")  # admin | reviewer | viewer
    color = Column(String, default="#1a73e8")
    active = Column(Boolean, default=True)


class Route(Base):
    __tablename__ = "routes"
    id = Column(Integer, primary_key=True)
    label_id = Column(Integer, ForeignKey("labels.id"))
    user_id = Column(Integer, ForeignKey("users.id"))
    backup_user_id = Column(Integer, ForeignKey("users.id"))
    priority = Column(Integer, default=0)


class Setting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True)
    value = Column(JSON)


class KBItem(Base):
    __tablename__ = "kb_items"
    id = Column(Integer, primary_key=True)
    kind = Column(String, index=True)
    key = Column(String)
    value = Column(Text)
    note = Column(Text)
    meta = Column(JSON, default=dict)
    source = Column(String, default="manual")  # seed | learned | manual
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=now)


class KBHistory(Base):
    __tablename__ = "kb_history"
    id = Column(Integer, primary_key=True)
    item_id = Column(Integer)
    action = Column(String)                    # add | edit | remove | restore
    before = Column(JSON)
    after = Column(JSON)
    user = Column(String)
    at = Column(DateTime, default=now)


class Correction(Base):
    __tablename__ = "corrections"
    id = Column(Integer, primary_key=True)
    email_id = Column(String, index=True)
    kind = Column(String)                      # field | verdict | category | draft
    field = Column(String)
    ai_value = Column(Text)
    final_value = Column(Text)
    context = Column(JSON, default=dict)
    user = Column(String)
    at = Column(DateTime, default=now)
    consumed = Column(Boolean, default=False)  # already fed into a learning report


class Suggestion(Base):
    __tablename__ = "suggestions"
    id = Column(Integer, primary_key=True)
    report_id = Column(Integer, index=True)
    kind = Column(String)                      # kb kind it would create
    payload = Column(JSON)                     # {"kind","key","value","note","meta"}
    title = Column(String)
    rationale = Column(Text)
    evidence_count = Column(Integer, default=1)
    evidence = Column(JSON, default=list)      # email ids
    status = Column(String, default="pending") # pending | approved | rejected
    created_at = Column(DateTime, default=now)
    decided_at = Column(DateTime)
    decided_by = Column(String)


class LearningReport(Base):
    __tablename__ = "learning_reports"
    id = Column(Integer, primary_key=True)
    created_at = Column(DateTime, default=now)
    summary = Column(Text)
    corrections = Column(Integer, default=0)
    engine = Column(String)                    # llm | heuristic


class Sent(Base):
    __tablename__ = "sent"
    id = Column(Integer, primary_key=True)
    email_id = Column(String, index=True)
    to = Column(String)
    subject = Column(String)
    body = Column(Text)
    user = Column(String)
    sent_at = Column(DateTime, default=now)


class Run(Base):
    __tablename__ = "runs"
    id = Column(Integer, primary_key=True)
    started_at = Column(DateTime, default=now)
    finished_at = Column(DateTime)
    note = Column(String)
    total = Column(Integer, default=0)
    done = Column(Integer, default=0)
    failed = Column(Integer, default=0)
    state = Column(String, default="running")  # running | done | error
    score = Column(JSON)


class AnalyticsReport(Base):
    __tablename__ = "analytics_reports"
    id = Column(Integer, primary_key=True)
    created_at = Column(DateTime, default=now)
    filters = Column(JSON)
    metrics = Column(JSON)
    summary = Column(Text)
    engine = Column(String)


class Activity(Base):
    __tablename__ = "activity"
    id = Column(Integer, primary_key=True)
    email_id = Column(String, index=True)
    user = Column(String)
    action = Column(String)
    detail = Column(Text)
    at = Column(DateTime, default=now)


def init_db():
    Base.metadata.create_all(engine)


@contextmanager
def session():
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()
