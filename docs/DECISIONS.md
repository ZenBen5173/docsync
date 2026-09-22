# DECISIONS

Assumptions, thresholds, tolerance rules, and why. Newest phase at the bottom.
Where the brief and the data disagreed, the data won, and it is noted here.

## Ground rules we kept

- **The pipeline never reads `ground_truth.json`.** Only `eval.py` does. Nothing is keyed on an `email_id`.
- **The generator scripts were never opened** (`generate.py`, `shipment.py`, `pools.py`, `edgecases.py`, `emails.py`, `render.py`).
  We did read `server/scoring.py` and `server/app.py`, because the brief asks us to check what `/submit` rewards.
- **Held-out split.** `eval.py` puts a fixed 20% of emails (md5 of the id, `split-v1`) in a TEST split that we never
  looked at while fixing things. Both splits are reported on every run. Every fix below is a change to general
  logic (a parser, a normaliser, a cue), not to a case.
- **Provenance note.** The organiser README inside `sdoc-hackathon-docker.zip` says that package contains the answer
  key and is meant for organisers. It was in the problem-statement folder we were given, and the build brief says to
  use it as a labelled dev set, so we did — for error analysis only. If the organisers did not intend to hand it out,
  the pipeline itself is unaffected: it has no dependency on it.

## Phase 1 — pipeline on text pairs + classifier

Plan: inbox loader → body cleaner → rule classifier → txt reader → label-meaning field mapper → normalise/compare →
status routing → `submission.json` → `/submit`.

