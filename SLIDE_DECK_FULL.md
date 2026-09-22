# DocSync - full slide deck content
One short line per point. Text in `[ ]` needs a real figure or the word "estimate".

---

## 1. Title
- **DocSync**
- Your shipping desk's co-pilot
- Team [name] · Averis x Monash Hackathon 2026

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
- Reads the same fields all day, easy to miss a digit

**Exporter**
- Pays amendment fees and waits on delayed cargo

**Shipping line**
- Extra rounds of corrections on every draft

One line: caught at the draft it is a reply, caught later it is a cost.

## 5. The cost today
- [X] minutes to check one draft by hand
- [X] drafts a month across the desk
- [X] hours a month spent comparing 7 fields
- RM [X] per amendment when an error slips through

## 6. Why now
- AI document reading is cheap and accurate enough
- OCR finally works on ordinary scans
- Cloud hosting costs near zero at this volume
- This was not buildable at this price two years ago

## 7. What DocSync is
- An inbox that checks the documents for you
- Sorts the mail, reads both documents, compares 7 details
- Says what is different in one plain sentence
- Shows the proof and writes the reply
- Asks a person whenever it is not sure

## 8. Technical architecture
- Six steps: ingest, classify, completeness, extract, compare, route
- Each step can be retried on its own
- A failure is shown, never hidden

## 9. Implementation details
- Backend: Python, FastAPI, SQLite
- Frontend: React, TypeScript, Tailwind
- Reads text, PDF, Excel, Word and scans
- Cleans weights, containers, ports and company names before comparing
- Every value keeps its source location

## 10. How AI is used
- Rules where it must be exact: labelled documents and value comparison
- AI where it is messy: unclear emails, odd layouts, team corrections, report summaries
- If the AI is unavailable, the rules still finish the check

## 11. USP 1: proof, not just a verdict
- One sentence says what is wrong
- Only the differing part is marked
- One click shows both documents side by side

## 12. USP 2: tags and routing
- Auto tags: shipping line, customer, port
- Tags work as filters in any folder
- Rules send emails to the right person, with a backup

## 13. Humans stay in charge
- It never guesses
- Four reasons to ask a person: missing file, unreadable file, wrong document, blank value
- Fix a value, overrule, ask for a second look, hand over, re-run
- Every change is logged

## 14. It learns from the team
- Corrections and reply edits are saved
- Grouped into suggested rules
- Nothing is used until an admin approves

## 15. Built for first-time users
- A plain sentence first, not a table
- One main button per email
- **Avery**, the guide in the corner, explains every button in plain words

## 16. How we compare
| | Manual | Generic OCR | Big shipping software | DocSync |
|---|---|---|---|---|
| Cost | staff time | low | high | low |
| Knows shipping wording | yes | no | yes | yes |
| Shows the proof | n/a | no | rarely | yes |
| Asks a person when unsure | n/a | no | no | yes |
| Set-up time | none | days | months | hours |

## 17. Results
- 520 emails sorted
- 220 check requests found
- 129 drafts compared: 63 clean, 46 with mistakes
- All 46 mistakes caught
- 20 unclear cases sent to a person, with the reason
- Score 1.00 on the organisers' own scorer
- 163 backend tests, 1,017 interface tests

## 18. Challenges we hit
- Garbled PDF fonts hid a label, so we made the matching tolerant
- Scans have no text, so we added OCR and always send scans to a person
- Format differences looked like errors, so we added normalisers
- Free hosting has limits, so the full app runs in a container

## 19. Risks and mitigations
| Risk | What we do |
|---|---|
| Tested only on synthetic data | Pilot in shadow mode against human checks first |
| A false alarm wastes staff time | Unsure is never a mismatch, and precision is tracked |
| Poor scans misread | Scans always go to a person, OCR values are proposals |
| Staff do not trust the AI | Every verdict shows the proof and can be overruled |
| AI service goes down | Rules still finish the check without it |
| Real inbox is messier | Knowledge base learns aliases from corrections |

## 20. Metrics we would track in a pilot
- Share of cases handled with no human
- False alarm rate
- Mistakes caught before the BL is finalised
- Minutes per check, before and after
- Amendments avoided per month
- Corrections per 100 cases, falling over time

## 21. Impact
- The team reviews exceptions, not every document
- Every mistake arrives with proof and a ready reply
- Reports show which shipping line and which detail cause the most errors
- [Time saved per check: measure or mark as estimate]

## 22. Market size
- **TAM:** exporters and freight forwarders handling BLs in Malaysia [verify]
- **SAM:** RGE group companies and Malaysian container exporters
- **SOM:** the Averis shipping desk, [X] staff, [X] drafts a month

## 23. Business model
- Internal first: a shared service inside Averis, no per-seat licence
- Then: other RGE business units at cost
- Later: licensed to freight forwarders per mailbox or per document checked
- Running cost: one container that scales to zero, plus AI usage

## 24. The loop that pays for itself
- DocSync at the centre
- Docs team corrections feed the knowledge base
- The knowledge base cuts false alarms and raises the auto-handled share
- Exporters get cleaner BLs and fewer fees
- Shipping lines get fewer amendment rounds
- One line: every correction makes the next check better

## 25. Future implementation and expansion
- **Stage 1:** pilot on one desk in shadow mode, measured against human checks
- **Stage 2:** live mailbox, real sign-in, full desk
- **Stage 3:** other RGE business units, separate teams and data
- **Stage 4:** more fields and languages, SAP and carrier portal links, forwarder licensing

## 26. What we are asking for
- A pilot on one real desk
- Access to a sample of real emails, anonymised
- A mentor from the shipping docs team for domain questions

## 27. Thank you
- **DocSync** - Your shipping desk's co-pilot
- Live demo: [link]
- Code: [link]
- Team: [names and contact]

---

## Appendix (keep at the back)
- Full architecture diagram
- Requirement to implementation table
- Security hardening for the public demo
- Known limitations, stated plainly

## To do before presenting
- Slides 10 and 15 describe AI features that only become true once an API key is added
- Fill every `[X]`, or label it "estimate"
- Mascot images are in the `mascot` folder
