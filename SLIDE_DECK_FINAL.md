# DocSync - final slide deck content
24 slides. One short line per point. Text in `[ ]` needs a real figure or the word "estimate".

---

## 1. Title
- **DocSync**
- Your shipping desk's co-pilot
- Team [name] · Averis x Monash Hackathon 2026 · [members]

## 2. Meet the team
- [Name] - [what they built]
- [Name] - [what they built]
- [Name] - [what they built]
- [Name] - [what they built]

## 3. The problem
**Buried in the inbox**
- Check requests sit among invoices, updates and spam

**Checked by eye**
- Staff compare 7 fields across two documents, every shipment

**Same detail, different label**
- One says "Port of Loading", the other says "Load Port"

**Mistakes cost later**
- Amendment fees, customs holds, delayed cargo

## 4. Who it affects
**Docs team**
- Repetitive reading, easy to miss a digit

**Customer**
- [fees / delays, confirm with your team]

**Shipping line**
- Back and forth on every draft

One line: caught at the draft it is a reply, caught later it is a cost.

## 5. The cost today, and why now
**What it costs today**
- [X] minutes to check one draft by hand
- [X] drafts a month across the desk
- RM [X] per amendment when an error slips through

**Why this is solvable now**
- AI document reading is cheap and accurate enough
- OCR finally works on ordinary scans
- Cloud hosting costs near zero at this volume

## 6. What DocSync is
- An inbox that checks the documents for you
- Sorts the mail, reads both documents, compares seven details
- Says what is different, in one plain sentence
- Shows the proof and writes the reply
- Asks a person whenever it is not sure

## 7. Technical architecture
- Six steps: ingest, classify, completeness, extract, compare, route
- Each step can be retried on its own
- A failure is shown, never hidden

## 8. Implementation details
- Backend: Python, FastAPI, SQLite
- Frontend: React, TypeScript, Tailwind
- Reads text, PDF, Excel, Word and scans
- Cleans weights, containers, ports and company names before comparing
- Every value keeps its source location

## 9. How AI is used
- Rules for what must be exact: reading labelled documents and comparing values
- AI for what is messy: unclear emails, odd document layouts, the team's corrections, report summaries, Avery's email previews
- If the AI is unavailable, the rules still finish the check

## 10. What makes DocSync different
**Proof, not just a verdict**
- One sentence says what is wrong, and only the differing part is marked
- One click shows both documents side by side

**Tags and routing**
- Auto tags: shipping line, customer, port
- Tags work as filters in any folder
- Rules send emails to the right person, with a backup

## 11. Built for the people using it
**Humans stay in charge**
- Never guesses. Four reasons to ask a person: missing file, unreadable file, wrong document, blank value
- Fix a value, overrule, ask for a second look, hand over, re-run. Every change is logged

**It learns from the team**
- Corrections and reply edits are grouped into suggested rules
- Nothing is used until an admin approves

**Easy on day one**
- A plain sentence first, one main button per email, readable subject lines
- **Avery**, the guide in the corner: previews what is inside an email, and explains every button in plain words

## 12. How we compare
| | Manual | Generic OCR | Big shipping software | DocSync |
|---|---|---|---|---|
| Cost | staff time | low | high | low |
| Knows shipping wording | yes | no | yes | yes |
| Shows the proof | n/a | no | rarely | yes |
| Asks a person when unsure | n/a | no | no | yes |
| Set-up time | none | days | months | hours |

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
- Garbled PDF fonts hid a label, so we made the matching tolerant
- Scans have no text, so we added OCR and scans always go to a person
- Format differences look like errors, so we added normalisers

## 16. Risks and mitigations
| Risk | What we do |
|---|---|
| Sample mail may not match a real inbox | Tested on 30 new-style emails an AI wrote, and a pilot would run in shadow mode first |
| A false alarm wastes staff time | Unsure is never a mismatch, and precision is tracked |
| Poor scans misread | Scans always go to a person, OCR values are proposals |
| Staff do not trust the AI | Every verdict shows the proof and can be overruled |
| AI service goes down | Rules still finish the check without it |
| New wording and layouts | The knowledge base learns aliases from corrections |

## 17. Metrics we would track in a pilot
- Share of cases handled with no human
- False alarm rate
- Mistakes caught before the BL is finalised
- Minutes per check, before and after
- Amendments avoided per month
- Corrections per 100 cases, falling over time

## 18. Impact
- The team reviews exceptions, not every document
- Every mistake arrives with proof and a ready reply
- Reports show which shipping line and which detail cause the most errors
- [Time saved per check: measure or mark as estimate]

## 19. Market size
- **TAM:** exporters and freight forwarders handling BLs in Malaysia [verify]
- **SAM:** RGE group companies and Malaysian container exporters
- **SOM:** the Averis shipping desk, [X] staff, [X] drafts a month

## 20. Business model
- Internal first: a shared service inside Averis, no per-seat licence
- Then: other RGE business units at cost
- Later: licensed to freight forwarders per mailbox or per document checked
- Running cost: one container that scales to zero, plus AI usage

## 21. The loop that pays for itself
- DocSync at the centre
- Docs team corrections feed the knowledge base
- The knowledge base cuts false alarms and raises the auto-handled share
- Exporters get cleaner BLs and fewer fees
- Shipping lines get fewer amendment rounds
- One line: every correction makes the next check better

## 22. Future implementation and expansion
- **Now:** live mailbox, real sign-in
- **Next:** more details to check, more languages
- **Later:** other RGE business units, connect to company systems, measure real savings

## 23. Conclusion
- Finds the check requests, compares the seven details, shows the proof
- Never guesses, always asks a person with a reason
- Learns from the team, with an admin in control

## 24. Thank you
- **DocSync** - Your shipping desk's co-pilot
- Live demo: [link] · Code: [link] · Team: [names]

---

## Appendix (keep at the back)
- Full architecture diagram
- Requirement to implementation table
- Security hardening for the public demo
- Known limitations, stated plainly

## To do before presenting
- Slides 9 and 11 are true now: the AI is switched on locally and Avery's email preview is built
- Demo the Report page and any AI feature from your own computer. The online copy has no AI key
- Slide 14 numbers come from `var/stress_test.py` (batch C). Say "new-style test mail", not "real mail"
- Fill every `[X]`, or label it "estimate"
- Images of Avery are in the `mascot` folder