**Classifier is body-first.** Looking at the inbox, subjects are recycled across threads and are actively misleading
(SI hand-offs carry "TO CONFIRM DOCS" subjects, invoice queries carry carrier/BL subjects). So: the sender's own
message has weight 1.0, the subject 0.3, the quoted thread 0.1. Banners, signatures and quoted threads are stripped
first (`app/ingest/clean.py`). Attachments are a signal (+2.5 when a BL is attached), never proof. Cues are
intent-level phrases ("draft BL", "check … against the SI", "invoice", "automated notification", "verify your
account"), not copies of dataset sentences, so unseen wording still scores.

**Confidence** = blend of the winner's share of the total score and its margin over the runner-up, scaled by how
strong the evidence is (one strong cue ≈ full strength). Below `classify_review_below` (0.55) the email is flagged for
a human, and the LLM is consulted if one is configured.

**BL_COMPARISON with no attachments — what `/submit` rewards.** The scorer only gives reliability credit for
`NEEDS_REVIEW` when the truth is `NEEDS_REVIEW`; everything else is expected to be `OK`. The data shows two different
situations, and we treat them differently on purpose:
- the sender **asks us/the carrier to send** the draft ("please assist to send the draft BL … for checking") → this is
  a request that is still waiting for the draft. Nothing is missing *from this email*. → `OK`, note "awaiting draft".
- the sender **says documents are attached, or asks us to compare them**, and nothing arrived → `NEEDS_REVIEW /
  missing_attachment`.
Rule: no attachments + (mentions attached/enclosed, or asks to compare/check SI and BL) + does **not** ask someone to
send/share/provide the draft → `missing_attachment`. Otherwise `OK`.

First score: **0.9738** (stage-1 1.000, defect-F1 0.978, end-to-end 44/46). All six misses were one root cause — see
Phase 2.

## Phase 2 — PDF / xlsx / docx / scans, normalisation, NEEDS_REVIEW reasons

**One document model for every format.** Each reader turns a file into rows that keep their source location
(txt line, PDF bounding box, xlsx cell, docx table row). Extraction and the evidence viewer are therefore the same
code for every format. PDFs are rebuilt from word boxes (rows by y, columns by x-gap) because the dataset's PDFs are
form layouts where label and value sit in different columns.

**Align by meaning, not label.** Three deterministic paths per row: structural (cells/columns), `Label: value`, and a
known label glued to its value ("Consignee (Non-Negotiable) ACME LTD"). Labels are matched by meaning-level rules on
a normalised label (CJK stripped, punctuation removed): anything containing "notify" → notify party, "consignee / to
the order of / cnee" → consignee, "load port / POL / port of loading" → POL, and so on. `CONTAINER NO.`, net weight,
seal, place of receipt/delivery are explicitly *not* fields.

**Root cause of the Phase 1 misses:** in the PDFs the label `Gross Weight毛重(KGS)` comes out of the text layer as
`Gross WeightII(KGS)` (the font has no CJK glyphs), and the rule required a word boundary after "weight". Fixed by
dropping the trailing boundary — a general fix for any mangled suffix. Score → **1.0000** on both splits.

**Doc type comes from content; the file name is only a tie-breaker.** Title row first (other document types are
checked before SI, and SI before BL, so "BILL OF LADING INSTRUCTION" is an SI), then the body, then the file name. A
file called `*_BL.txt` whose title is COMMERCIAL INVOICE / PACKING LIST / CERTIFICATE OF ORIGIN is `wrong_doc_type`.

**Tolerances and comparison rules**

| Field | Rule | Why |
|---|---|---|
| gross weight | numeric, units converted (KG/KGS, MT/tons ×1000, lbs), **abs tolerance 1 kg**, relative 0% | Every planted weight defect in the data is ≥ 500 kg, so 1 kg only forgives rounding (`131,058.4` vs `131,058`). Configurable in Admin. |
| "131.058" | read as 131 058 in a kg context, as a decimal when the unit is MT | European thousands separators are common on shipping docs; "21.577 MT" must stay 21.577. |
| container count | total count parsed from `3 x 40'HC`, `2x20GP + 1x40HC`, `THREE (3)`, `5 CONTAINERS` | The field is a *count*. A size difference with the same count still matches, at confidence 0.8 with a note. |
| ports | compare the **port name** (city), after removing terminal names in brackets, LOCODE suffix, "Port of", country aliases; aliases from the KB first | **Data beat the brief here:** the brief suggests validating against UN/LOCODE, but in the data a changed port keeps the *old* LOCODE (`SINGAPORE, SINGAPORE (MYPKG)`). Trusting the code would hide every port defect. The code is used only as a note, and to flag "same name, different code" as unsure. |
| parties | compare the company name line only (never the address); punctuation, case, `&`/AND, `LIMITED→LTD`, `SENDIRIAN BERHAD→SDN BHD`, `L.L.C.→LLC`, "To the Order of" prefix normalised | Identity, not formatting. |
| parties, near-misses | ≥ 0.94 similarity and length within 2 → match (conf 0.75); 0.85–0.94 → **unsure**; legal form dropped ("ROXCEL TRADING" vs "… GMBH") → **unsure**; bare "TO ORDER" on one side → **unsure**; else mismatch | **Data:** `APRIL FINE PAPER TRADING` vs `APRIL FINE PAPER TRADING (MIDDLE EAST) FZE` is a real defect (they are different legal entities with different addresses), so subset/fuzzy matching must not swallow it. Anything in the grey zone goes to a person, per "prefer NEEDS_REVIEW over guessing MISMATCH". |
| blanks | empty, `???`, `____`, `____MT`, `TBA/TBC/TBD`, `N/A`, `n.a.`, `nil`, "to be advised" → **missing_value**, never MISMATCH | Brief + data. A labelled-but-empty field is "blank"; a field with no label at all is "not found"; both escalate. |

**Review-reason priority** when several apply: `unreadable` > `wrong_doc_type` > `missing_attachment` > `missing_value`.
The scorer accepts any reason for reliability credit, so this is about telling the reviewer the most blocking thing first.

**Scanned PDFs: OCR, but never auto-accept.** Image-only scans are OCR'd (RapidOCR/ONNX — pip-installable, no system
Tesseract needed on Windows) so the reviewer gets proposed values and highlighted crops, but the case is still
`NEEDS_REVIEW / unreadable`. The data labels scans as unreadable, and an OCR misread of one digit in a weight is
exactly the silent error this tool exists to prevent. `ocr_auto_accept` in Admin turns this off for teams that want it.

**Unsure fields → NEEDS_REVIEW.** The scorer has only four review reasons; a low-confidence comparison is reported as
`unreadable` when OCR was involved and `missing_value` otherwise, with the real explanation in `review_detail`. Cost
analysis of `/submit`: escalating a truly-OK case costs nothing on the headline metric (only escalation precision);
calling it MISMATCH costs defect precision. Escalating a true MISMATCH loses that case. So unsure is reserved for
genuine grey zones, not used as a blanket.

Scores (official `/submit`, Docker): **1.0000** — stage-1 macro-F1 1.000, defect-F1 1.000, end-to-end 46/46,
escalation F1 1.000. TUNE 1.0000 / held-out TEST 1.0000. See `runs/LOG.md`.

