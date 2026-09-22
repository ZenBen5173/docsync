#!/usr/bin/env python3
"""One command to run everything.

    python run.py            build the UI if needed, seed the database from the bundle, serve on http://localhost:8000
    python run.py --dev      API on :8000 + Vite dev server with hot reload on :5173
    python run.py --reseed   wipe the app database and re-run the pipeline first

Works on Windows, macOS and Linux (no make needed). Uses the project's .venv when present.
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
VENV_PY = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
PY = str(VENV_PY) if VENV_PY.exists() else sys.executable
NPM = shutil.which("npm") or "npm"


def sh(cmd, **kw):
    print("›", " ".join(map(str, cmd)))
    return subprocess.run(cmd, check=True, **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev", action="store_true", help="run the Vite dev server next to the API")
    ap.add_argument("--reseed", action="store_true", help="delete the app database and re-run the pipeline")
    ap.add_argument("--source", default=os.environ.get("DOCCHECK_SOURCE", str(ROOT / "data" / "bundle")))
    ap.add_argument("--port", default="8000")
    a = ap.parse_args()
    env = dict(os.environ, PYTHONIOENCODING="utf-8", DOCCHECK_SOURCE=a.source)

    if not Path(a.source).exists() and not a.source.startswith("http"):
        sys.exit(f"Dataset not found at {a.source}. Unzip sdoc-hackathon-bundle.zip to data/bundle or pass --source.")

    db = ROOT / "var" / "doccheck.db"
    if a.reseed:
        for f in db.parent.glob("doccheck.db*"):
            f.unlink()
    if not db.exists():
        print("Seeding the database: running the pipeline over the inbox (about a minute)…")
        sh([PY, "-m", "app.pipeline", "run", "--source", a.source, "--note", "initial seed"], cwd=ROOT, env=env)
        # freeze this clean state so Admin -> "Reset demo data" can restore it
        sh([PY, "-c", "from app import store; store.bootstrap(); store.snapshot_seed()"], cwd=ROOT, env=env)

    if not (WEB / "node_modules").exists():
        sh([NPM, "install"], cwd=WEB, shell=os.name == "nt")
    procs = []
    try:
        if a.dev:
            procs.append(subprocess.Popen([NPM, "run", "dev"], cwd=WEB, shell=os.name == "nt"))
            print("\n  UI  → http://localhost:5173   (API on :%s)\n" % a.port)
        else:
            if not (WEB / "dist" / "index.html").exists():
                sh([NPM, "run", "build"], cwd=WEB, shell=os.name == "nt")
            print("\n  DocSync → http://localhost:%s\n" % a.port)
        procs.append(subprocess.Popen([PY, "-m", "uvicorn", "app.api.main:app", "--port", a.port,
                                       "--log-level", "warning"], cwd=ROOT, env=env))
        procs[-1].wait()
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            p.terminate()


if __name__ == "__main__":
    main()
