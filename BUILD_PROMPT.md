# Build brief: Shipping Document Verification Inbox (Averis x Monash Hackathon 2026)

You are the lead engineer building a working product end to end. Read this whole brief before writing code. Work autonomously: make reasonable decisions, state assumptions in `DECISIONS.md`, and keep going. Do not stop at a plan or a scaffold. The goal is a running, demo-ready app plus a scored submission file.

Hard deadline: preliminary submission is Tue 22 Sep 2026, 12:00 PM (MYT). Prioritise in the order given in "Build phases". A working core beats an unfinished feature list.

---

## 1. Context (why this exists)

- Averis is the shared-services arm of the RGE group. Its shipping docs team handles paperwork for APRIL (paper and pulp exporter).
- Flow in real life: APRIL writes a Shipping Instruction (SI) and sends it to the shipping line. The shipping line drafts a Bill of Lading (BL). The draft comes back by email ("please check"). The docs team compares the BL against the SI and replies "OK to finalize" or "please amend".
- Today this is manual: staff read every email in a mixed inbox, find the check requests, and compare fields by eye. It is slow and errors slip through (amendment fees, customs delays, cargo release problems).
- We are building an AI tool that automates this checking step and keeps a human in control when the AI is unsure.

The SI is the source of truth. The BL is what gets checked.

---

## 2. Inputs (the data)

The dataset is in `[!] Problem Statement/` (zips). Use ONLY the participant bundle `sdoc-hackathon-bundle.zip` (inbox/, attachments/, loader.py, sample_submission.json, README.md) and the Docker server for scoring.

**Local evaluation set:** the Docker zip also contains `data_v2/ground_truth.json` (the answer key). Use it as a labelled dev set for error analysis: build `eval.py` that compares our output to it and prints per-category, per-status, per-field and per-review_reason precision/recall plus a list of every wrong email with our answer vs expected. Use this to find and fix root causes.
Rules so the system still generalises to new or real emails (finals may use a different set):
- The pipeline must never read `ground_truth.json` at runtime or hardcode answers per email_id. Only `eval.py` reads it.
- Do not read the generator scripts (`generate.py`, `shipment.py`, `pools.py`, `edgecases.py`, `emails.py`, `render.py`); fitting to the generator overfits.
- Fix general logic (parsers, normalisers, prompts, thresholds), not individual cases. Hold out a random 20% of emails as a test split you do not tune on, and report both scores.

Email record (JSON):
```json
{
  "email_id": "email_004",
  "from": "docs@vitalsolutions.sg",
  "subject": "REQUEST BL DRAFT _ PO 26067_ COATED IVORY BOARD__138MT",
  "body": "Hi Mitchelle, Attached are the SI and draft BL ...",
  "attachments": ["attachments/email_004_SI.txt", "attachments/email_004_BL.txt"]
}
```

Facts about the data:
- About 520 emails. Most have no attachments. SI and BL arrive together in the same email when attached.
- Attachment formats: .txt (most), .pdf (some may be image-only scans), .xlsx, .docx. Some files may be empty, truncated or corrupted.
- Bodies contain forwarded threads, signatures and external-sender banners. Subjects can be coded (e.g. carrier, BL number, customer) or misleading.
- The SI and BL label the same field differently (e.g. "Port of Loading" vs "Load Port", "Consignee" vs "To the Order of", "Gross Weight (KG)" vs "Gross Wt (kgs)"). Align by meaning, not label.

Access:
- `from loader import Inbox; inbox = Inbox("<bundle folder>")` or `Inbox("http://localhost:8080")`
- Docker server: `docker compose up --build` then `GET /emails`, `GET /emails/{id}`, `GET /attachments/{path}`, `GET /sample_submission`, `POST /submit`.
- If `GET /health` shows 0 emails, the folder is in a path Docker cannot mount; move it under the home folder.

---

## 3. Required output (for scoring)

