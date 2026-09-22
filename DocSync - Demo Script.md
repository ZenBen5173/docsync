# DocSync - 5-minute demo script

About 650 words spoken. Each step says exactly where to go, what to click, and what to say.

---

## Before you start (do this every time)

1. Run the app on **your own computer** and open `http://localhost:5173`. The online copy has no AI key.
2. Top right: check the round picture says **MT** (Maya Tan, admin). If not, click it and pick **Maya Tan**.
3. Left sidebar, bottom: click **Admin**. At the right end of the tab row: click the red **Reset demo data** button, then confirm.
4. Bottom-right corner: check **Avery** has open eyes. If his eyes are closed, click him once to wake him.
5. Left sidebar, top: click **Inbox**. Make the window wide (full screen).
6. Two emails are used. Find them before the demo so you know which row to click. Search tip: type `label:msc status:mismatch` in the top search bar.
   - Mismatch example: `email_499` (sender Guancheng Lee, MSC)
   - Needs-review example: `email_501` (wrong document attached)

---

## The script

### 1 · 0:00-0:20 · The inbox
**Do**
- Be on **Inbox** (left sidebar, first item). Do not click anything yet.

**Say**
> "This is DocSync, our shipping document co-pilot. We designed the interface to feel familiar, similar to an email inbox, so shipping teams can adopt it without learning a completely new workflow. The difference is that every email here has already been read and checked."

### 2 · 0:20-0:40 · Sorting and readable subjects
**Do**
- Move the mouse over **Other mail**, then **Spam** in the left sidebar (point, do not click).
- Move the mouse to the first email row and point at its subject text.

**Say**
> "As emails arrive, DocSync sorts them automatically. Junk and general mail are moved aside, so only document-check requests stay in focus. Shipping subject lines are usually long reference codes, so we generate a readable subject and keep the sender's original beside it."

### 3 · 0:40-1:00 · Avery
**Do**
- Rest the mouse on the **first email row** for one second. Avery's bubble appears bottom-right. Let people read it.
- Then rest the mouse on the **Filter** button (top of the list, next to the refresh arrow). Avery explains it.

**Say**
> "We also built Avery, our in-app guide. When I hover over an email, Avery summarises what the sender is asking for. When I hover over any button, he explains what it does. A one-time onboarding is easy to forget. Avery guides the user while they work."

### 4 · 1:00-1:20 · Status tabs and filters
**Do**
- Click the tabs above the list, one by one: **Needs review**, then **Mismatch**, then **OK**, then back to **Mismatch**.
- Click **Filter**. In the menu, under *Shipping line*, click **MSC**. A small **MSC** chip appears next to the button.

**Say**
> "Results are separated into three clear statuses: OK, Mismatch and Needs review. That lets staff focus on the exceptions and skip the rest. Emails are also tagged automatically by shipping line, customer and arrival port. These tags work as filters in any folder."

### 5 · 1:20-1:50 · Open a mismatch
**Do**
- In the filtered list, click the row from **Guancheng Lee** (`email_499`).
- Point at the red sentence at the top of the card, then at the two values under *Total weight*.

**Say**
> "Let's look at an actual check. The customer's Shipping Instruction is treated as the reference, and DocSync compares the draft Bill of Lading against it across seven required details. Here it found one discrepancy. The customer asked for 40,326 kilograms and the draft says 41,326. Only the differing digit is highlighted."

### 6 · 1:50-2:15 · The proof
**Do**
- Inside the *Total weight* box, click **See where in the documents**.
- Two document pictures open side by side. Point at the highlighted value on the left, then on the right.
- Optional: click **Show them** (next to "6 other details match") to show the full table, then leave it open.

**Say**
> "We don't expect the user to simply trust the result. DocSync shows the original evidence side by side and highlights exactly where each value came from. The user never has to open the files to verify it."

