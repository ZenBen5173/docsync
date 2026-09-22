# DocSync slide deck

Text in `[ ]` needs filling in.

---

## 1. Title
- DocSync: your shipping desk's co-pilot
- Team [name] · Averis x Monash Hackathon 2026 · [members]

## 2. The problem
- One inbox, many kinds of mail
- Every draft checked by hand
- Same detail, different label on each document
- A missed mistake costs time and money later

## 3. Who it affects
- Docs team: repetitive reading, easy to miss a digit
- Customer: [fees / delays, confirm with your team]
- Shipping line: back and forth on every draft

## 4. What DocSync is
- An inbox that checks the documents for you
- Sorts the mail, reads both documents, compares seven details
- Says what is different, in one plain sentence
- Shows the proof and writes the reply
- Asks a person whenever it is not sure

## 5. Technical architecture
- Six steps: ingest → classify → completeness → extract → compare → route
- Each step can be retried on its own
- A failure is shown, never hidden

## 6. Implementation details
- Backend: Python, FastAPI, SQLite
- Frontend: React, TypeScript, Tailwind
- Reads text, PDF, Excel, Word and scans
- Cleans weights, containers, ports and company names before comparing
- Every value keeps its source location

## 7. How AI is used
- Rules for what must be exact: reading labelled documents and comparing values
- AI for what is messy:
  - unclear emails
  - odd document layouts
  - the team's corrections
  - report summaries
  - Avery's email previews
- If the AI is unavailable, the rules still finish the check

## 8. USP 1: proof, not just a verdict
- One sentence says what is wrong
- Only the differing part is marked
- One click: both documents side by side

## 9. USP 2: tags and routing
- Auto tags: shipping line, customer, port
- Tags work as filters in any folder
- Rules send emails to the right person, with a backup

## 10. Humans stay in charge
- Never guesses
- Four reasons to ask a person: missing file, unreadable file, wrong document, blank value
- Fix a value, overrule, ask for a second look, hand over, re-run
- Every change is logged

## 11. It learns from the team
- Corrections and reply edits are saved
- Grouped into suggested rules
- Nothing is used until an admin approves

## 12. Built for first-time users
- A plain sentence first, not a table
- One main button per email
- Readable subject lines
- **Avery**, the guide in the corner:
  - uses AI to read the email and preview what is inside
  - explains every button in plain words (written by hand, so always correct)

## 13. Results
- 520 emails sorted
- 220 check requests
- 129 came with documents: 63 clean, 46 with mistakes
- All 46 mistakes caught
- 20 unclear cases sent to a person, with the reason

## 14. Tested on mail it has never seen
- We asked: does it only work on our sample emails?
- Test: an AI wrote 30 brand-new emails and documents in its own words and layouts
- New labels, text tables, free-form letters, untidy forms
- Rules alone: 24 of 30 right. It asked a person on 4, and sorted 2 as the wrong kind
- With the AI helper on: 29 of 30 right
- When it cannot read a layout, it asks a person. It does not guess
- No wrong comparison result in that batch

## 15. Challenges
- Garbled PDF fonts hid a label. Made the matching tolerant.
- Scans have no text. Added OCR, and scans always go to a person.
- Format differences look like errors. Added normalisers.

## 16. Impact
- The team reviews exceptions, not every document
- Every mistake arrives with proof and a ready reply
- Reports show which shipping line and which detail cause the most errors
- [Time saved per check: measure or mark as estimate]

## 17. Roadmap
- Now: live mailbox, real sign-in
- Next: more details to check, more languages
- Later: connect to company systems, measure real savings

## 18. Thank you
- Live demo: [link] · Code: [link] · Team: [names]

---

## To do before presenting
- Slides 7 and 12 are true now: the AI is switched on locally and Avery's email preview is built.
- Demo the Report page and any AI feature from your own computer. The online copy has no AI key.
- Slide 14 numbers come from `var/stress_test.py` (batch C). The test mail was written by an AI, so say "new-style test mail", not "real mail".
- Images of Avery for the slides are in the `mascot` folder.
