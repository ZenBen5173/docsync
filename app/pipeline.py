"""Batch runner + CLI.

  python -m app.pipeline run --source data/bundle [--submit] [--note "what changed"] [--no-db]
  python -m app.pipeline retry --ids email_004,email_511 [--stage extract]
  python -m app.pipeline retry --failed

Emails are processed concurrently; one bad email never stops the batch.
"""
import argparse
import datetime as dt
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from app import config
from app.engine import process_email, to_submission
from app.ingest.inbox import Inbox
from app.kb.store import SEED_ITEMS, KnowledgeBase


def run_batch(source: str, persist: bool = True, only_ids: list[str] | None = None,
              progress=None, note: str = "") -> dict:
    """Process the inbox. Returns {"results": [...], "submission": {...}}."""
    inbox = Inbox(source)
    emails = inbox.emails()
    if only_ids:
        wanted = set(only_ids)
        emails = [e for e in emails if e["email_id"] in wanted]

    if persist:
        from app import store
        store.bootstrap()
        store.upsert_emails(emails, source)
        kb, settings, overrides = store.load_kb(), store.load_settings(), store.load_overrides()
        run_id = store.start_run(len(emails), note)
    else:
        kb, settings, overrides, run_id = KnowledgeBase(SEED_ITEMS), {}, {}, None

    results, failed = [], 0

    def work(email):
        try:
            from app.preview import add_preview
            return add_preview(process_email(email, inbox, kb, settings, overrides.get(email["email_id"])), email, settings)
        except Exception as e:  # belt and braces: process_email already isolates stages
            return {"email_id": email["email_id"], "category": None, "status": "FAILED",
                    "error": f"{type(e).__name__}: {e}", "stages": {}, "fields": [], "docs": [],
                    "defect_fields": [], "review_reason": None, "category_confidence": 0, "confidence": 0}

    with ThreadPoolExecutor(max_workers=config.PIPELINE_CONCURRENCY) as pool:
        futures = {pool.submit(work, e): e for e in emails}
        for n, fut in enumerate(as_completed(futures), start=1):
            res = fut.result()
            if persist:
                # a reviewer may have corrected this case while the run was in flight: the overrides were
                # loaded once at the start, so re-check right before saving and recompute if they changed
                from app import store
                em = futures[fut]
                fresh = store.load_override(em["email_id"])
                if fresh != (overrides.get(em["email_id"]) or {}):
                    overrides[em["email_id"]] = fresh
                    res = work(em)
            results.append(res)
            failed += res["status"] == "FAILED"
            if persist:
                from app import store
                store.save_result(res, run_id=run_id, done=n, failed=failed)
            if progress:
                progress(n, len(emails), res)

    results.sort(key=lambda r: r["email_id"])
    submission = {r["email_id"]: to_submission(r) for r in results}
    if persist:
        from app import store
        store.finish_run(run_id)
    return {"results": results, "submission": submission, "run_id": run_id, "failed": failed}


def write_outputs(out: dict, submission_path: Path):
    submission_path.write_text(json.dumps(out["submission"], indent=2), encoding="utf-8")
    (config.VAR_DIR / "last_results.json").write_text(json.dumps(out["results"], default=str), encoding="utf-8")


def submit_and_log(submission: dict, note: str, scoring_url: str | None = None) -> dict | None:
    """POST to the organisers' scorer and keep the scoreboard under runs/."""
    url = scoring_url or config.SCORING_URL
    try:
        board = Inbox(url).submit(submission)
    except Exception as e:
        print(f"!! could not reach the scoring server at {url}: {e}")
        return None
    config.RUNS_DIR.mkdir(exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = config.RUNS_DIR / f"{stamp}.json"
    path.write_text(json.dumps({"timestamp": stamp, "note": note, "final_score": board.get("final_score"),
                                "scoreboard": board}, indent=2), encoding="utf-8")
    with open(config.RUNS_DIR / "LOG.md", "a", encoding="utf-8") as f:
        e2e, s3, s1, rel = board["end_to_end"], board["stage3"], board["stage1"], board["reliability"]
        f.write(f"| {stamp} | {board['final_score']:.4f} | {s1['macro_f1']:.4f} | {s3['defect_f1']:.4f} | "
                f"{e2e['success']}/{e2e['total']} | {rel['escalation_f1']:.4f} | {note} |\n")
    print(f"scoreboard saved to {path}")
    return board


def main(argv=None):
    ap = argparse.ArgumentParser(prog="app.pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="process the whole inbox")
    r.add_argument("--source", default=config.DEFAULT_SOURCE, help="bundle folder or http://host:port")
    r.add_argument("--submit", action="store_true", help="POST submission.json to the scoring server")
    r.add_argument("--scoring-url", default=None)
    r.add_argument("--note", default="", help="what changed in this run (saved with the score)")
    r.add_argument("--no-db", action="store_true", help="do not persist to the app database")
    r.add_argument("--out", default=str(config.ROOT / "submission.json"))
    t = sub.add_parser("retry", help="re-run selected or failed cases")
    t.add_argument("--source", default=config.DEFAULT_SOURCE)
    t.add_argument("--ids", default="")
    t.add_argument("--failed", action="store_true")
    a = ap.parse_args(argv)

    t0 = time.time()
    if a.cmd == "run":
        def progress(n, total, res):
            if n % 50 == 0 or n == total:
                print(f"  {n}/{total} processed")
        out = run_batch(a.source, persist=not a.no_db, progress=progress, note=a.note)
        write_outputs(out, Path(a.out))
        from collections import Counter
        print(f"done in {time.time() - t0:.1f}s ->", a.out)
        print("  categories:", dict(Counter(v["category"] for v in out["submission"].values())))
        print("  statuses  :", dict(Counter(r["status"] for r in out["results"])))
        if a.submit:
            board = submit_and_log(out["submission"], a.note, a.scoring_url or
                                   (a.source if a.source.startswith("http") else None))
            if board:
                print(f"  FINAL SCORE {board['final_score']:.4f}")
    else:
        from app import store
        store.bootstrap()
        ids = [i for i in a.ids.split(",") if i] or (store.failed_ids() if a.failed else [])
        if not ids:
            print("nothing to retry")
            return
        out = run_batch(a.source, persist=True, only_ids=ids, note="retry")
        print(f"retried {len(ids)} case(s), {out['failed']} still failing")


if __name__ == "__main__":
    sys.exit(main())
