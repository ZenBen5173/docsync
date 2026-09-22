#!/usr/bin/env python3
"""Assemble a clean folder to deploy to Vercel:  dist-vercel/

    python deploy/build_vercel.py          then:  vercel deploy dist-vercel --archive=tgz  [--prod]

Why a staging folder instead of deploying the project root: only what the hosted copy needs goes up
(app/, the BUILT UI, the participant bundle, a pre-seeded database) - never the organisers' scoring
package, the zips, .venv, or the UI sources.

What Vercel can and cannot do with this app (serverless: no permanent disk, no long-lived process):
  + browse the inbox, search, labels, open cases, SI-vs-BL evidence, drafted replies, analytics
  + corrections / send / labels work, but live in a per-instance copy of the database in /tmp and
    can disappear; "Reset demo data" and every cold start go back to the seeded state
  - no live full pipeline run (the inbox ships pre-computed), no live event stream, no OCR libraries
    (too large for the 250 MB function limit; OCR results computed here are already in the seed)
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist-vercel"
WEB = ROOT / "web"
VENV_PY = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
PY = str(VENV_PY) if VENV_PY.exists() else sys.executable
NPM = shutil.which("npm") or "npm"

# runtime dependencies only: no uvicorn (Vercel runs the ASGI app itself), no OCR stack
KEEP = ("fastapi", "httpx", "openpyxl", "pymupdf", "python-docx", "rapidfuzz", "regex", "sqlalchemy")

VERCEL_JSON = {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "framework": None,
    "buildCommand": "",
    "outputDirectory": "public",
    "functions": {"api/index.py": {"maxDuration": 60, "excludeFiles": "public/**"}},
    "rewrites": [
        {"source": "/api/(.*)", "destination": "/api/index"},
        {"source": "/healthz", "destination": "/api/index"},
        # single-page app: every other path that is not a real file is the UI
        {"source": "/((?!api/|assets/).*)", "destination": "/index.html"},
    ],
    "headers": [{"source": "/(.*)", "headers": [{"key": "X-Robots-Tag", "value": "noindex, nofollow"}]}],
}

INDEX_PY = '''"""Vercel entrypoint: the same FastAPI app that runs locally (see app/api/main.py)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DOCCHECK_SERVERLESS", "1")

from app import store  # noqa: E402
from app.api.main import app  # noqa: E402,F401

store.bootstrap()   # serverless runtimes do not always send ASGI lifespan events
'''


def sh(cmd, **kw):
    print(">", " ".join(map(str, cmd)))
    subprocess.run(cmd, check=True, **kw)


def main():
    # 1) the UI
    if not (WEB / "node_modules").exists():
        sh([NPM, "ci"], cwd=WEB, shell=os.name == "nt")
    sh([NPM, "run", "build"], cwd=WEB, shell=os.name == "nt")

    # 2) a freshly seeded database (run here, where OCR is available), stored as ONE self-contained file
    with tempfile.TemporaryDirectory() as tmp:
        var = Path(tmp) / "var"
        env = dict(os.environ, PYTHONIOENCODING="utf-8", DOCCHECK_VAR=str(var), DOCCHECK_SERVERLESS="0",
                   DOCCHECK_DB=f"sqlite:///{(var / 'doccheck.db').as_posix()}", DOCCHECK_SOURCE="data/bundle",
                   DOCCHECK_BUNDLED_SEED=str(Path(tmp) / "none.db"),
                   DOCCHECK_LLM_CACHE=str(ROOT / "var" / "llm_cache"))      # AI answers already paid for are reused, not bought again
        sh([PY, "-m", "app.pipeline", "run", "--source", "data/bundle", "--note", "hosted seed",
            "--out", str(Path(tmp) / "submission.json")], cwd=ROOT, env=env)
        seed = Path(tmp) / "seed.db"
        src, dst = sqlite3.connect(var / "doccheck.db"), sqlite3.connect(seed)
        with dst:
            src.backup(dst)
        src.close()
        dst.execute("PRAGMA journal_mode=DELETE")      # no -wal/-shm side files: it ships on a read-only disk
        dst.execute("VACUUM")
        n = dst.execute("select count(*) from cases where status != 'PENDING'").fetchone()[0]
        dst.close()
        assert n >= 1, "the seed database is empty"

        # 3) assemble (keep dist-vercel/.vercel: it links the folder to the Vercel project)
        OUT.mkdir(exist_ok=True)
        for child in OUT.iterdir():
            if child.name != ".vercel":
                shutil.rmtree(child) if child.is_dir() else child.unlink()
        shutil.copytree(ROOT / "app", OUT / "app", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copytree(ROOT / "data" / "bundle", OUT / "data" / "bundle")
        (OUT / "deploy").mkdir()
        shutil.copyfile(seed, OUT / "deploy" / "seed.db")
        # what OCR read from every scan, so the hosted copy (no OCR engine) can re-check a scanned email
        if (var / "ocr_cache").exists():
            shutil.copytree(var / "ocr_cache", OUT / "deploy" / "ocr_cache")
        shutil.copytree(WEB / "dist", OUT / "public")

    (OUT / "public" / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (OUT / "api").mkdir()
    (OUT / "api" / "index.py").write_text(INDEX_PY, encoding="utf-8")
    pins = [ln.strip() for ln in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.startswith("#") and ln.split("==")[0].strip().lower() in KEEP]
    assert len(pins) == len(KEEP), f"requirements.txt is missing one of {KEEP}: {pins}"
    (OUT / "requirements.txt").write_text("\n".join(pins) + "\n", encoding="utf-8")
    (OUT / ".python-version").write_text("3.12\n", encoding="utf-8")
    (OUT / "vercel.json").write_text(json.dumps(VERCEL_JSON, indent=2) + "\n", encoding="utf-8")

    # 4) refuse to ship anything that must not be public
    leaked = [p for p in OUT.rglob("*") if p.is_file() and (
        p.name == "ground_truth.json" or p.suffix == ".zip" or "data_v2" in p.parts or p.name in ("generate.py", "edgecases.py"))]
    assert not leaked, f"refusing to ship: {leaked}"
    pdfs = list((OUT / "data" / "bundle" / "attachments").glob("*.pdf"))
    assert pdfs, "no PDF attachments in the staging folder"
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file() and ".vercel" not in p.parts) / 1e6
    print(f"\nstaged {OUT}  ({size:.1f} MB, {n} cases seeded, {len(pdfs)} PDF attachments)")
    # --archive=tgz: the free plan caps uploads at 5,000 files a day and this app is ~2,500 small files
    print("next:  vercel deploy dist-vercel --archive=tgz            (preview)\n"
          "       vercel deploy dist-vercel --prod --archive=tgz     (public)")


if __name__ == "__main__":
    main()
