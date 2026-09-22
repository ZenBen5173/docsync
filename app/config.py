"""Central configuration. Everything here can be overridden by env vars or,
for thresholds, live from the Admin screen (stored in the `settings` table)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# A local .env file (never shipped, never committed) can hold the AI key and settings. Real environment
# variables win. The hosted copy has no .env, so no visitor can ever spend the owner's AI budget.
_env = ROOT / ".env"
if _env.exists():
    for _line in _env.read_text(encoding="utf-8").splitlines():
        _line = _line.split(" #")[0].strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

# Serverless hosting (Vercel sets VERCEL=1). There is no permanent disk and no long-lived process: the
# database is a copy of a pre-seeded file in /tmp (per server instance, gone when the instance is recycled),
# full pipeline runs and live event streams are off, and the hosted copy shows pre-computed results.
SERVERLESS = os.environ.get("DOCCHECK_SERVERLESS", "1" if os.environ.get("VERCEL") else "") == "1"

VAR_DIR = Path(os.environ.get("DOCCHECK_VAR", "/tmp/doccheck" if SERVERLESS else ROOT / "var"))
VAR_DIR.mkdir(parents=True, exist_ok=True)
# A pre-seeded database shipped with a deployment (read-only). When the live database does not exist yet,
# it starts as a copy of this file; "Reset demo data" restores it.
BUNDLED_SEED = Path(os.environ.get("DOCCHECK_BUNDLED_SEED", ROOT / "deploy" / "seed.db"))

PRODUCT_NAME = os.environ.get("PRODUCT_NAME", "DocSync")
DB_URL = os.environ.get("DOCCHECK_DB", f"sqlite:///{(VAR_DIR / 'doccheck.db').as_posix()}")
DEFAULT_SOURCE = os.environ.get("DOCCHECK_SOURCE", str(ROOT / "data" / "bundle"))
SCORING_URL = os.environ.get("DOCCHECK_SCORING_URL", "http://localhost:8080")
LLM_CACHE_DIR = Path(os.environ.get("DOCCHECK_LLM_CACHE", VAR_DIR / "llm_cache"))
EVIDENCE_DIR = VAR_DIR / "evidence"
RUNS_DIR = ROOT / "runs"

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "").lower()      # anthropic | openai | ""
LLM_MODEL = os.environ.get("LLM_MODEL", "")
LLM_BUDGET_USD = float(os.environ.get("LLM_BUDGET_USD", "0") or 0)   # 0 = no cap; otherwise AI calls stop once this much was spent
LLM_API_KEY = (os.environ.get("LLM_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
               or os.environ.get("OPENAI_API_KEY") or "")

PIPELINE_CONCURRENCY = int(os.environ.get("PIPELINE_CONCURRENCY", "8"))

# Public demo mode (set on the hosted deployment). There is no login, so anything that could hurt the
# host or other visitors is switched off or slowed down: no scoring endpoint, no API docs, full
# pipeline runs are rate-limited, and "Reset demo data" restores the seeded database.
PUBLIC_DEMO = os.environ.get("DOCCHECK_PUBLIC_DEMO", "") == "1" or SERVERLESS
PIPELINE_MIN_INTERVAL_S = int(os.environ.get("PIPELINE_MIN_INTERVAL_S", "90" if PUBLIC_DEMO else "0"))
SEED_DB = VAR_DIR / "seed.db"
# Optional shared password for the whole site (HTTP Basic, any username). Empty = no gate.
DEMO_PASSWORD = os.environ.get("DOCCHECK_DEMO_PASSWORD", "")

FIELDS = ["shipper", "consignee", "notify_party", "port_of_loading",
          "port_of_discharge", "container_count", "gross_weight_kg"]
FIELD_LABELS = {
    "shipper": "Shipper", "consignee": "Consignee", "notify_party": "Notify party",
    "port_of_loading": "Port of loading", "port_of_discharge": "Port of discharge",
    "container_count": "Container count", "gross_weight_kg": "Gross weight (kg)",
}
CATEGORIES = ["BL_COMPARISON", "SI_REQUEST", "INVOICE_QUERY", "GENERAL", "SPAM"]
REVIEW_REASONS = ["wrong_doc_type", "missing_attachment", "unreadable", "missing_value"]

# Defaults for the Admin "Thresholds" tab. See DECISIONS.md for the reasoning.
DEFAULT_SETTINGS = {
    "classify_review_below": 0.55,     # category confidence under this -> human review flag
    "field_review_below": 0.60,        # any compared field under this -> unsure
    "field_thresholds": {},            # per-field override, e.g. {"consignee": 0.7}
    "doctype_thresholds": {"ocr": 0.99},  # extraction-method caps; OCR never auto-accepts by default
    "weight_tolerance_kg": 1.0,        # abs tolerance, rounding only
    "weight_tolerance_pct": 0.0,
    "party_fuzzy_match": 0.94,         # token-sort ratio treated as the same company (typo-level)
    "party_fuzzy_unsure": 0.85,        # between unsure and match -> "unsure" (review), below -> mismatch
    "ocr_auto_accept": False,          # scans are always escalated as `unreadable`
    "llm_enabled": True,
}