One JSON object keyed by `email_id`, every email present, exact shape of `sample_submission.json`:
```json
"email_004": {
  "category": "BL_COMPARISON",
  "status": "MISMATCH",
  "review_reason": null,
  "has_defect": true,
  "defect_fields": ["container_count"]
}
```
- `category`: `BL_COMPARISON` | `SI_REQUEST` | `INVOICE_QUERY` | `GENERAL` | `SPAM`
- `status`: `OK` (all 7 match) | `MISMATCH` (1 or more differ) | `NEEDS_REVIEW` (cannot decide)
- `review_reason` (only when NEEDS_REVIEW): `wrong_doc_type` | `missing_attachment` | `unreadable` | `missing_value`
- `has_defect` true only for MISMATCH; `defect_fields` lists exactly the mismatched fields.
- Non-comparison emails: status OK, has_defect false, defect_fields [].
- A blank value (`???`, `____`, `TBA`), an unreadable scan, a missing BL, or a second attachment that is not a BL (invoice, packing list, certificate of origin) is NEEDS_REVIEW, never MISMATCH.

Scoring: 50% end-to-end defects caught, 30% classification macro-F1, 20% defect-field F1. NEEDS_REVIEW handling is scored separately as reliability. False alarms hurt. Precision matters as much as recall.

The 7 fields: `shipper, consignee, notify_party, port_of_loading, port_of_discharge, container_count, gross_weight_kg`.

---

## 4. Core pipeline

Build as clear, separately testable stages. Each stage writes its result, confidence and evidence to the database so the UI can show it and a failed stage can be retried alone.

1. **Classify** email into the 5 categories with a confidence score. Use subject, body (strip signatures, banners, quoted threads) and attachment signals together. Do not treat "has attachments" as proof of BL_COMPARISON.
2. **Completeness check** for BL_COMPARISON: are both SI and BL present, readable and the right document types? If not, NEEDS_REVIEW with the right reason. A BL_COMPARISON email with no attachments at all is a request that is still waiting for the draft: decide consistently and record the reasoning in DECISIONS.md (check what `/submit` rewards).
3. **Extract** the 7 fields from each document, with per-field confidence and source location:
   - txt: text plus line numbers
   - pdf: text layer with word bounding boxes (PyMuPDF or pdfplumber). If there is no text layer, OCR (Tesseract with boxes) and/or a vision LLM.
   - xlsx: openpyxl, keep sheet and cell address
   - docx: python-docx, including tables and bilingual labels
   - Use an LLM with a strict JSON schema for field mapping, but keep a deterministic parser path where it is reliable. Store the raw value AND the location it came from.
4. **Normalise and compare**:
   - Numbers: strip units, commas, "KGS"/"kg"; compare numerically (define a small tolerance and document it). Containers: parse "3 x 40HC", "THREE (3)" etc.
   - Ports: normalise case, punctuation, country suffixes, known variants (e.g. Port Klang / Port Kelang). Optionally validate against UN/LOCODE.
   - Parties (shipper, consignee, notify): compare the company identity, not the address formatting. Handle "TO ORDER" / "To the Order of" semantics carefully.
   - Consult the knowledge base (aliases) before calling a mismatch.
   - Output per field: match / mismatch / unsure, with a reason.
5. **Route by confidence**: high confidence goes straight to the result. Low confidence or any unsure field goes to the review queue with the reason and evidence. Thresholds are configurable in Admin.
6. **Export** `submission.json`, run `eval.py`, and call `/submit`. Save every scoreboard to `runs/` with a timestamp and a short note on what changed.

Robustness: every stage wrapped in error handling. A failure marks the case `FAILED` with the error message, never crashes the batch, and can be retried from the UI or CLI. Cache LLM calls by content hash so re-runs are fast and cheap. Process emails concurrently with a sensible limit.

LLM: make the provider configurable via env vars (`LLM_PROVIDER`, `LLM_MODEL`, API key). Use structured JSON output. Temperature 0. The pipeline must still run (with lower accuracy) using only deterministic parsers if no key is set.

---

## 5. Product features