**Honest caveat on 1.0.** The dataset is synthetic and regular; a perfect score here mostly says the parsers cover
its layouts. What should carry to a different set is in `tests/` (133 tests on *synthetic variants that are not in
the dataset*: `Port Kelang`, `THREE (3)`, `21.5 MT`, `L.L.C.`, European decimals, OCR-squashed labels, unseen email
wording). What will *not* carry without an LLM key: horizontally laid-out spreadsheets (header row + value row),
free-prose documents, and non-English labels beyond the bilingual ones seen.

## Phase 3 — confidence, routing, review queue, retry

- Every field carries extraction confidence (structural/colon 0.98, glued-label 0.92, squashed/OCR label 0.85, LLM
  0.8 if the value is found verbatim in the document else 0.4, OCR × engine confidence). A comparison's confidence is
  capped by the weaker side's extraction confidence.
- `field_review_below` = 0.60 by default, overridable per field; below it a match/mismatch becomes unsure → review.
- Stages (`ingest → classify → completeness → extract → compare → route`) are each wrapped: a failure marks the case
  `FAILED` with the stage, error and trace, never stops the batch, and can be retried per case, per stage, in bulk, or
  with `python -m app.pipeline retry --failed`. Stages are deterministic and take milliseconds, so "retry from stage
  X" re-runs the chain from the documents; the option exists so a reviewer can see *which* stage failed and re-run it.
- Human decisions are stored as `overrides` on the case (category, verdict, corrected values, locked assignee) and
  **survive re-runs**; the AI's own answer is kept next to them (`ai_status`).
- LLM calls: provider/model/key from env, temperature 0, JSON only, cached on disk by content hash. No key → every
  caller falls back to its deterministic path. This build was developed and scored with **no LLM key at all**.
- 8 worker threads (`PIPELINE_CONCURRENCY`); SQLite in WAL mode.

## Phase 4 — Gmail-style UI

- Stack as suggested (FastAPI + SQLite/SQLAlchemy, React + Vite + TS + Tailwind v4, TanStack Query, Recharts).
  **Deviation:** SQLAlchemy directly rather than SQLModel (JSON columns + fewer moving parts). **Deviation:** a 60-line
  history-API router instead of react-router.
- Working name **DocSync**, teal brand. Rename via `PRODUCT_NAME` env; recolour via `--brand` in `web/src/index.css`.
  Gmail's structure, density and interactions are copied; none of Google's branding is.
- The dataset has no timestamps, so the inbox gets a stable synthetic timeline (newest = highest id).
- UI components were sourced from the owner's personal component library where one existed (AnimatedLucide icons
  driven by their row, TagSelect for the label picker, MathCurveLoader, AnimatedNumber, GenerateButton, Living Charts,
  the Sidebar 2.0 gliding hover highlight, motion tokens). Nothing in the library is a mail list, thread view or
  verification table, so those are hand-built. The library's empty-states entry is flagged there as plain, so the
  empty states here are custom.
- Evidence: PDFs/scans are cropped server-side around the value's bounding box with a highlight (cached PNG); txt /
  xlsx / docx evidence is rendered from the stored neighbouring rows with the value marked and its line/cell address.
- Live updates over SSE, batched client-side so a 520-email run does not cause 520 refetches.

## Phase 5 — admin, drafts, learning loop

- Roles are a demo switcher (avatar menu), no real auth — as the brief allows.
- Changing a rule, a route, or a person's active flag re-tags and re-routes every case immediately. Manual
  assignments are never overwritten by routing.
- "Send" is simulated: stored in Sent, with Undo.
- **Learning loop.** Every staff change is stored as a diff with context (field result overrides, value corrections,
  verdict/category changes, sentence-level reply diffs). "Generate now" groups them into *proposed* KB items — by the
  LLM when configured, otherwise by a deterministic grouper (aliases from match-overrides, reply lines staff keep
  adding with the BL/OC number templatised to `{bl_no}`/`{oc_no}`, classifier hints from re-categorisations). Nothing
  is used until an admin presses **Add**; approved items take effect on the next run (aliases before comparison, label
  aliases during extraction, reply lines in drafts, examples in LLM prompts). Every KB change is in a history table.

## Phase 6 — analytics

