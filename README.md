# DocSync — shipping document verification inbox

Averis x Monash Hackathon 2026. An AI tool that reads a mixed shipping-docs inbox, finds the "please check the draft
BL" requests, compares the **Bill of Lading** against the **Shipping Instruction** (the source of truth) on 7 fields,
shows the evidence, drafts the reply — and hands the case to a person whenever it is not sure.

**Official `/submit` score: 1.0000** (stage-1 macro-F1 1.000 · defect-F1 1.000 · end-to-end 46/46 · escalation F1
1.000), identical on the 80% tuning split and the 20% held-out split. History in [`runs/LOG.md`](runs/LOG.md).
Read the caveat in [`DECISIONS.md`](DECISIONS.md) before trusting that number on a different dataset.

## Setup

Needs Python 3.11 and Node 20+. No API key is required.

```bash
py -3.11 -m venv .venv                       # macOS/Linux: python3.11 -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt     # macOS/Linux: .venv/bin/python
```

Put the participant bundle at `data/bundle/` (`inbox/`, `attachments/`, …). Optional: copy `.env.example` to `.env`
values into your shell to enable the LLM paths (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`).

## Run

```bash
.venv/Scripts/python run.py            # one command: seeds the DB, builds the UI, serves http://localhost:8000
```
```bash
.venv/Scripts/python run.py --dev      # API :8000 + Vite hot reload on http://localhost:5173
```
```bash
.venv/Scripts/python run.py --reseed   # wipe the app database and start from a clean inbox
```

Pipeline and scoring from the CLI:

```bash
.venv/Scripts/python -m app.pipeline run --source data/bundle                      # writes submission.json
```
```bash
.venv/Scripts/python -m app.pipeline run --source http://localhost:8080 --no-db --submit --note "what changed"
```
```bash
.venv/Scripts/python -m app.pipeline retry --failed
```
```bash
.venv/Scripts/python eval.py            # local error analysis: per category / status / field / reason + every wrong email
```
```bash
.venv/Scripts/python -m pytest tests -q
```
```bash
npm --prefix web test                   # the hover guide's lines: every key has a line, no placeholders, lines follow state
```

The organisers' scorer: `cd data/docker && docker compose up --build` (serves `:8080`). Every `--submit` saves the
full scoreboard to `runs/<timestamp>.json` and appends a line to `runs/LOG.md`.

## Live link (Vercel)

**https://doccheck-phi.vercel.app** — a free, public *look-around* copy.

```bash
.venv/Scripts/python deploy/build_vercel.py
```
```bash
vercel deploy dist-vercel --prod --archive=tgz
```

(`--archive=tgz` uploads one archive: the free plan allows 5,000 uploaded files a day and this app is ~2,500 small files.)

`build_vercel.py` stages a clean `dist-vercel/` folder: `app/`, the **built** UI, the participant bundle, a
database seeded here (OCR results included) and a slim dependency list. Vercel is serverless — no permanent disk, no
long-lived process — so the hosted copy differs from the local app on purpose:

| | Hosted on Vercel | Local (`run.py`) / Docker |
|---|---|---|
| Inbox, search, labels, cases, SI-vs-BL evidence, drafted replies, analytics | yes (pre-computed) | yes |
| Correct / send / label / rules / learning loop | works, but lives in a per-instance database in `/tmp` and **can disappear**; **Reset demo data** and every cold start return to the seed | persistent |
| **Run pipeline** live, live progress | no (the button explains why); retrying a few selected emails works | yes |
| OCR of scanned documents | no (libraries exceed the 250 MB function limit); proposals computed at build time are in the seed | yes |

Use the Vercel link to let people look around; run the real demo (pipeline run, corrections, learning loop) locally.

## Docker and deployment

```bash
docker build -t doccheck .
```
```bash
docker run --rm -p 8000:8000 doccheck
```

One container: FastAPI serves the API and the built UI. The inbox is processed **at build time**, so every new
container starts from the same clean, fully seeded state; `var/seed.db` is a snapshot of it and **Admin → Reset demo
data** restores it. The image contains only `app/`, the built UI and `data/bundle/` — never the organisers' scoring
package (`.dockerignore`).

Google Cloud Run (needs a project with an **active billing account**; the free tier covers a demo):

```bash
deploy/cloudrun.sh <gcp-project-id>
```

It deploys with `--max-instances 1` (live events, the pipeline lock and SQLite live in one process),
`--no-cpu-throttling` ("Run pipeline" works on a background thread) and `--min-instances 0` (scales to zero; a new
instance is a clean demo again). Any host that runs a Dockerfile works the same way (Hugging Face Spaces, Render,
Fly.io, Railway): listen on `$PORT`, one instance, ≥ 1 GB RAM.

**Public demo mode** (`DOCCHECK_PUBLIC_DEMO=1`, the image default) exists because there is no login:

| Risk on the open internet | What the app does |
|---|---|
| reading server files through the static-file fallback (`GET /../../var/doccheck.db`) | paths are resolved and must stay inside `web/dist` |
| making the server fetch or POST to any URL (`source`, `scoring_url` request fields) | removed — source and scorer are server configuration only; scoring endpoint is off |
| a regex typed into a rule or KB hint that never finishes | catastrophic shapes refused with an explanation when saved; as a backstop the `regex` engine runs with a 2 s timeout (3 strikes, then the pattern is dropped) on at most 6 000 characters |
| a visitor wrecking the demo for the next one | **Reset demo data**; a fresh instance is also a clean demo |
| hammering "Run pipeline" | one large run per 90 s (`PIPELINE_MIN_INTERVAL_S`), single-flight lock |
| API docs / server paths / other origins | `/docs` and `/openapi.json` off, no paths in responses, no CORS |

It is still an **unauthenticated** app: anyone with the link can read the sample inbox and change the demo. Do not
put an LLM API key on a public deployment (visitors could spend it), and do not point it at real mail.

## Architecture

```
                 ┌──────────────────────────── app/engine.py  (pure, per email) ───────────────────────────┐
 inbox/*.json    │ ingest ──► classify ──► completeness ──► extract ──► compare ──► route                  │
 attachments/* ─►│ read +     5 categories   SI + BL there?   7 fields     normalise    OK / MISMATCH /     │─► submission.json
 (folder or HTTP)│ doc type   + confidence   readable? right  + confidence + KB aliases NEEDS_REVIEW+reason │─► runs/*.json (/submit)
                 │            (LLM if unsure) type?           + location   match/mismatch/unsure            │
                 └───────────────┬─────────────────────────────────────────────────────────────────────────┘
                                 │ each stage try/except → FAILED + error, retryable; 8 workers
                                 ▼
   app/store.py ─► SQLite (emails, cases+stage JSON, labels, rules, routes, users, settings, kb_items(+history),
        │                  corrections, suggestions, sent, runs, analytics_reports, activity)
        ├─ app/tagging.py   auto-tags (carrier / customer / POD) + admin rules + tag→person routing with backup
        ├─ app/drafts.py    reply templates (+ approved KB reply lines)
        ├─ app/learning.py  staff diffs ─► proposed KB changes ─► Add / Reject ─► used on next run
        ├─ app/analytics.py metrics ─► LLM (or templated) narrative
        └─ app/evidence.py  PDF/scan crop around the value's bounding box, highlighted
                                 ▼
   app/api (FastAPI, SSE live events) ◄────► web/ (React + Vite + TS + Tailwind, TanStack Query, Recharts)
```

| Folder | What |
|---|---|
| `app/ingest/` | inbox loader (folder or HTTP), body cleaner (banner / signature / quoted thread) |
| `app/classify/` | weighted-cue classifier, optional LLM second opinion |
| `app/extract/` | readers for txt / pdf (word boxes) / xlsx / docx / OCR, doc-type detection, label-meaning field mapper, LLM fill |
| `app/compare/` | normalisers (numbers, units, containers, ports, parties) and field comparison |
| `app/kb/` | knowledge-base view used by the pipeline (aliases, label aliases, hints, reply lines, carrier prefixes) |
| `app/api/` | REST + SSE; `admin.py` for the admin centre and analytics |
| `web/` | the Gmail-style UI |
| `eval.py` | the only reader of `ground_truth.json`; 80/20 split |
| `tests/` | 163 tests: normalisers, comparison, extraction, classifier, routing, drafts, learning diff, tag rules, end-to-end API, public-deploy hardening |

## How each requirement is met

| Requirement | Where |
|---|---|
| Classify into 5 categories with confidence; attachments are a signal not proof | `app/classify/classifier.py` — body 1.0 / subject 0.3 / quoted 0.1, evidence list shown in the UI's category menu |
| Completeness check + the 4 review reasons | `engine.py: completeness()/route()` |
| Extract 7 fields with confidence + source location, all formats, scans | `app/extract/*` — line no. / PDF bbox / cell address / table row stored per value |
| Normalise and compare, KB consulted first, match / mismatch / unsure + reason | `app/compare/*`, `app/kb/store.py` |
| Route by confidence, thresholds configurable | `engine.py: route()`, Admin → Thresholds (global, per field, per document type) |
| Export, eval, `/submit`, scoreboards saved with a note | `app/pipeline.py`, `eval.py`, `runs/` |
| Robustness: isolated stages, FAILED + retry, cache, concurrency | `engine._stage`, `pipeline.run_batch`, `llm.py` (content-hash cache) |
| LLM optional and configurable | `app/llm.py`; everything has a deterministic fallback |
| **USP 1 evidence screenshots** | Answer card → "See where in the documents" on any detail (or any row of "Show them"): both documents side by side; PDF/scan = highlighted crop, txt/xlsx/docx = surrounding rows with line / cell address |
| **USP 2 tagging** | auto-tags (shipping line, customer, POD) + custom labels, rules, tag → employee with backup, `label:msc status:mismatch` search |
| Admin centre | `/admin`: Labels and rules · Routing · Team · Thresholds · Knowledge base (with history) · Learning report. Rule/route changes re-tag live |
| Human review | Needs review folder. One filled button per email says the next step; everything else is in **Other options** (fix a value / overrule a row · decide the result · mark as checked · ask for a second look · hand over · run again) and **Filed as ▾** (change category) — every change logged. **About this check** (one remembered toggle) brings back confidence, shipping line, assignee, files read, per-step status, history and the "How sure" column |
| Auto-draft replies + simulated Send | Gmail-style reply box, autosave, Send → Sent folder, Undo |
| Learning loop | `app/learning.py`, Admin → Learning report (Generate now, Add / Reject) |
| AI analytics | `/analytics`: filters, Analyze, KPI tiles, charts, summary, export markdown / PDF |
| Error handling and retry | Failed folder, retry per case / per stage / selected / all failed / CLI |
| **Avery, the hover guide** (no domain knowledge needed) | `web/src/guide/` — rest the mouse on anything and a small character in the corner says what it is and what clicking does, in plain words. No AI at runtime: `explain(key, ctx)` is a pure function over hard-coded templates filled from live state, so it works offline and cannot invent facts. 1,017 tests (`npm test` in `web/`) |
| Gmail-like UI | top bar + operator search, collapsible sidebar with counts, Cases / Other / Spam tabs, row chips + hover actions, bulk toolbar, pagination, `j k o u x e l s / ?`, SSE live updates, Undo toasts, skeletons, empty states, dark mode |

## 3-minute demo path

0. Rest the mouse on anything — **Avery** (bottom-right) explains it in plain words and changes colour with the section. Click him to make him sleep.
1. `/inbox` — cases tagged by shipping line, status chips, confidence, assignee avatars. Click **MSC** in the sidebar, or search `label:msc status:mismatch`.
2. Press **Show me one** (or open `email_499`, PDFs) — one sentence says what is wrong, with both values and only the differing digit marked. **See where in the documents** unfolds the two crops with the value highlighted. Turn on **About this check** once for the expert view. Try `email_004` for text documents, `email_512` for a scan with OCR proposals.
3. **Ask for a corrected draft** sends the drafted reply in one click (Undo toast) — or **Read and edit** first (add a sentence such as "Please quote BL no. … in your reply.") and press **Send** → Sent folder, Undo toast.
4. On another case open **Other options → Fix something the app misread**, override a row, **Save my fixes** — the verdict, report and reply update immediately.
5. Admin → **Learning report** → **Generate now** → **Add** a suggestion → it appears in Knowledge base with history.
6. **Run pipeline** (top-left) — live progress; open another mismatch: the approved reply line is now in its draft.
7. **Analytics** → **Analyze** → tiles, hotspots, summary → Export.

## Known limitations

- **The 1.0 score is on a synthetic, regular dataset.** Generalisation is argued by tests on unseen variants, not proven on a second dataset.
- Spreadsheets laid out horizontally (header row, value row) and free-prose documents need the LLM path; the deterministic parser expects label → value.
- Scans are always escalated by default; OCR values are proposals. OCR is RapidOCR (ONNX); quality on real fax-grade scans is untested.
- Party comparison is deliberately strict; genuine trading-name variants need a KB alias (the learning loop proposes them).
- The LLM code paths (classification second opinion, field fill, learning grouping, analytics narrative) are implemented and cached but were **not exercised in this build** — no API key was available in the build environment.
- Avery, the hover guide, needs a mouse: it renders nothing on touch screens, and its lines are English only.
- No real authentication (role switcher), simulated send, no live Gmail integration.
- "Retry from stage" re-runs the deterministic chain from the documents rather than resuming mid-way.
- SQLite + threads is fine for one team's inbox; a multi-team deployment would want Postgres and a real queue.