### USP 1: Evidence screenshots
- For each of the 7 fields, show the SI snippet and the BL snippet side by side, with the value highlighted.
- PDF and scans: render a cropped PNG of the region around the value's bounding box, with a highlight rectangle.
- txt / xlsx / docx: render the surrounding lines, cell range or table row as a styled snippet with the value highlighted (and the cell address or line number).
- Clicking a mismatch row opens the evidence immediately. The goal: a reviewer never has to open the documents and hunt.

### USP 2: Tagging and grouping (Gmail-style labels)
- Auto-tags: shipping line (carrier, from the BL or subject), customer/sender, port of discharge, category, status.
- Custom tags created by staff.
- Tags can be assigned to employees, so each person works their own carrier's or customer's queue.
- Filter and search by tag, e.g. `label:maersk status:mismatch`.

### Admin center
- Labels and auto-tag rules (conditions such as "carrier contains X" or "sender domain is Y" apply tag Z).
- Routing: tag to employee or team, with a backup person.
- Team and roles: admin, reviewer, viewer (a simple role switcher is fine for the demo, no real auth needed).
- Confidence thresholds for auto vs review, per field and per document type.
- Knowledge base editor (see Learning loop).
- Changing a rule should re-tag and re-route existing cases live.

### Human review
- Review queue with the reason, evidence and AI's proposed values.
- Reviewer can confirm, correct a field value, change the verdict, or change the category. The report updates immediately and the correction is logged.

### Auto-draft replies
- For every checked case, draft a reply to the sender:
  - OK: "BL checked against SI, OK to finalize."
  - MISMATCH: list each field with the SI value and the BL value and ask for amendment.
  - NEEDS_REVIEW: ask for the missing or readable document.
- Draft appears in a Gmail-style reply box. Staff edit and "Send" (simulated send, stored in a Sent folder).

### Learning loop (from staff edits)
- When staff edit a draft or correct a result, store the diff (AI version vs final version) with the case context.
- An end-of-day job (also a "Generate now" button) uses the LLM to group the diffs into proposed knowledge base changes, e.g. "Add alias PORT KELANG = Port Klang (seen in 5 corrections)", "Add booking number to mismatch reply template".
- Admin sees a "Daily learning report" with Add / Reject per suggestion. Only approved items enter the knowledge base. Approved items are used on the next run (alias lookup before comparison, and similar past corrections injected as examples into prompts).
- Knowledge base items can be viewed, edited and removed in Admin. Keep a history.

### AI analytics (manual trigger)
- "Analyze" button with filters (date range, tag, carrier, customer).
- Computes metrics and asks the LLM for a short plain-language report: error hotspots by carrier/customer, most common mismatch fields, workload per staff member, review queue size and time to resolve, auto vs review rate, correction rate over time, suggested threshold or rule changes.
- Charts plus the written summary. Export as PDF or markdown.

### Error handling and retry
- Failed cases appear in a "Failed" folder with the error. Retry per case, per stage, or in bulk.

### Optional, only if everything else is done
- Live Gmail connection (Gmail API, read-only ingest plus drafts). Keep it behind a feature flag.

---

## 6. UI: imitate Gmail's layout and interaction as closely as possible

Copy Gmail's structure, density, spacing and interactions. Use our own product name, logo and colours, not Google's branding or logo. Working name: pick something short (e.g. "DocCheck") and make it easy to rename.

**Global layout**
- Top bar: hamburger, logo, large rounded search bar with filter dropdown (supports `from:`, `label:`, `status:`, `category:`), help, settings gear, role/avatar switcher.
- Left sidebar (collapsible):
  - Primary button (Gmail "Compose" position): "Run pipeline" / "Refresh inbox" with progress.
  - Folders with counts: Inbox, Assigned to me, Needs review, Mismatch, OK, Failed, Sent, All mail, Spam.
  - Categories: BL check, SI request, Invoice query, General.
  - Labels section with coloured dots, "+" to create, click to filter.
  - Bottom: Analytics, Admin.
- Inbox tabs above the list (Gmail Primary/Social/Promotions style): "Cases", "Other", "Spam".