Manual trigger only. Metrics are computed in SQL/Python; the LLM only writes the narrative from those numbers
("use only the numbers given"). Without a key a templated summary with the same content is produced. Export as
markdown (endpoint) or PDF (print stylesheet).

## Deploy — putting it on the internet

Plan: one Docker image (FastAPI serves API + built UI, inbox processed at build time) on a container host; before
that, a read-only multi-agent review of the code "as if it were already public", each finding adversarially verified,
then fix what survived. The app had only ever run on localhost, and it showed.

**Host: Google Cloud Run**, one instance (`--max-instances 1`), CPU not throttled, scale to zero. Why not Vercel,
where the owner was already logged in: the backend is one stateful process (SQLite file, in-process event bus,
background pipeline thread, ~1 GB of OCR/PDF wheels). On serverless, edits would vanish between instances, "Run
pipeline" could not run live, and OCR would have to be dropped for the size limit. A container runs it unchanged.
**Blocked on billing at the time of writing:** every GCP project the owner controls has a closed billing account.

**What the review found (all real, all fixed, each with a regression test):**

| Found | Consequence if shipped | Fix |
|---|---|---|
| static-file fallback served `web/dist / <url path>` unchecked | `GET /../../var/doccheck.db` reads any file on the server | resolve, require `is_relative_to(web/dist)`; `/api/*` typos are a JSON 404, not `index.html` |
| `source` and `scoring_url` accepted from request bodies | SSRF to internal addresses; POST of the whole submission to an attacker's host | removed: source and scorer are server config only; scoring endpoint off in demo mode |
| user regexes (tag rules, KB hints) run with `re` | `(.+)+Z` hangs the only process forever | shape check at save time with an explanation + `regex` engine timeout + 6 000-char cap |
| …and my first version of that fix: 50 ms wall-clock timeout, disabled on first strike | waiting for the GIL counted as "slow": the seed lost **124 of 127** "External sender" tags | 2 s backstop, 3 strikes; regression test runs the rule under 8 busy threads |
| `.gcloudignore` copied from `.dockerignore` | gitignore semantics: `*.pdf` matches at any depth → all 28 PDF attachments stripped from the cloud build, silently | anchor `/*.pdf`, `/*.zip`; Dockerfile and deploy script both fail loudly if the dataset is missing |
| `PUT /api/settings` used `dict(a, **b, **c)` | TypeError on any key saved twice: **Save thresholds was broken for everyone** | `{**a, **b, **c}` + whitelist/clamp of keys and values |
| `ov = dict(case.overrides)` then nested mutation | SQLAlchemy saw old == new and skipped the UPDATE: the **second correction on a case was lost** | `copy.deepcopy` |
| overrides loaded once per pipeline run | a correction made during a run was overwritten by the run's stale result | re-read the case's overrides right before saving; recompute if they changed |
| empty bulk "retry" | `ids=[]` fell through to a full 520-email run | no-op |
| endpoints assumed the case exists | 500 instead of 404 on seven routes | `_case_or_404` |
| the only admin could be demoted/deactivated | every visitor locked out of Admin, no way back | last-active-admin guard (409) |
| OCR engine created per thread, inference unsynchronised | ~0.5 GiB peak per concurrent scan → OOM-kill of the one instance | one engine, one job at a time; full run verified at 450 MiB inside a 1 GiB container |
| OCR import errors swallowed at run time | an image with a broken native stack would build "successfully" | build-time smoke test; OCR's transitive deps pinned |
| one SSE stream per tab vs. Cloud Run concurrency 80 | the 81st tab cannot load the app | `--concurrency 500`; client reconnects and batches refetches during runs |

**Refuted by the verifiers (kept as-is):** "staff PII in `/api/users`" (addresses are reserved `.example`
placeholders; the team is now invented names anyway); "ignore files should be an allowlist" (the Dockerfile only
COPYs named paths, so nothing else can reach the image); component-library licences (all MIT; only the minified
bundle is served, the source is not published).

**Public demo mode** (`DOCCHECK_PUBLIC_DEMO=1`, image default): no scoring endpoint, no `/docs`, no CORS, large
pipeline runs at most every 90 s counted from the end of the previous one, 3 pipeline workers instead of 8 so a run
does not starve other visitors, `X-Robots-Tag: noindex` + `robots.txt`, and **Reset demo data** (SQLite online-backup
of a snapshot taken at build time) because on an open demo anyone can change anything. A fresh instance is also a
clean demo.

