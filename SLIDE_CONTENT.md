# DocSync - Preliminary Round Slide Deck
Exactly what to put on each slide. Text in `[ ]` needs filling in. Speaker notes are for the demo video, not the slide.

Deadline: Tue 22 Sep 2026, 12:00 PM. Deck must cover: technical architecture, implementation details, challenges faced, future roadmap.

---

## Before you build the deck: 3 fixes

1. **Turn the AI on.** The rules say AI must be a key component. The LLM paths (classification second opinion, field fill, learning grouping, analytics narrative) are built but were never run. Set `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, run the pipeline once with a key, and take a screenshot. Then slide 7 is true.
2. **Deploy to a real cloud host.** Vercel is only a look-around copy. `deploy/cloudrun.sh` exists. Cloud Run or any Docker host gives you a live link where the full pipeline runs. The rubric penalises weak cloud use.
3. **Do not claim you never saw the answer key.** `eval.py` reads it for error analysis. Say: "validated with the organisers' scorer, plus an 80/20 tuning and held-out split."

---

## Slide 1 - Title

**DocSync**
Your shipping desk's co-pilot. Spot it before it sails.

- Team [team name] | Averis x Monash Hackathon 2026
- [member names]

Visual: the inbox screenshot, Avery in the corner, product wordmark.

---

## Slide 2 - The problem

**One inbox. Five kinds of mail. Every draft BL checked by hand.**

- The shipping desk receives check requests, SI requests, invoice queries, updates and spam in the same inbox
- For each check request, a person compares the Shipping Instruction against the draft Bill of Lading, field by field
- The same value is labelled differently on each document: "Port of Loading" vs "Load Port", "Consignee" vs "To the Order of"
- A missed mismatch becomes an amendment fee, a customs hold, or cargo that cannot be released

Visual: SI and BL side by side with one differing value circled.

Speaker note: the BL is a title document. If the consignee is wrong, the wrong party can claim the cargo.

---

## Slide 3 - Who it affects

**Three parties, one avoidable cost**

- **Docs team:** repetitive reading, easy to miss a digit, no audit trail
- **Exporter (APRIL):** pays amendment fees and absorbs delays
- **Shipping line:** avoidable back and forth on every draft

One line: caught at draft stage it is a reply. Caught after it is a cost.

---

## Slide 4 - DocSync

**An inbox that checks the documents for you**

- Sorts every email into 5 categories
- Reads the SI and the BL: txt, PDF, Excel, Word and scanned pages
- Compares the 7 fields and says what is different
- Shows the exact spot in both documents where each value was read
- Drafts the reply, ready to send
- Escalates to a person whenever it is not sure, with the reason

Visual: full screenshot of the inbox with status chips and labels.

---

## Slide 5 - Technical architecture

**Six stages, each testable, each retryable**

`ingest -> classify -> completeness -> extract -> compare -> route`

- **ingest:** folder or HTTP; strips banners, signatures and quoted threads
- **classify:** weighted cues (body 1.0 / subject 0.3 / quoted 0.1) + LLM second opinion when unsure
- **completeness:** is the SI and BL there, readable, and the right document type
- **extract:** 7 fields with confidence AND source location (line number, PDF bounding box, cell address, table row)
- **compare:** normalisers + knowledge base aliases, per field match / mismatch / unsure
- **route:** OK, MISMATCH, or NEEDS_REVIEW with one of 4 reasons
- Every stage is wrapped: failure marks the case FAILED with the error and can be retried. 8 workers.

Visual: the architecture diagram from README.md, redrawn. Show FastAPI + SSE, SQLite, React UI, LLM and OCR as side services.

---

## Slide 6 - Implementation details

**What is actually under each stage**

- **Backend:** Python 3.11, FastAPI, SQLite, SSE for live updates, 8-worker pipeline with a single-flight lock
- **Frontend:** React, TypeScript, Vite, Tailwind, TanStack Query, Recharts
- **Documents:** PDF word boxes, python-docx tables, openpyxl cells, RapidOCR (ONNX) for scans
- **Comparison:** normalisers for numbers, units, container formats, ports and party names; KB aliases consulted before any mismatch is called
- **Evidence:** crop rendered around the value's bounding box, highlighted
- **Storage:** emails, cases with per stage JSON, labels, rules, routes, users, thresholds, KB items with history, corrections, suggestions, sent replies, runs, analytics reports, activity log

Visual: folder tree `app/ingest, app/classify, app/extract, app/compare, app/kb, app/api, web/`.

---

## Slide 7 - AI and cloud

**Where the AI is, and where it is not**

- **AI used for:** classification second opinion on low-confidence mail, field extraction on free-form and horizontally laid out documents, grouping staff corrections into knowledge base proposals, writing the analytics narrative
- **Deterministic fallback everywhere**, so a failed or missing model never stops a check
- **AI calls are cached by content hash**, so re-runs are fast and cheap
- **Cloud:** Docker image, deployed on [Cloud Run / Vercel]; scales to zero, one instance, public link for judges
- **Guardrails:** public demo mode, path traversal blocked, no server-side URL fetching, regex timeouts, rate-limited pipeline runs

Visual: screenshot showing the LLM second opinion on a case.

---

## Slide 8 - USP 1: proof, not just a verdict

**"See where in the documents"**

- One plain sentence says what is wrong, with only the differing part marked
- One click opens both documents side by side: PDF and scans as highlighted crops, txt / Excel / Word as the surrounding rows with the line number or cell address
- The reviewer never has to open the files and hunt

Visual: the two evidence crops, SI left, BL right, value highlighted.

Speaker note: this is what turns a 4 minute check into a 10 second one.

---

## Slide 9 - USP 2: tagging and routing

**Every case lands on the right desk**

- Auto-tags by shipping line, customer and port of discharge
- Custom labels, admin rules, tag to employee with a backup person
- Operator search: `label:msc status:mismatch`
- Changing a rule re-tags and re-routes live

Visual: sidebar labels + Admin routing screen.

---

## Slide 10 - Humans stay in charge

**It never guesses and never fails silently**

- 4 escalation reasons: wrong document type, missing attachment, unreadable, missing value
- A blank or an unreadable scan is uncertainty, not a mismatch. This keeps false alarms down
- A reviewer can fix a value, overrule a row, decide the result, ask for a second look, hand over, or run it again
- Every change is logged with who and when

Visual: Needs review folder + Other options menu.

---

## Slide 11 - It learns from the team

**Corrections become rules, with an admin in control**

- Staff edits to drafts and corrections to results are stored as diffs
- The system groups them into proposed knowledge base changes, for example "add alias PORT KELANG = Port Klang, seen in 5 corrections"
- Admin clicks Add or Reject. Only approved items are used, and every item has history
- Approved items apply on the next run: aliases before comparison, reply lines in drafts

Visual: Learning report with Add / Reject buttons.

---

## Slide 12 - Built for a first-time user

**No shipping knowledge needed**

- The first thing you see is a plain sentence, not a table. Detail is one click away
- **Avery**, a hover guide: rest the mouse on anything and he says what it is and what clicking does
- No AI at runtime, every line is a hard-coded template filled from live state, so he cannot invent facts
- 1,017 UI tests check that every key has a line and that lines follow the real state

Visual: Avery's poses + the simple answer card.

---

## Slide 13 - Results

**Perfect score on the organisers' own scorer**

| Metric | Score |
|---|---|
| Final `/submit` score | **1.0000** |
| Classification macro-F1 | 1.0000 |
| Defect-field F1 | 1.0000 |
| Defects caught end to end | 46 / 46 |
| Escalation F1 | 1.0000 |

- Identical on the 80% tuning split and the 20% held-out split
- 163 backend tests + 1,017 UI guide tests
- Run log: 0.9738 -> 1.0000 after fixing a garbled PDF font label
- **Honest caveat:** the dataset is synthetic and regular. Generalisation is argued by tests on unseen variants, not proven on a second dataset

Visual: the score table, plus the run log chart 0.97 -> 1.00.

---

## Slide 14 - Challenges faced

**Four things that nearly broke it**

- **Garbled PDF fonts.** "TOTAL Gross WeightII(KGS)" came out mangled and 6 cases escalated wrongly. Fixed with a label-meaning matcher instead of exact label text
- **Scans have no text layer.** Added OCR, but scans are always escalated and OCR values are shown as proposals, never as facts
- **Format differences look like errors.** "22,000 KGS" vs "22000 kg" would be a false alarm. Normalisers for units, container formats, ports and party names, with KB aliases checked first
- **Free hosting limits.** No lasting storage, short run time, OCR libraries too big. Solved by pre-computing the seed for the public copy and running the full app in Docker

Visual: before / after of the garbled label.

---

## Slide 15 - Impact

**The team reviews exceptions, not every BL**

- 220 comparison cases: **154 clean, 46 mismatches flagged, 20 escalated**
- About [X]% of cases need no human at all
- [X] seconds per case vs about [X] minutes by hand
- Every mismatch arrives with its proof and a drafted reply
- Analytics shows which shipping line and which field cause the most errors, so the problem can be fixed at the source

Visual: KPI tiles from the Analytics page.

---

## Slide 16 - Future roadmap

**Now / Next / Later**

- **Now (finals):** live Gmail or Outlook ingest, real sign-in, LLM paths exercised with a key on every run
- **Next:** more fields (HS code, marks and numbers, seal numbers), multilingual BLs, Postgres and a real job queue
- **Later:** connect to SAP and carrier portals, roll out to other RGE business units, track outcomes after the reply is sent to measure real savings

---

## Slide 17 - Thank you

- **DocSync** - Your shipping desk's co-pilot
- Live demo: [link]
- GitHub: [link]
- Team: [names and contact]

---

## Appendix slides (optional, keep at the back)

- Full architecture diagram
- Requirement to implementation table from README.md
- Security hardening for the public demo
- Known limitations, stated plainly