**Email list**
- Gmail row design: checkbox, star, sender, bold unread subject + grey snippet, attachment icon, date on the right.
- Extra chips on each row: category, status (OK green / Mismatch red / Review amber / Failed grey), confidence %, label chips, assignee avatar.
- Hover actions on the right: assign, label, retry, archive, mark read.
- Toolbar when rows are selected: bulk label, assign, retry, archive. Pagination "1-50 of 520".
- Keyboard shortcuts like Gmail: j/k to move, o/Enter to open, u back to list, l label, e archive, / search.

**Opened email (most important screen)**
- Gmail thread view: subject, labels, sender line, body (collapse quoted text and signatures), attachment chips (click to preview the file).
- Directly below the body, a "Verification" card:
  - Header: overall verdict, confidence, carrier, assignee.
  - 7-row table: Field | SI value | BL value | result icon | confidence. Mismatch rows red, unsure rows amber.
  - Click a row to expand the evidence screenshots side by side (SI left, BL right).
  - Actions: Confirm, Correct (inline edit), Send to review, Retry, Reassign.
  - Review reason banner when NEEDS_REVIEW.
- Bottom: Gmail-style reply box pre-filled with the auto-draft, with Edit and Send.

**Other screens**
- Admin: Gmail Settings style (tabs across the top): Labels and rules, Routing, Team, Thresholds, Knowledge base, Learning report.
- Analytics: filter bar, Analyze button, KPI tiles, charts, AI summary.

Live updates: the list and counts update as the pipeline processes (SSE or websockets). Toasts like Gmail's bottom-left "Conversation archived. Undo".

Polish: responsive down to laptop width, light mode first (dark optional), empty states, loading skeletons, no layout jumps.

---

## 7. Suggested stack (change only with a good reason, and log it in DECISIONS.md)

- Backend: Python 3.11, FastAPI, SQLite (SQLModel or SQLAlchemy), background worker (asyncio tasks are fine).
- Parsing: PyMuPDF, pdfplumber, openpyxl, python-docx, pytesseract (+ Tesseract binary) or a vision LLM for scans, rapidfuzz for fuzzy matching.
- Frontend: React + Vite + TypeScript + Tailwind, TanStack Query, a small chart library (Recharts).
- One command to run everything (`make dev` or `docker compose up`), plus a CLI: `python -m app.pipeline run --source <bundle or url> --submit`.

---

## 8. Build phases (in this order, each must work before moving on)

1. Pipeline on .txt pairs + classifier. Export submission. Call `/submit`. Record the score.
2. PDF / xlsx / docx / scanned extraction. Normalisation and aliases. NEEDS_REVIEW reasons. Iterate with `eval.py` and `/submit` until the score plateaus on the held-out split. Inspect every mistake category, fix root causes, not individual emails.
3. Confidence scores, routing, review queue, retry.
4. Gmail-style UI: inbox, thread view with Verification card and evidence screenshots, tagging and labels.
5. Admin center, auto-draft replies, learning loop with Add/Reject.
6. AI analytics.
7. Optional Gmail integration.

---

## 9. Definition of done

- `submission.json` for all emails, scored via `/submit`, best score and its run log saved in `runs/`.
- App runs locally with one command, seeded with the dataset, all screens reachable and working.
- A 3-minute demo path works end to end: open inbox, see tagged cases by carrier, open a mismatch, see SI vs BL evidence crops, edit and send the draft, open Admin and approve a learning suggestion, re-run and see it applied, run Analytics.
- `README.md`: setup, run, architecture diagram, how each requirement is met, known limitations.
- `DECISIONS.md`: assumptions, thresholds, tolerance rules, and why.
- Tests for normalisers and the comparison logic (units, ports, container formats, party names).

## 10. Working style

- Before each phase, write a short plan in DECISIONS.md, then build it.
- After each change that affects accuracy, re-run `/submit` and log the score. Never trade precision for recall blindly.
- When a result is ambiguous, prefer NEEDS_REVIEW with a clear reason over guessing MISMATCH.
- Keep code modular: `ingest/`, `classify/`, `extract/`, `compare/`, `kb/`, `api/`, `web/`.
- If something in this brief conflicts with what the data or `/submit` shows, trust the data, and note it in DECISIONS.md.