**What actually shipped: Vercel** (https://doccheck-phi.vercel.app). Cloud Run stayed blocked on billing and the
owner chose the free option knowingly: the hosted copy is a look-around site, the real demo runs locally. To make a
stateful app honest on a serverless host rather than half-broken:
- deploy from a **staging folder** (`deploy/build_vercel.py` → `dist-vercel/`): only `app/`, the built UI, the
  bundle and a seed database go up; the script refuses to stage the answer key, generators or zips;
- the database is a **copy of a bundled, read-only seed in `/tmp`**, created on cold start (`app/db.py`), so every
  instance comes up with all 520 emails processed; edits are per-instance and can vanish — the UI says so;
- **no background work**: a full run is refused with an explanation (the button says why), small retries run inside
  the request; **no event stream** (it would pin one function invocation per open tab);
- **no OCR libraries** (250 MB function limit); scans are escalated as `unreadable` either way, and the proposals
  computed at build time ship in the seed; the preview still shows the scanned page;
- static files are served by Vercel's CDN from `public/`, never by the Python function, and `/(.*)` falls back to
  the SPA; the API reaches FastAPI through one rewrite to `api/index.py`.
Surprise worth recording: Vercel promotes a project's **first** deployment to production, so the "preview first"
step went straight to the public URL. Verified afterwards on the live URL: seeded counts, PDF evidence crops,
xlsx/docx/txt previews, search, analytics, correct → send → reset, single retry, traversal attempts, clean logs.

**The access question, as the owner settled it:** the owner chose "fully public, no password". The review then pointed out
something neither of us had weighed: the hosted app shows our verdict for every one of the 520 competition emails,
and we score 1.0000 — so an open URL is in effect a public answer key for a live competition, as well as a
republication of the organisers' dataset. A shared-password gate is therefore built and tested but **off by
default** (`DOCCHECK_DEMO_PASSWORD`; HTTP Basic, any username; `/healthz` stays open for the host). Told about this,
the owner confirmed: it is a hackathon prototype, keep it fully public. The gate stays in the code, off; turning it
on later is one environment variable in the Vercel project settings plus a redeploy.

## Avery — the hover guide

**Why.** The app is full of shipping words (SI, BL, consignee, POD) and review-queue mechanics. The owner's goal: a
first-time user with no domain knowledge should be able to use it. A small character sits in a corner; rest the mouse
on anything and it says what the thing is and what clicking does.

**No AI at runtime.** Every sentence is a hard-coded template in `web/src/guide/explain.ts`, filled from live state
(who you are, whether this is the hosted copy, the open email's result, whether a pile is empty). One pure function,
`explain(key, ctx) -> { text, theme } | null`, no React in the file. It works offline, costs nothing, says the same
thing every time, and cannot hallucinate. Unknown key -> null -> Avery stays quiet.

**How an element opts in.** `data-guide="key"`; the innermost marked element wins, found by ONE `pointerover`
listener on `document` (`closest("[data-guide],[data-guide-say]")`). Families (`nav:folder:<id>`, `verify:field:<name>`,
`list:row:<email id>`) resolve by longest prefix. `data-guide-say="..."` covers state only the component knows
(e.g. how many rows are ticked). The component stores the KEY, not the text, and recomputes every render, so a line
changes under the pointer when the state does.

**One source for shared facts.** Anything both the screen and Avery state is computed once in `web/src/guide/facts.ts`
(the verdict headline, what a folder's number counts, what a role may do). The screen imports it too, so the two
cannot disagree.

**Lines were checked against the code, twice.** An inventory pass recorded what each control really does before the
lines were written; it changed several: "Change verdict -> Needs review" actually marks the email as settled;
Confirm on a needs-review email does not pick a verdict; bulk label can only add; Mismatch stays listed after a reply;
OK sometimes means nothing was compared yet. A second pass fact-checked the finished lines with an adversarial verifier.

**The second pass (5 checkers, each finding re-verified by a sceptic told to refute it) confirmed 78 problems in ~330
lines. Most were wording; five were the APP being wrong, and those were fixed in the app, not papered over in the line**
(`tests/test_review_flow.py`):
- *The auto-reply lied.* 91 emails only ask for a draft ("please send the BL"). Nothing is compared, yet the drafted
  reply said "All 7 key fields match - OK to finalize". `drafts.py` tested `not fields`, but those cases carry seven
  `not_compared` rows. It now tests whether anything was compared. The scored output was never affected.
- *Inbox > Spam tab was always empty*: the Inbox filter removed junk, then the tab asked for junk only.
- *A re-check forgot human decisions that were not "overrides"*: Confirm on an amber email, and Send to review, were
  plain flags that the next run overwrote. Both are now remembered (`overrides.confirmed` holds WHAT was confirmed, so a
  re-check that comes back the same stays settled and one that comes back different goes to a person again).
- *A reviewer's MISMATCH with no row marked produced a reply with an empty list.* It now leaves a visible gap to fill.
- *Re-checking a scanned email on the hosted copy destroyed its values* (no OCR engine there). OCR results are now
  cached on disk by source-file hash + page and shipped with the hosted build (`deploy/ocr_cache`), so scans re-check
  and preview there without the engine; locally it also makes re-runs much faster.
Also removed: two lines no element could ever show (`status:SENT`, `status:PENDING`), and `ctx.rows` now reads only
the list on screen, so a cached folder cannot answer for the row under the pointer.

**A line found a bug (first pass).** Writing the line for "OCR: minimum confidence" showed the slider was saved but never read.
Fixed in `engine.completeness()`: a scan is trusted only when auto-accept is on AND it was read at or above the
minimum; regression test in `tests/test_pipeline.py`. Defaults unchanged, score unchanged (0 wrong of 520).

**Behaviour.** ~180 ms rest before speaking, the line lingers ~4 s, eyes follow the cursor, blinks, bobs on an inner
element (the button itself stays still, so it is easy to click), hops when a new line starts, takes the colour of the
section (green/red/amber/grey), words fade in one by one, says hello once. It never covers what it explains: if the
hovered element is under the bubble it moves to a free corner, and goes home (bottom-right) when that is clear again.
Click = sleep (closed eyes, silent), remembered in localStorage. Nothing renders on touch devices
(`(hover: hover) and (pointer: fine)`). The bubble is `role="status" aria-live="polite"`; the character is a real
button with `aria-pressed`. Reduced motion is respected.

**Tests (`web/src/guide/explain.test.ts`, vitest, 954 cases).** The test scans every `.tsx` for the keys the UI can
emit and requires a line for each (and the reverse: no orphan lines); no line may contain `undefined`, `NaN`, a
placeholder or a figure from the screen; every line is under 400 characters and at most four sentences; lines follow
state (empty pile vs full, hosted vs local, viewer vs admin, match vs mismatch); unknown keys return null. The tests
caught a real bug: `explain("constructor")` reached `Object.prototype` and returned garbage — keys come from the DOM,
so prototype names are now refused.

**Not in the component library.** The owner's library was checked first; it has tooltips and cursor effects but no
guide character, so `Guide.tsx` is hand-written, using the app's existing motion tokens and colours. The name lives
in one constant (`GUIDE_NAME`).

## Simplified for first-time users (a deliberate departure from the brief's card layout)

**Why.** The owner, looking at the opened email: "this whole ui ... is too complicated and not user friendly ... even
first time user should be able to grasp how to use it instantly and be able to capture the most important information
first". The old screen put the verdict below the email, inside a card with three stats, a row of file chips, a
five-column table (Field | SI value | BL value | Result | Confidence) and SIX equal buttons.

**How it was decided.** Three independent proposals (answer-first, guided task, radical reduction) were scored by three
judges (a newcomer with no shipping knowledge, a hackathon judge reading BUILD_PROMPT, the engineer who has to build
it). Two of three picked answer-first; all three wanted radical-reduction's page order. The guided-task stepper was
dropped: more chrome on a screen whose complaint is "too complicated".

**What the screen is now - a thread: what they asked -> what the app found -> the reply.**
1. Subject, then the email folded to ONE line (sender, first words, paperclip, date). It opens unfolded when there is
   nothing to compare (then the email IS the content).
2. The answer card: one sentence in plain words - "Total weight is different from what the customer asked for." -
   never SI / BL / consignee / verdict. Under it only the details that need eyes, as two stacked values ("Customer
   asked for 40,326 KG / The draft says 41,326 KG") with ONLY the differing characters marked; "See where in the
   documents" unfolds the side-by-side evidence (USP 1, one click). Then "6 other details match - Show them" for the
   full table (3 columns; the result is an icon; confidence bars gone - an amber "double-check" / "from a scan" tag
   appears only when it changes what a person should do). Missing / wrong / unopenable file: the file cards plus a
   dashed "Missing: the shipping line's draft" placeholder instead of an empty table.
3. The drafted reply as a 3-line preview holding THE one filled button of the screen, labelled with what it does:
   "Ask for a corrected draft", "Send the all-clear", "Ask for the missing document", "Ask for a readable copy",
   "Ask them to fill the gap". One click sends (sending is simulated and has Undo); "Read and edit" opens the Gmail
   editor. Replying to an email that was waiting for a person also takes it out of the waiting line.
When the next step is not a reply the one filled button sits in the card instead: "Try again" (failed), "Save my
answer" (the app is unsure: Same / Different per detail, nothing pre-selected, explicit save), "I agree with this
result" (a teammate asked for a second look), "Yes, that's right" (unsure what kind of email it is). Finished emails
show no filled button at all, just "Done. Arif replied on ..." and "Back to the list".

**Nothing was removed.** Confirm, correct a value / overrule a row, decide the result, send to review, reassign,
retry live in "Other options" - a labelled menu where each item says what it does. Confidence, shipping line, assignee,
files read, why the app stopped, per-step status, reference id and history live in "About this check", ONE remembered
toggle that also restores the "How sure" column: leave it on and the brief's full expert table is back.

**One source of truth.** `answerFor(c)` in `web/src/guide/facts.ts` decides which situation an email is in, the
sentence, and the one next step; the card, the reply button and Avery all read it (15 situations, tested).

**Inbox.** One dismissible sentence ("The app has already compared ... 20 are waiting for a decision and 46 drafts have
differences") with one button, "Show me one". Rows: the status is a plain WORD in an aligned column, coloured only when
a person is needed (OK is muted); one tag + "+n"; confidence only when under 70%; weights capped at medium. Sidebar:
less-used places fold under "More" (Failed shows itself as soon as it is non-empty), tag groups fold.

**Two existing bugs the rewrite had to fix first:** menus opened inside the card were clipped (`overflow-hidden` card,
absolutely positioned popover) - the glow now has its own clipped layer and popovers flip upward near the bottom of the
screen; and Escape left the page even when it was only meant to close a menu or the file preview.

**From the component library:** Magnetic Button (the one primary), the Spotlight Card cursor-glow mechanic, the FAQ
Accordion's grid-rows height mechanic (as `ui/disclosure.tsx`; the FAQ's skin does not fit a dense app screen), and
Animated Number. Nothing in the library fits the two-value diff block, the Same / Different control or the labelled
paged menu, so those are hand-written. Dark mode got its own lighter status colours (the light ones were ~2.6:1 on the
dark tints). Folded sections stay mounted, so printing shows everything.

## Will it work on NEW mail? (stress test, 2026-09-21)

The owner's worry: the rules were built by looking at this dataset, so the 80/20 split proves nothing about new mail.
Test (`var/stress_test.py`): the true answers are fixed in the script; an AI model writes the emails and both documents in
its own wording and layouts (other labels, text tables, free-form letters, untidy forms; the words "BL" and "SI" banned
from the emails). Run twice: rules only, and with the AI helper on. Nothing touches the app's inbox.

- **Before any fix (batch A, 29 emails):** rules only 10 right, 9 asked a person, 10 sorted into the wrong kind.
  Two causes: the sorter leaned on the words BL/SI, and documents were only recognised by a title or a familiar file name.
- **General fixes, not per-case:** plain-word cues in the sorter; other companies' names for the two papers; when one side
  is known and one other untitled form is attached, the pair is assumed; the AI sorter is told that what the writer asks
  for decides the kind; "40 foot" is no longer read as a count of 40. The 520-email score stayed at 0 wrong.
- **Clean result on an untouched batch (C, 30 emails, written after all fixes):** rules only 24 right, 4 asked a person,
  2 wrong kind. AI on: 29 right, 1 wrong kind. No wrong comparison result in that batch.
- **What it means:** when the rules cannot read a layout (tables, letters) they ask a person rather than answer wrongly;
  the AI helper closes most of that gap for about a tenth of a cent per batch. The remaining risk is a wrongly sorted
  email, because a wrongly sorted email is never checked.

## Phase 7 — live Gmail

Not built. It was optional and explicitly last; the time went into accuracy tests and the review flow instead.
`app/ingest/inbox.py` is the single seam where a Gmail source would plug in.
