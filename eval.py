#!/usr/bin/env python3
"""Local error analysis against the labelled dev set.

  python eval.py [submission.json] [--gt data/docker/data_v2/ground_truth.json] [--details var/last_results.json]

This is the ONLY place that reads ground_truth.json. The pipeline never does.
A fixed 20% of emails (hash of the id) is a held-out TEST split that we do not
tune on; both splits are reported.
"""
import argparse
import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "data" / "docker" / "server"))
CATS = ["BL_COMPARISON", "SI_REQUEST", "INVOICE_QUERY", "GENERAL", "SPAM"]
FIELDS = ["shipper", "consignee", "notify_party", "port_of_loading", "port_of_discharge",
          "container_count", "gross_weight_kg"]


def is_test(eid: str) -> bool:
    return int(hashlib.md5(("split-v1:" + eid).encode()).hexdigest(), 16) % 5 == 0


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def table(title, rows):
    print(f"\n{title}")
    print(f"  {'':24}{'P':>7}{'R':>7}{'F1':>7}{'n':>6}")
    for name, tp, fp, fn in rows:
        p, r, f = prf(tp, fp, fn)
        print(f"  {name:24}{p:7.3f}{r:7.3f}{f:7.3f}{tp + fn:6d}")


def official(truth, sub):
    from scoring import score_all
    s = score_all(truth, sub)
    return {"final": s["final_score"], "stage1_macro_f1": s["stage1"]["macro_f1"],
            "stage3_defect_f1": s["stage3"]["defect_f1"], "field_f1": s["stage3"]["field_f1"],
            "e2e": s["end_to_end"]["rate"], "escalation_f1": s["reliability"]["escalation_f1"],
            "escalation_recall": s["reliability"]["escalation_recall"],
            "escalation_precision": s["reliability"]["escalation_precision"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("submission", nargs="?", default=str(ROOT / "submission.json"))
    ap.add_argument("--gt", default=str(ROOT / "data" / "docker" / "data_v2" / "ground_truth.json"))
    ap.add_argument("--details", default=str(ROOT / "var" / "last_results.json"))
    ap.add_argument("--json", action="store_true", help="print the score summary as JSON only")
    a = ap.parse_args()
    truth = json.load(open(a.gt, encoding="utf-8"))
    sub = json.load(open(a.submission, encoding="utf-8"))
    details = {}
    if Path(a.details).exists():
        details = {r["email_id"]: r for r in json.load(open(a.details, encoding="utf-8"))}

    splits = {"ALL": truth, "TUNE (80%)": {k: v for k, v in truth.items() if not is_test(k)},
              "TEST (held-out 20%)": {k: v for k, v in truth.items() if is_test(k)}}
    summary = {name: official(t, sub) for name, t in splits.items()}
    if a.json:
        print(json.dumps(summary, indent=2))
        return
    print("=" * 78)
    for name, s in summary.items():
        print(f"{name:22} final={s['final']:.4f}  stage1={s['stage1_macro_f1']:.4f}  defectF1={s['stage3_defect_f1']:.4f}"
              f"  e2e={s['e2e']:.4f}  fieldF1={s['field_f1']:.4f}  escF1={s['escalation_f1']:.4f}  (n={len(splits[name])})")
    print("=" * 78)

    c = {k: Counter() for k in ("cat", "status", "field", "reason")}
    wrong = []
    for eid, t in truth.items():
        s = sub.get(eid, {"category": "GENERAL", "status": "OK", "review_reason": None, "defect_fields": []})
        for key, tv, sv in (("cat", t["category"], s.get("category")), ("status", t["status"], s.get("status")),
                            ("reason", t["review_reason"], s.get("review_reason"))):
            if tv == sv:
                c[key][(tv, "tp")] += 1
            else:
                c[key][(tv, "fn")] += 1
                c[key][(sv, "fp")] += 1
        tf, sf = set(t["defect_fields"]), set(s.get("defect_fields") or [])
        for f in FIELDS:
            if f in tf and f in sf:
                c["field"][(f, "tp")] += 1
            elif f in tf:
                c["field"][(f, "fn")] += 1
            elif f in sf:
                c["field"][(f, "fp")] += 1
        if (t["category"], t["status"], t["review_reason"], tf) != (s.get("category"), s.get("status"), s.get("review_reason"), sf):
            wrong.append((eid, t, s))

    def rows(key, names):
        return [(str(n), c[key][(n, "tp")], c[key][(n, "fp")], c[key][(n, "fn")]) for n in names]
    table("Per category", rows("cat", CATS))
    table("Per status", rows("status", ["OK", "MISMATCH", "NEEDS_REVIEW"]))
    table("Per defect field", rows("field", FIELDS))
    table("Per review_reason", rows("reason", ["wrong_doc_type", "missing_attachment", "unreadable", "missing_value"]))

    print(f"\nWrong emails: {len(wrong)} of {len(truth)}")
    for eid, t, s in wrong:
        tag = "TEST" if is_test(eid) else "tune"
        print(f"\n- {eid} [{tag}]")
        print(f"    expected: {t['category']} / {t['status']} / {t['review_reason']} / {sorted(t['defect_fields'])}")
        print(f"    ours    : {s.get('category')} / {s.get('status')} / {s.get('review_reason')} / {sorted(s.get('defect_fields') or [])}")
        d = details.get(eid)
        if d:
            print(f"    category confidence {d.get('category_confidence')}  scores {d.get('classification', {}).get('scores')}")
            if d.get("review_detail"):
                print(f"    detail  : {d['review_detail'][:300]}")
            for fr in d.get("fields") or []:
                if fr["result"] != "match":
                    print(f"    {fr['field']:18} {fr['result']:9} SI={((fr.get('si') or {}).get('raw'))!r} "
                          f"BL={((fr.get('bl') or {}).get('raw'))!r} :: {fr['reason'][:120]}")


if __name__ == "__main__":
    main()