### 7 · 2:15-2:40 · The reply
**Do**
- Scroll down to the reply box under the card. Point at the filled button **Ask for a corrected draft**.
- Click **Read and edit** (the plain button next to it).
- Click at the end of the message, just before "Kindly send us the amended draft", and type exactly:
  `Please quote the BL number in your reply.`
- Click the filled **Ask for a corrected draft** button at the bottom of the editor.
- A "Reply sent" message pops up and the card now says **Done**.

**Say**
> "DocSync also prepares the next action. It has already drafted a correction request listing the discrepancy. I can review it, add a line of my own, and send it from the same screen."

### 8 · 2:40-3:05 · A case that needs a person
**Do**
- Click **Back to the list** (or the back arrow, top left).
- Left sidebar: click **Needs review**.
- Click the email whose card will say the wrong document was attached (`email_501`).
- Point at the amber sentence, then at the file cards below it.

**Say**
> "This case needs a person. The wrong document was attached, and DocSync explains that in plain language. This is a deliberate design choice. A wrong 'OK' is costly, so when DocSync is not certain, it escalates and does not guess."

### 9 · 3:05-3:25 · Staying in control
**Do**
- At the bottom-left of the card, click **Other options**. The menu opens. Move the mouse down the items slowly.
- Press **Esc** to close it. Do not choose anything.

**Say**
> "The user always stays in control. They can correct a value, override the result, ask a teammate for a second look, hand the case over, or rerun the check. Every change is logged."

### 10 · 3:25-3:55 · Learning from the team
**Do**
- Left sidebar, bottom: click **Admin**.
- Click the last tab at the top: **Learning report**.
- Click **Generate now**. Wait a few seconds (keep talking).
- A suggestion card appears: "Please quote the BL number in your reply." Click **Add** on it.
- Click the tab **Knowledge base**. Scroll to *Reply template line* and point at the new item marked **learned**.

**Say**
> "DocSync also learns from the team. It noticed the line I added to my reply and suggests adding it to future replies of the same kind. Once I approve it, it becomes part of the knowledge base. Nothing is applied without an admin's approval, so the system never teaches itself something wrong."

### 11 · 3:55-4:10 · Routing
**Do**
- Still in Admin, click the tab **Routing**.
- Point across one row: the tag, the main person, the backup.

**Say**
> "Routing rules send each shipping line's emails to the person who knows it best, with a backup for when they are away."

### 12 · 4:10-4:45 · The manager's report
**Do**
- Left sidebar, bottom: click **Report**.
- Click the dark button **Update report** (it says **Make report** if no report exists yet). Wait for the four steps to finish.
- Point at the big headline sentence.
- Scroll down slowly through: *What the app found*, *Where the mistakes come from*, *How well the app is doing*, *What the AI costs*.
- Point at **Print or save as PDF** (top right). Do not click it.

**Say**
> "Finally, the manager's report. It opens with a one-sentence summary and then goes into detail. It covers what came in, what DocSync found, and which shipping lines and details cause the most errors. It also covers how often staff corrected the system and what the AI cost. A manager can see what was found and also whether the system can be trusted."

### 13 · 4:45-5:00 · Close
**Do**
- Left sidebar: click **Inbox**. Leave the inbox on screen.

**Say**
> "Without DocSync, staff find the email, open two files, compare seven details by hand, and write a reply. DocSync brings that entire process into one place, while keeping the final decision with the person."

---

## If something goes wrong

- **Avery says nothing:** his eyes are closed. Click him once. He also waits a moment, so keep the mouse still.
- **The suggestion does not appear in step 10:** the reply in step 7 was not sent, or the line was typed differently. Type it exactly as written.
- **"Generate now" is slow:** it is calling the AI. It takes a few seconds. Keep talking.
- **The report looks old:** you did not click **Update report**.
- **Buttons are missing:** you are not Maya Tan. Click the round picture, top right, and pick her.
- **The Filter chip is still on:** click the small x on the chip.
- **Something is left over from a rehearsal:** Admin, right end of the tab row, **Reset demo data**.
