// explain(key, ctx) -> { text, theme } | null
//
// Every line Avery can say lives in this file. No AI, no network, no UI framework code: a line is a
// hard-coded template filled from the app's live state (ctx), so Avery can never claim something the app
// does not back up, and it works offline. Unknown key -> null -> Avery stays quiet.
//
// Voice: written for someone using the app for the first time, with no shipping knowledge. Say what the
// thing is FOR and what happens if you use it. Two or three short sentences. Few numbers (the screen
// already shows them). Say so when something cannot be undone, and be honest about limits.
import type { CaseDetail, Counts, FieldResult, Label, Row, User } from "@/lib/api";
import { amountWord, answerFor, canEditRole, FOLDER_BADGE, isAdminRole, rowsThatMatter, STAGE_WORDS, wasCompared } from "@/guide/facts";

export const GUIDE_NAME = "Avery";

export type GuideTheme = "brand" | "ok" | "mismatch" | "review" | "failed" | "neutral";
export type GuideLine = { text: string; theme: GuideTheme };

export type GuideCtx = {
  product: string;
  me?: Pick<User, "id" | "name" | "role">;
  users: Pick<User, "id" | "name" | "role" | "active">[];
  labels: Label[];
  counts?: Pick<Counts, "folders" | "unread" | "pending_suggestions">;
  hosted: boolean;            // the online look-around copy: results pre-computed, edits may reset, no live pipeline
  publicDemo: boolean;
  llm: boolean;               // an AI helper is connected
  running: boolean;           // the pipeline is running right now
  dark: boolean;
  rows: Record<string, Row>;  // emails currently loaded in lists, by id
  openCase?: CaseDetail;      // the email that is open, if any
};

type Maker = (ctx: GuideCtx, arg: string) => GuideLine | null;
const say = (theme: GuideTheme, ...sentences: (string | false | null | undefined)[]): GuideLine =>
  ({ theme, text: sentences.filter(Boolean).join(" ") });

// ------------------------------------------------------------------ plain words for the app's terms
const SI = "the customer's instructions";
const BL = "the shipping line's draft";
const ROLE_CAN: Record<string, string> = {
  admin: "An admin can change everything, settings included.",
  reviewer: "A reviewer can check, correct and reply, but can't change settings.",
  viewer: "A viewer can read everything and do light tidying, like starring an email or tidying it away, but can't correct, reply or change settings.",
};
const FIELD_MEANS: Record<string, string> = {
  shipper: "The shipper is the company sending the goods.",
  consignee: "The consignee is the company receiving the goods.",
  notify_party: "The notify party is whoever gets told when the ship arrives.",
  port_of_loading: "This is the port where the goods go onto the ship.",
  port_of_discharge: "This is the port where the goods come off the ship.",
  container_count: "This is how many containers are being shipped.",
  gross_weight_kg: "This is the total weight, packaging included.",
};
const FIELD_SHORT: Record<string, string> = {
  shipper: "the sending company", consignee: "the receiving company", notify_party: "who gets told on arrival",
  port_of_loading: "the loading port", port_of_discharge: "the arrival port", container_count: "the number of containers", gross_weight_kg: "the total weight",
};
const REASON_MEANS: Record<string, string> = {
  missing_attachment: "a document it needs didn't arrive with the email",
  unreadable: "one of the files couldn't be read reliably",
  wrong_doc_type: "one attachment is a different kind of document, not the draft it needs",
  missing_value: "a detail was left blank, or two values were too close to call",
};
const CATEGORY_NAME: Record<string, string> = {
  BL_COMPARISON: "a document check", SI_REQUEST: "new shipping instructions", INVOICE_QUERY: "an invoice question", GENERAL: "general mail", SPAM: "junk",
};
const an = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);
const firstName = (name?: string) => (name ?? "").split(" ")[0] || "someone";
const cantEdit = (ctx: GuideCtx) => !canEditRole(ctx.me?.role);
const viewerNote = (ctx: GuideCtx) => cantEdit(ctx) && "You're looking around as a viewer, so this is switched off for you. Pick someone else from the round picture at the top right to try it.";
const hostedNote = (ctx: GuideCtx) => ctx.hosted && "On this online copy your change may quietly reset later.";
const details = (n: number) => (n <= 1 ? "one detail" : n === 2 ? "two details" : "a few details");

function labelLine(ctx: GuideCtx, id: string, where: "nav" | "chip"): GuideLine {
  const l = ctx.labels.find((x) => String(x.id) === id);
  if (!l) return say("brand", "A tag that groups emails.", "Click to see every email carrying it.");
  const what = l.group === "carrier" ? `${l.name} is a shipping line, one of the companies that move the containers.`
    : l.group === "customer" ? `${l.name} is who sent the email. The app goes by the sender's address, so treat it as a good guess.`
    : l.group === "pod" ? `${l.name.replace(/^POD\s+/i, "")} is where these goods come off the ship.`
    : `"${l.name}" is a tag your team made, or one that a rule adds automatically.`;
  const none = where === "nav" && !l.count && "No email carries it yet.";
  return say("brand", what, none || (where === "nav" ? "Click to show only emails with this tag, in the folder you're in. Click again to take it off." : "Click to show only emails with this tag. Its colour is just decoration."));
}

function fieldLine(fr: FieldResult | undefined, field: string): GuideLine {
  const means = FIELD_MEANS[field] ?? "One of the seven details that get compared.";
  if (!fr) return say("brand", means, `The app reads it from ${SI} and from ${BL}, then compares the two.`);
  switch (fr.result) {
    case "match": return say("ok", means, "Both documents agree here.", "Click the row to see the exact spot in each one.");
    case "mismatch": return say("mismatch", means, `The two documents disagree here, and ${SI} are the side that counts.`, "Click the row to see both, side by side.");
    case "unsure": return say("review", means, "The app couldn't settle this one alone: the two values are close but not clearly the same, or one of them was hard to read.", "So it's asking a person instead of guessing. Click the row to compare them yourself.");
    case "missing": return !fr.si || !fr.bl
      ? say("review", means, "The app couldn't find this detail in one of the documents.", "It may be missing there, or sit under a heading the app didn't recognise. Click the row to see what it did find.")
      : say("review", means, "One of the documents leaves this blank, so there's nothing to compare.", "That's a question for the sender, not a mistake in the draft. Click the row to see it.");
    default: return say("neutral", means, "It wasn't compared for this email, because both documents are needed first.");
  }
}

function docLine(c: CaseDetail | undefined, name: string, clickable: boolean): GuideLine {
  const d = c?.docs.find((x) => x.name === name);
  const click = clickable && "Click to see the file the way the app read it.";
  if (!d) return say("brand", "A file that came with the email.", click);
  if (!d.readable) return say("mismatch", "The app couldn't open this file, so it can't check anything against it.", "That's why the email was left for a person. A fresh copy from the sender fixes it.");
  const scan = d.method === "ocr" && "It's a scan, so the text was read off a picture and is only treated as a suggestion.";
  if (d.type === "OTHER") return say("review", `The app thinks this is ${an((d.subtype ?? "different document").replace(/_/g, " ").toLowerCase())}, not the draft it needs.`, "So there's nothing to compare yet.", click);
  if (d.role === "SI") return say("ok", `This is ${SI}. The app treats it as the correct version.`, scan, click);
  if (d.role === "BL") return say("brand", `This is ${BL}, the document being checked for mistakes.`, scan, click);
  return say("neutral", "The app couldn't tell what kind of document this is.", scan, click);
}

// ------------------------------------------------------------------ exact keys
const LINES: Record<string, (ctx: GuideCtx) => GuideLine> = {
  "guide:hello": () => say("brand", `Hi, I'm ${GUIDE_NAME}.`, "Rest your mouse on anything and I'll tell you what it is and what it does.", "Click me if you'd rather I kept quiet."),

  // ---- status colours (used by every status chip)
  "status:OK": () => say("ok", `Green means ${BL} says the same as ${SI} on all seven details that get checked.`, "It doesn't vouch for anything beyond those seven. Now and then it simply means there was nothing to compare yet."),
  "status:MISMATCH": () => say("mismatch", `Red means at least one detail on ${BL} differs from what the customer asked for.`, "Open the email to see exactly which one, side by side."),
  "status:NEEDS_REVIEW": () => say("review", "Amber means the app wasn't sure, so it left the decision to a person.", "Usually a file is missing, can't be read, is the wrong kind of document, or has a blank where a value should be."),
  "status:FAILED": () => say("failed", "Grey means the app tripped over this email and couldn't finish checking it.", "That's the app's problem, not the shipment's. Trying again usually sorts it out."),

  // ---- top bar
  "top:menu": () => say("neutral", "Makes the panel on the left wide or narrow.", "Narrow shows icons only, and the tags list hides until you widen it again."),
  "top:logo": (c) => say("brand", `Takes you home to the ${c.product} Inbox.`, "It doesn't refresh or clear anything. It's just the way back."),
  "top:search": () => say("neutral", "Type a word and press Enter to find emails.", "It looks at the sender, the subject and the message, not inside the attached files.", "The sliders on the right show shortcuts like status:mismatch."),
  "top:search:options": () => say("neutral", "Opens a cheat-sheet of search shortcuts.", "Picking one only types it into the box for you. Nothing is searched until you press Enter."),
  "top:help": () => say("neutral", "Opens the list of keyboard shortcuts, like j and k to move through emails.", "It won't explain shipping words. That's my job."),
  "top:theme": (c) => say("neutral", c.dark ? "Switches the whole app back to light colours." : "Switches the whole app to dark colours.", "It's remembered in this browser only, and changes nothing else."),
  "top:admin": (c) => adminLine(c),
  "top:user": (c) => say("brand", `You're acting as ${c.me?.name ?? "a teammate"}, ${an(c.me?.role ?? "reviewer")}.`, ROLE_CAN[c.me?.role ?? "reviewer"], "There's no real sign-in here: click to try the app as someone else."),

  // ---- left panel
  "nav:run": (c) => c.hosted
    ? cantEdit(c) ? say("neutral", "In the full app this re-checks every email from scratch.", "On this online copy the results were worked out beforehand, and as a viewer the button is switched off for you.")
    : say("brand", "In the full app this re-checks every email from scratch.", "On this online copy the results were worked out beforehand, so the button only explains itself.", "Re-checking a single email still works from the list.")
    : c.running ? say("brand", "The app is going through the mailbox right now.", "The list updates by itself as each email gets its result. It can't be stopped halfway.")
    : cantEdit(c) ? say("neutral", "This re-checks the whole mailbox.", viewerNote(c))
    : say("brand", "Reads the mailbox again and re-checks every email from scratch: sorts it, reads the attached documents and compares them.", "It takes a while and can't be stopped halfway.", "Anything a person already corrected or confirmed is kept."),
  "nav:more": () => say("neutral", "Folds the less-used places in or out: failed checks, sent replies, all mail, and the kinds of email.", "A folder with failed checks in it shows by itself, so nothing that needs you stays hidden."),
  "nav:analytics": () => say("brand", "Opens the manager's report: how many checks went fine, where mistakes cluster, and who has the most work.", "If someone built a report earlier, that one shows first and may be out of date.", "Nothing new is worked out until you press Analyze there."),
  "nav:admin": (c) => adminLine(c),

  // ---- the list of emails
  "list:selectall": () => say("neutral", "Ticks every email on this page so you can act on them in one go.", "If some are already ticked, clicking clears the ticks instead.", "It only covers the ones you can see, not the whole folder."),
  "list:refresh": () => say("neutral", "Loads this list again.", "It doesn't look for new mail and it doesn't re-check anything."),
  "list:paging": () => say("neutral", "Emails come a page at a time, newest first.", "The arrows move to older or newer pages."),
  "list:retryfailed": (c) => say("failed", "Runs the check again on every email that failed.", viewerNote(c) || "Safe to press: nothing a person corrected or confirmed is lost."),
  "list:row:select": (c) => say("neutral", "Ticks this email for a group action.", cantEdit(c) ? "As a viewer, the toolbar that appears only lets you tidy emails away or mark them as opened." : "A toolbar appears at the top to tidy, tag, hand over or re-check everything you ticked."),
  "list:row:star": () => say("neutral", "A star is a bookmark the whole team shares.", "Click to add it, and click again to take it off.", "It doesn't change the check and nobody gets a message about it."),
  "list:row:confidence": () => say("review", "The app is less sure than usual about this one, so the number shows up.", "It goes by the shakiest of two things: its guess at what kind of email this is, and the details it managed to compare.", "Low ones turn amber and deserve a second look."),
  "list:row:attachment": () => say("neutral", "This email came with files attached.", "For a document check, those are the two documents that get compared."),
  "list:row:category": () => say("neutral", "What kind of email the app thinks this is.", "Only document-check emails get compared. Everything else is just sorted into the right pile."),
  "list:row:handled": () => say("neutral", "The app couldn't decide this one alone, and a person has already dealt with it.", "It comes back to the waiting line only if a re-check gives a different answer."),
  "list:row:review": () => say("review", "This email is waiting for a person to take a look.", "Either the app wasn't sure what kind of email it is, or a teammate asked for a second pair of eyes."),
  "list:filter": () => say("brand", "Narrows this list by shipping line, customer, arrival port or one of your own tags.", "You stay in the folder you're in, and the filters combine. Pick one from each group."),
  "list:filter:chip": () => say("brand", "A filter that's switched on. Only emails with this tag are shown.", "The small x takes the filter off. The tag itself stays on the emails."),
  "list:filter:clear": () => say("neutral", "Takes every filter off at once and shows the whole folder again."),
  "list:welcome": () => say("brand", "A one-line introduction: the app has already done the comparing, and these are the emails that still need a person.", "The numbers are live. Close it with the x and it stays closed in this browser."),
  "list:welcome:show": () => say("brand", "Opens one email that needs attention, so you can see what an answer looks like.", "It picks a draft with a difference if there's one on this page, otherwise one that's waiting for a decision."),
  "list:welcome:dismiss": () => say("neutral", "Hides this introduction for good in this browser.", "Nothing else changes."),
  "list:empty": () => say("neutral", "Nothing to show here right now.", "That's often good news: an empty waiting line means nothing needs you."),

  // ---- an open email
  "case:back": () => say("neutral", "Back to where you came from.", "Your reply saves itself after a short pause in typing, but fixes you've typed into the check and not saved are lost."),
  "case:archive": (c) => c.openCase?.archived
    ? say("neutral", "This email was tidied away earlier. Clicking brings it back to the Inbox.")
    : say("neutral", "Tidies this email out of the Inbox without deleting it.", "You can undo it from the message that pops up, and it stays findable under All mail."),
  "case:unread": () => say("neutral", "Makes this email look new again and takes you back to the list, as a reminder to return.", "It's one shared flag for the whole team, and it changes nothing about the check."),
  "case:label": (c) => say("brand", "Put a tag on this email, take one off, or type a new name to create one.", "Each tick takes effect straight away.", viewerNote(c)),
  "case:print": () => say("neutral", "Opens your browser's print window for this email and its check.", "To get a PDF, choose 'Save as PDF' there. The app itself sends nothing anywhere."),
  "case:id": () => say("neutral", "This email's reference inside the app.", "Type it into the search box to find the email again. It isn't a shipping number."),
  "case:category": (c) => (c.openCase?.overrides as { category?: unknown } | undefined)?.category
    ? say("brand", `A person filed this as ${CATEGORY_NAME[c.openCase?.category ?? ""] ?? "this kind of email"}.`, "Click to file it under something else. Your choice sticks, even when the mailbox is re-checked.")
    : say("brand", `The app thinks this is ${CATEGORY_NAME[c.openCase?.category ?? ""] ?? "a certain kind of email"}.`, "Click to see how sure it is and why, or to file it under something else.", "Your choice sticks, even when the mailbox is re-checked."),
  "case:category:why": () => say("neutral", "The clues: the exact phrases that pushed the app towards each kind of email, with points.", "What the sender wrote counts most. The subject line counts much less, because old subjects get reused."),
  "case:sender": () => say("neutral", "Who sent this.", "The name is guessed from the address, so only the address in brackets is the real thing."),
  "case:banner": () => say("neutral", "A warning the mail system glued to the top of the email.", "The app sets it aside so it isn't mistaken for the message."),
  "case:message": () => say("brand", "What the sender actually wrote this time.", "The app pays most attention to this part when it decides what kind of email it is."),
  "case:signature": () => say("neutral", "The sender's sign-off, greyed out so it doesn't distract.", "The app ignores it when sorting the email."),
  "case:quoted": () => say("neutral", "Unfolds the sender's sign-off and the older emails quoted underneath.", "The app almost ignores those, because old threads often talk about something else."),
  "case:subject": () => say("neutral", "The subject exactly as the sender wrote it.", "The bigger line above is the app's plain version, put together from the details it read. A full product would let an AI model write it."),
  "case:request": (c) => say("brand", c.openCase?.preview ? "The email in short, written by AI when it came in, so the answer can come first." : "What the sender wrote, folded to one line so the answer comes first.", "Click to read the whole email and see the files that came with it."),
  "case:request:fold": () => say("neutral", "Folds the email back to one line.", "Nothing is lost. It's only tidier."),
  "case:done": () => say("ok", "This one is finished: a reply went out and nothing is waiting for a person.", "Remember that sending is pretend here, so nothing reached the sender."),
  "case:nocheck": (c) => say("neutral", "No document check here, because this isn't a request to check a draft.", cantEdit(c) ? "If the app filed it wrongly, a reviewer or an admin can change the kind. As a viewer you don't get that button." : "If the app filed it wrongly, change the kind at the top. The app notes that so it can learn."),
  "case:sent": () => say("brand", "A reply the team already sent for this email.", "Sending is pretend here: it's saved in the app, and nothing reached the sender."),
  "case:activity": () => say("neutral", "The history of what people decided on this check.", "Tidying away, tagging and hand-overs aren't recorded here."),
  "case:preview:ocr": () => say("review", "This file is a scan, a picture of a page.", "The text below was read off the picture by software, which can get a letter or a digit wrong.", "So unless an admin has chosen to trust clean scans, a person has the last word."),
  "case:preview:unreadable": () => say("mismatch", "The app couldn't get any text out of this file.", "Without it there's nothing to compare, so the email waits for a person. Asking the sender for a fresh copy usually fixes it."),
  "case:preview:rows": () => say("neutral", "The file's text, line by line, exactly as the app read it.", "It's everything in the file, not just the seven details that get compared."),
  "case:preview:open": () => say("neutral", "Opens the untouched file the sender attached, in a new tab.", "Your browser may download it instead of showing it."),

  // ---- the check itself
  "verify:card": (c) => verdictLine(c),
  "verify:confidence": (c) => c.openCase && !wasCompared(c.openCase)
    ? say("review", "Nothing was compared here, so this only shows how sure the app is about what kind of email this is.")
    : say("review", "How sure the app is about this whole result.", "It's the lowest of its scores: how sure it was about the kind of email, and about each detail it compared.", "Rows marked unsure or missing aren't counted, so glance at the rows too."),
  "verify:carrier": (c) => c.openCase?.carrier
    ? say("brand", `${c.openCase.carrier} is the shipping line.`, "The app works that out from the reference number in the email or on the draft, or else from the line's name in the email.")
    : say("neutral", "The app couldn't tell which shipping line this is.", "The check itself isn't affected.", "But emails are mostly handed out by shipping line, so without the tag this one may end up with nobody."),
  "verify:assignee": (c) => {
    const u = c.users.find((x) => x.id === c.openCase?.assignee_id);
    return u ? say("brand", `This email is in ${firstName(u.name)}'s pile.`, "Routing rules in Admin put it there, unless someone handed it over by hand.")
      : say("neutral", "Nobody has this email yet.", "A routing rule in Admin can hand it out automatically, or pick 'Hand to someone else' under 'Other options'.");
  },
  "verify:reason": (c) => (c.openCase?.overrides as { verdict?: unknown } | undefined)?.verdict
    ? say("review", "A person marked this result as undecided, so it wasn't the app that stopped here.", "The reason shown is only a stand-in.")
    : /^AI is not confident/i.test(c.openCase?.review_detail ?? "")
      ? say("review", "The app stopped because it wasn't sure enough about one of the rows below.", "It never turns a doubt like that into a mismatch. It asks a person instead.")
      : say("review", `The app stopped because ${REASON_MEANS[c.openCase?.review_reason ?? ""] ?? "it wasn't confident enough to decide alone"}.`, "It never turns a gap like that into a mismatch. It asks a person instead."),
  "verify:action:confirm": (c) => c.openCase?.resolved && !c.openCase?.needs_human
    ? say("ok", "Already confirmed. A person agreed with this result.")
    : c.openCase?.status === "NEEDS_REVIEW"
      ? say("ok", "Says you've looked and agree with what the app found.", "The email leaves the waiting line, and only comes back if a re-check gives a different answer.", "It doesn't pick OK or Mismatch for you. 'Decide the result yourself' under 'Other options' does that.")
      : say("ok", "Says you agree with this result.", "The email counts as settled by a person."),
  "verify:action:correct": (c) => say("brand", "Lets you fix a value the app misread, or overrule a single row.", "You're fixing what the app read, never the file itself. Overruling even one row settles the whole email.", hostedNote(c)),
  "verify:action:verdict": () => say("brand", "Overrules the whole result in one go, and your decision sticks even if the mailbox is re-checked.", "The reply is rewritten to match, so wording you had edited is replaced.", "'Go back to the app's own answer' in the same menu undoes it."),
  "verify:action:review": () => say("review", "Not sure yourself? This puts the email back in the waiting line for a second pair of eyes.", "Nobody gets a message about it, and it waits there until someone confirms or decides.", "Careful: a verdict a person had set is dropped, so the app's own answer shows again."),
  "verify:action:retry": () => say("brand", "Runs the check on this one email again, reading the documents afresh.", "Anything a person corrected or confirmed is kept. If nothing has changed since, you'll get the same answer."),
  "verify:action:saveanswers": () => say("ok", "Saves your answers. The app works out the result from them and rewrites the reply to match.", "It stays switched off until every question is answered, and the app notes your decision so it can learn."),
  "verify:answer:same": () => say("ok", "Says the two values mean the same thing, so this detail counts as matching.", "Nothing is saved until you press 'Save my answer'."),
  "verify:answer:different": () => say("mismatch", "Says the draft really is different here, so it counts as a mistake and goes into the reply.", "Nothing is saved until you press 'Save my answer'."),
  "verify:files": () => say("review", "The files that came with this email.", "The app needs two to compare: the customer's instructions and the shipping line's draft.", "Click one to see it the way the app read it."),
  "verify:more": (c) => c.openCase && rowsThatMatter(c.openCase).length === 0
    ? say("ok", "Unfolds all seven details side by side.", "Click any row for the proof from both documents.")
    : say("brand", "Unfolds the details that agreed, so you can see all seven side by side.", "Click any row for the proof from both documents."),
  "verify:options": () => say("brand", "Everything else you can do with this email: fix a value, decide the result yourself, ask a teammate, hand it over or run the check again.", "Each one says what it does before you click."),
  "verify:about": () => say("neutral", "Shows the facts behind the answer: the shipping line, whose pile it's in, how sure the app is, the files it read and the history.", "It also adds a 'How sure' column to the table. Your choice is remembered in this browser."),
  "verify:action:reassign": () => say("brand", "Hands this email to someone else.", "A hand-picked person stays put, even when the routing rules change later."),
  "verify:action:save": () => say("ok", "Saves your fixes, and the app notes them so it can learn.", "The verdict and the reply are rebuilt right away, so a reply you had already edited is replaced by a fresh draft."),
  "verify:action:cancel": () => say("neutral", "Closes the editing boxes and keeps everything as it was."),
  "verify:reset": () => say("mismatch", "Throws away everything people did on this email: fixes, the verdict, the kind of email, an edited reply, even who it was handed to.", "It goes back to the app's own answer, and there's no undo."),

  // ---- the reply
  "reply:open": () => say("brand", "Opens the reply in full, so you can read and change it before sending."),
  "reply:preview": (c) => cantEdit(c) ? say("brand", "The reply the app drafted, shown in full.", "Sending is switched off while you look around as a viewer.")
    : say("brand", "The start of the reply the app wrote for you.", "The button sends it as it is. 'Read and edit' opens all of it first."),
  "reply:to": () => say("neutral", "Who the reply goes to: the person who sent the email."),
  "reply:subject": () => say("neutral", "The subject line of your reply. Change it if you like."),
  "reply:badge:ai": () => say("brand", "This is still the app's own draft.", "It comes from fixed wording filled in with this email's details, so it says the same thing every time."),
  "reply:badge:edited": () => say("brand", "Someone changed the wording.", "When it's sent, the app notes what changed so it can suggest better drafts next time."),
  "reply:body": (c) => c.openCase && c.openCase.status === "OK" && !wasCompared(c.openCase)
    ? say("brand", "The reply the app drafted: a short note that the check will happen once the documents arrive.", "Edit it freely before you send.")
    : say("brand", "The reply the app drafted from the check result.", "Edit it freely. If you change the wording, the app notes what you changed, so its drafts can get better."),
  "reply:send": () => say("brand", "Saves this reply in the Sent folder and marks the email as dealt with, so it leaves the waiting line too.", "Nothing really goes out by email: sending is pretend in this app.", "You get a few seconds to undo, but that only removes the saved reply."),
  "reply:restore": () => say("neutral", "Throws away the edits and puts the app's draft back.", "There's no undo, and the draft is shared, so a teammate's changes go too."),
  "reply:discard": () => say("neutral", "Closes the reply and throws away what was typed, for good.", "The app's own draft comes back. Nothing is sent."),

  // ---- admin
  "admin:readonly": (c) => say("review", "You're looking at the settings as someone who isn't an admin, so the settings on these tabs are locked.", c.publicDemo && "One button still works for everyone on this shared demo: 'Reset demo data', which wipes everybody's changes.", "Pick an admin from the round picture at the top right to unlock the rest."),
  "admin:reset": () => say("mismatch", "Puts the whole demo back to how it started: every correction, reply, tag, rule and setting.", "It's shared, so other visitors lose their changes too, and it can't be undone."),
  "admin:labels": () => say("brand", "Every tag in the app.", "The ones marked carrier, customer or pod are added by the app itself: the shipping line and the port mostly from the documents, the customer from the sender's address.", "Only the ones your team made can be recoloured or deleted."),
  "admin:label:delete": () => say("mismatch", "Deletes this tag everywhere.", "It comes off every email, and any rule or routing line that used it goes too. It can't be undone."),
  "admin:labels:create": (c) => say("brand", "Creates a new tag.", "It does nothing by itself: no email gets it until a rule adds it or someone tags by hand.", hostedNote(c)),
  "admin:rules": () => say("brand", "Rules that stick a tag on emails automatically, like 'if the result is a mismatch, add Needs amendment'.", "Every test in a rule has to be true. Saving one re-tags all existing emails at once."),
  "admin:rule": () => say("brand", "One rule, read left to right: its name, the tests an email has to pass, then the tag it gets.", "A faded rule is switched off."),
  "admin:rule:toggle": () => say("brand", "Switches this rule off or on without deleting it.", "Every email is re-tagged straight away, which can also change who it's handed to."),
  "admin:rule:edit": () => say("neutral", "Opens this rule for changes.", "Nothing happens to your emails until you press 'Save and re-tag'."),
  "admin:rule:delete": () => say("mismatch", "Deletes this rule on the first click, with no 'are you sure'.", "Its tag comes off the emails that only had it because of this rule. To get it back you'd build it again."),
  "admin:rules:new": () => say("brand", "Starts a new rule in a form below the list.", "Nothing is saved until you press 'Save and re-tag'."),
  "admin:ruleeditor": () => say("brand", "A rule is a name, one or more tests, and the tag to add when every test passes.", "Some tests need the app's internal words, like MISMATCH for a red result."),
  "admin:ruleeditor:save": () => say("brand", "Saves the rule and applies it to every existing email straight away, not just new ones.", "That can also change who emails are handed to."),
  "admin:routing": () => say("brand", "Decides who gets which emails: 'anything with this tag goes to this person'.", "The first matching line wins, highest priority first. Emails someone handed over by hand are never moved."),
  "admin:routing:new": () => say("brand", "Adds a new line right away, with the first tag and the first person filled in.", "There's no form and no Save button on this page: edit the line afterwards, and each change is live at once."),
  "admin:route": () => say("brand", "One routing line: a tag, the main person, a stand-in, and a priority.", "Every change saves immediately and re-deals all the emails."),
  "admin:route:priority": () => say("neutral", "When an email carries several tags, the line with the bigger number wins.", "It saves when you click away from the box."),
  "admin:route:delete": () => say("mismatch", "Deletes this line on the first click, with no 'are you sure' and no undo.", "Emails that reached someone through it move to the next matching line, or to nobody."),
  "admin:team": () => say("brand", "Everyone on the team and what each person may do.", "Nobody signs in here. It's a pretend team, so you can see the app through different eyes."),
  "admin:team:role": () => say("brand", "Sets what this person may do.", "Admins change everything, reviewers check and reply, viewers only look.", "The last admin can't be demoted, so nobody gets locked out."),
  "admin:team:active": () => say("brand", "Switches a teammate off while they're away, or back on.", "Their routed emails go to the stand-in on each routing line.", "Without a stand-in, they move to the next matching routing line, or to nobody."),
  "admin:team:add": () => say("brand", "Adds a pretend teammate as a reviewer.", "No invitation is sent, and there's no remove button later. You can only switch people off."),
  "admin:thresholds:save": () => say("brand", "Stores the changes on this page.", "They only affect emails checked from now on. Switching tabs before saving loses them."),
  "admin:thresholds:restore": () => say("mismatch", "Puts every setting on this page back to how the app shipped, straight away.", "There's no 'are you sure' and the old values aren't kept."),
  "admin:kb": () => say("brand", "The app's notebook: things your team taught it, like two spellings that mean the same port.", "It looks these up before it calls something a mismatch. Changes apply to emails checked from now on."),
  "admin:kb:add": () => say("brand", "Opens a small form for teaching the app one new thing.", "Nothing is saved until you press Save."),
  "admin:kb:item": () => say("brand", "One thing the app was taught. Mostly it reads: when the app sees the left side, it treats it as the right side.", "The heading above the group says what this kind does.", "The small word at the end says whether it came with the app, was learned from corrections, or was typed in."),
  "admin:kb:item:remove": () => say("mismatch", "Removes this entry right away, with no 'are you sure'.", "It stays in the History list below, but there's no button to put it back. You'd retype it."),
  "admin:kb:history": () => say("neutral", "A running log of the latest changes to the notebook and who made them.", "It's a record only. Nothing can be restored from here."),
  "admin:learning": (c) => say("brand", "Where corrections people made turn into suggestions for the notebook.", c.llm ? "An AI model groups them into suggestions." : "Fixed rules group them, because no AI model is connected.", "Nothing is used until an admin presses Add."),
  "admin:learning:generate": () => say("brand", "Goes through the corrections made since last time and looks for patterns worth remembering.", "Each correction is only looked at once, so there's no redo."),
  "admin:learning:waiting": (c) => say("brand", "How many corrections are waiting to be looked at.", (c.counts?.pending_suggestions ?? 0) > 0 ? "There are also suggestions below waiting for a yes or no." : "Correct a result, or change a reply and send it, then press Generate."),
  "admin:learning:suggestion": () => say("brand", "One idea for the notebook, with the reason behind it and the emails where someone made that correction.", "It changes nothing until an admin presses Add."),
  "admin:learning:add": () => say("ok", "Accepts the idea and puts it in the notebook.", "It's used for emails checked from now on. You can still remove the entry later in the Knowledge base tab."),
  "admin:learning:reject": () => say("mismatch", "Turns the idea down. Nothing is added.", "A decided suggestion can't be reopened, but you can always type the same thing into the notebook by hand."),
  "admin:learning:edits": () => say("neutral", "The raw material: recent changes people made to the app's answers.", "Click one to open that email. 'new' only means it hasn't been through Generate yet."),

  // ---- analytics
  "analytics:filters": () => say("brand", "Choose which emails the report should cover.", "Changing these does nothing by itself. The numbers below only move when you press Analyze."),
  "analytics:analyze": (c) => say("brand", "Builds a fresh report for the filters you chose.", c.llm ? "An AI model writes the summary from the app's numbers." : "The written summary comes from fixed sentences, because no AI model is connected.", c.hosted ? "On this online copy the new report may not reach other visitors and can quietly disappear later." : "The new report replaces the one everybody sees here, filters and all."),
  "analytics:export:md": (c) => say("neutral", "Downloads the report on screen as a plain text file you can paste anywhere.", "It has the summary and the tables, but no charts.", c.hosted && "On this online copy a saved report can go missing. If you get an error page instead, press Analyze again."),
  "analytics:export:pdf": () => say("neutral", "Opens your browser's print window.", "Choose 'Save as PDF' there. The app doesn't create or send a file itself."),
  "analytics:empty": () => say("brand", "No report yet.", "Pick filters if you want, then press Analyze. Nothing is calculated until you ask."),
  "analytics:summary": () => say("brand", "The report in plain sentences: where mistakes cluster, who's busiest, what to try next.", "If the small heading says 'AI summary', an AI model wrote it, so treat the advice as an opinion.", "Otherwise it's assembled from fixed sentences. Either way the numbers are the app's own."),
  "analytics:tile:bl_checks": () => say("brand", "How many emails asked for a document check.", "The small print shows how many of those had both documents and could really be compared."),
  "analytics:tile:auto": () => say("ok", "The share of document checks that didn't end up waiting for a person.", "Be aware that checks a person has already settled count here too, and so does a check that failed."),
  "analytics:tile:mismatch": () => say("mismatch", "Of the drafts that could be compared, the share with at least one wrong detail.", "Emails still waiting for a person count as not wrong here, even when the app suspects a mistake, so the true share may be a little higher."),
  "analytics:tile:overruled": () => say("review", "How often a person had to change what the app decided: a result, a row, a value or the kind of email.", "Low is good. It's the most honest measure of how much you can trust the app."),
  "analytics:tile:saved": () => say("ok", "A rough estimate of the hours saved: the checks that needed no person, times how long one takes by hand.", "It's only as good as the minutes figure below, so put your own in."),
  "analytics:tile:ai": (c) => say("brand", "What the AI has cost so far, as charged by the AI provider.", c.llm ? "Answers are saved, so the same email is never paid for twice." : "No AI is connected right now, so this stays at zero."),
  "analytics:panel:cost": () => say("brand", "The AI bill in detail: what was spent, what one email costs, and which job the money went to.", "The cap is a safety stop. When it's reached the app keeps working on its fixed rules, it just stops asking the AI."),
  "analytics:tile:learned": () => say("brand", "How many of the app's suggestions an admin accepted into its notebook.", "They come from people's corrections. Waiting ones are in Admin, under Learning report."),
  "analytics:minutes": () => say("neutral", "Your own figure for how long one document check takes by hand.", "It's only used for the time-saved estimate, and it's remembered in this browser."),
  "analytics:panel:overruled": () => say("review", "Which details people corrected most often.", "If one detail keeps showing up here, the app reads it badly. A new entry in its notebook usually fixes that."),
  "analytics:panel:ai": () => say("brand", "What the AI actually did: wrote the short email previews, sorted emails the rules weren't sure about, and read documents with odd layouts.", "The comparing itself is always done by fixed rules."),
  "analytics:tile:queue": () => say("review", "How many emails are still waiting for a person.", "Unlike the other tiles, this one counts every kind of email, not only document checks."),
  "analytics:panel:verdicts": () => say("brand", "How the document checks turned out: fine, wrong, waiting for a person, or failed.", "It's a snapshot from the last time Analyze was pressed.", "If someone corrects an email after that, press Analyze again to see it change colour."),
  "analytics:panel:fields": () => say("mismatch", "Which of the seven details go wrong most often, worst first.", "A detail that isn't listed had no mistakes. One bad draft can add to several bars."),
  "analytics:panel:carriers": () => say("mismatch", "The shipping lines with the most wrong drafts, worst first: how many of their drafts were checked and how many came back wrong.", "Only the top few fit, so a line that's missing had fewer mistakes, not zero drafts.", "The line is the app's best guess from the booking number."),
  "analytics:panel:customers": () => say("mismatch", "The same picture, grouped by who sent the email.", "The app goes by the sender's email address, so treat it as a good guess."),
  "analytics:panel:workload": () => say("brand", "How many emails each person has been given, and how many of those still need them.", "Emails that belong to nobody don't show up here at all."),
  "analytics:panel:reasons": () => say("review", "Why emails were left for a person instead of being finished by the app.", "Each email is counted under its main reason only.", "It stays counted after a person confirms it, so these won't always add up to the Review queue tile."),
};

function adminLine(c: GuideCtx): GuideLine {
  const waiting = (c.counts?.pending_suggestions ?? 0) > 0;
  return say("brand", "Opens the settings: tags and rules, who gets which emails, the team, and how careful the checking is.",
    waiting && (isAdminRole(c.me?.role) ? "The app has suggestions waiting, built from people's corrections. None is used until you accept it." : "The app has suggestions waiting for an admin."),
    !isAdminRole(c.me?.role) && `You're ${an(c.me?.role ?? "viewer")} right now, so the settings open read-only.`,
    !isAdminRole(c.me?.role) && c.publicDemo && "Only 'Reset demo data' still works for everyone.");
}

function verdictLine(c: GuideCtx): GuideLine {
  const k = c.openCase;
  if (!k) return say("brand", `This is the check: ${BL} compared with ${SI}, one detail at a time.`, "The customer's side is treated as correct.");
  const a = answerFor(k);
  if (a.done) return say("ok", "This one is finished. The sentence is what the check found, and a reply has gone out.", "Everything stays here in case you want to look again.");
  if (a.step === "confirm" && (k.status === "OK" || k.status === "MISMATCH")) return say("review", "The check has an answer, but someone wants a second pair of eyes on it.", "Look at the details, then say whether you agree. Use 'Other options' if you don't.");
  if (a.kind === "unsure") return say("review", "The app found values that are close but not clearly the same, so it's asking you.", "Answer the question on each block, then press 'Save my answer'.");
  if (a.kind === "undecided") return say("review", "A person marked this one as undecided. The app itself did have an answer.", "When you know the answer, settle it under 'Other options'.");
  if (k.status === "NEEDS_REVIEW") return say("review", "The app stopped short of a result and wants a person to decide.", "The sentence under the headline says why.", a.step === "send" ? "The reply underneath already asks the sender for what's needed." : "'Other options' lets you settle it yourself.");
  const decided = !!(k.overrides as { verdict?: unknown } | undefined)?.verdict && "A person settled this one, and that decision sticks.";
  if (k.status === "OK" && decided) return wasCompared(k)
    ? say("ok", "A person decided this one is fine, and that decision sticks.", "The rows below still show what the app itself found, so they may not all be green.")
    : say("ok", "A person decided this one is fine, even though the app had nothing it could compare.", "That decision sticks.");
  if (k.status === "OK") return wasCompared(k)
    ? say("ok", `The check: all seven details on ${BL} agree with ${SI}.`, "'Show them' unfolds the seven, with proof from both documents.")
    : say("ok", "Nothing to compare yet. This sender is asking for the draft; they haven't sent one.", "It counts as fine until the documents arrive.");
  if (k.status === "MISMATCH") return say("mismatch", `The check: ${BL} disagrees with ${SI} in ${details(k.defect_fields.length)}.`, decided, "Each block shows both values with the difference marked, and the reply underneath already asks for the fix.");
  if (k.status === "FAILED") return say("failed", "The app tripped over this email before it could finish the check.", "The grey text is the technical reason. 'Try again' usually sorts it out.");
  return say("review", "The app stopped short of a result and wants a person to decide.", "The sentence under the headline says why.");
}

// ------------------------------------------------------------------ key families: "family:<arg>"
const FOLDER: Record<string, (c: GuideCtx) => GuideLine> = {
  inbox: () => say("brand", "Everything that's come in and hasn't been tidied away, junk left out.", "The number counts emails nobody has opened yet, junk not included."),
  assigned: (c) => say("brand", `Emails handed to ${firstName(c.me?.name)}, the person you're acting as.`, (c.counts?.folders.assigned ?? 0) === 0 ? "There's nothing in that pile right now." : "Routing rules in Admin decide who gets what, unless someone hands an email over by hand."),
  review: (c) => (c.counts?.folders.review ?? 0) === 0
    ? say("review", "The waiting line for emails the app wasn't sure about.", "It's empty right now: nothing needs a person's decision.")
    : say("review", "The waiting line: emails the app wasn't sure about and left for a person.", "Open one to see why it hesitated, then confirm or correct it."),
  mismatch: (c) => (c.counts?.folders.mismatch ?? 0) === 0
    ? say("mismatch", `Checks where ${BL} disagrees with ${SI}.`, "There are none right now.")
    : say("mismatch", `Checks where ${BL} disagrees with ${SI}.`, "They stay listed here even after someone has replied, so this number doesn't shrink as you work."),
  ok: () => say("ok", "Checks where all seven compared details agreed, plus emails still waiting for a draft, where there was nothing to compare yet.", "OK means no difference was found in those seven, not that the whole document is perfect."),
  failed: (c) => (c.counts?.folders.failed ?? 0) === 0
    ? say("failed", "Emails the app couldn't finish checking.", "None right now: every email made it through.")
    : say("failed", "Emails the app couldn't finish checking because one of its steps broke.", "That's about the app, not the shipment. Open the folder to try them again."),
  sent: (c) => say("brand", "Replies people sent from this app.", (c.counts?.folders.sent ?? 0) === 0 && "None yet.", "Sending is pretend: a reply is saved here, and no real email leaves."),
  other: () => say("neutral", "Real work mail that needs no document check: new shipping instructions, invoice questions, notices.", "The app only sorts and tags these."),
  all: () => say("neutral", "Every email the app knows about, including tidied-away ones and junk.", "Search looks through all of these."),
  spam: () => say("neutral", "Emails the app judged to be junk: prize scams, fake account warnings, adverts.", "It goes by wording and suspicious addresses, so it can be wrong. Nothing here is deleted."),
};
const CATEGORY_NAV: Record<string, GuideLine> = {
  bl: say("brand", `Emails asking the team to check ${BL} against ${SI}.`, "This is the only kind that gets the side-by-side document check."),
  si: say("neutral", "Emails where a customer sends their shipping instructions to get a booking started.", "There's no draft to compare yet, so these are only sorted and tagged."),
  invoice: say("neutral", "Questions about invoices, charges and payments.", "The app files them here but doesn't check any amounts."),
  general: say("neutral", "Everything else that's real work mail: automatic notices, reports, reminders.", "It's also where an email lands when no clue matched."),
};
const LABEL_GROUP: Record<string, GuideLine> = {
  carrier: say("brand", "Shipping lines, the companies that move the containers.", "The app works this out from the booking number on the documents."),
  customer: say("brand", "Who sent the email.", "The app goes by the sender's address, so two companies sharing an address ending look like one."),
  pod: say("brand", "Arrival ports, where the goods come off the ship."),
  custom: say("brand", "Tags your own team made up, plus the ones that rules in Admin add.", "New ones are made in Admin, or from the tag button on an email."),
};
const TABS: Record<string, GuideLine> = {
  cases: say("brand", "Every email in the Inbox that asks for a document check, whatever the result."),
  review: say("review", "Only the checks that are waiting for a person to decide."),
  mismatch: say("mismatch", "Only the checks where the draft is different from what the customer asked for."),
  ok: say("ok", "Only the checks where everything matched, plus emails still waiting for a draft."),
};
const SEARCH_OP: Record<string, GuideLine> = {
  from: say("neutral", "Finds emails from one sender.", "Clicking only types from: into the box. Add part of their address, then press Enter."),
  label: say("neutral", "Finds emails carrying a tag, like a shipping line's name.", "Clicking only types it for you. Add the tag's name, then press Enter."),
  status: say("neutral", "Finds emails by how their check turned out: ok, mismatch, review or failed.", "Mail that needed no check also counts as ok, so add category:bl to see only real checks."),
  category: say("neutral", "Finds emails by kind: bl for document checks, then si, invoice, general or spam."),
  carrier: say("neutral", "Finds emails for one shipping line, such as OOCL or MSC."),
  field: say("neutral", "Finds checks where one particular detail was wrong.", "It needs the app's internal name for the detail, like gross_weight_kg, so copy the example."),
  assignee: say("neutral", "Finds emails handed to one teammate.", "Type part of their name after it."),
  has: say("neutral", "Finds only emails that came with files attached."),
  is: say("neutral", "Finds only emails nobody has opened yet."),
};
const ROW_ACTION: Record<string, (c: GuideCtx, many: boolean) => GuideLine> = {
  assign: (c, many) => say("brand", many ? "Hands every ticked email to one teammate." : "Hands this email to a teammate.", viewerNote(c) || "A hand-picked person stays put, even when routing rules change later."),
  label: (c, many) => say("brand", many ? "Adds a tag to every ticked email, or creates a new one." : "Puts a tag on this email, or creates a new one.", viewerNote(c) || (many && "From here tags can only be added. To take one off, open the email.")),
  retry: (c, many) => say("brand", many ? "Runs the check again on every ticked email." : "Runs the check again on this one email, from its documents.", viewerNote(c) || "Anything a person corrected or confirmed is kept. If nothing has changed since, you'll get the same answer.", !cantEdit(c) && many && c.hosted && "On this online copy it works for a small handful at a time."),
  archive: (_c, many) => many ? say("neutral", "Tidies the ticked emails out of the Inbox without deleting them.", "You can undo it from the message that pops up, and they stay findable under All mail.")
    : say("neutral", "Tidies this email out of the Inbox without deleting it.", "If it was already tidied away, clicking brings it back instead.", "Either way you can undo it from the message that pops up."),
  read: (_c, many) => many ? say("neutral", "Marks every ticked email as opened.", "You can undo it from the message that pops up.", "It's one shared flag for the whole team, and only a reminder.")
    : say("neutral", "Marks it as opened or not.", "It's one shared flag for the whole team, and only a reminder."),
};
const COLUMN: Record<string, GuideLine> = {
  field: say("brand", "The seven details that get compared, one per row, with the shipping word in small print.", "Click a row to see where each value was found."),
  si: say("ok", "What the customer asked for.", "The app treats this side as the truth."),
  bl: say("brand", "What the shipping line wrote on their draft.", "This is the side being checked."),
  result: say("neutral", "The little symbol says whether the two sides agree: a tick, a cross, a question mark or a dashed circle for a blank.", "The app compares meaning, not spelling, so '3 x 40HC' and 'THREE (3)' count as the same."),
  confidence: say("review", "How sure the app is about this one row.", "It drops when a value was hard to read, for example on a scan."),
};
const EVIDENCE: Record<string, GuideLine> = {
  si: say("ok", `The exact spot in ${SI} where the app read this value, highlighted.`, "For PDFs it's a snapshot of the real page, so you don't have to open the file and hunt.", "Click the picture to zoom in."),
  bl: say("brand", `The exact spot in ${BL} where the app read this value, highlighted.`, "Compare it with the left side to see the difference for yourself.", "If it's a picture, click it to zoom in."),
};
const VERDICT_OPTION: Record<string, GuideLine> = {
  OK: say("ok", "Decides that everything matches.", "The drafted reply changes to 'OK to finalize'."),
  MISMATCH: say("mismatch", "Decides that the draft is wrong.", "The reply then asks the sender for a corrected draft and lists the rows marked wrong.", "If no row is marked wrong, the reply leaves a gap for you to fill in."),
  NEEDS_REVIEW: say("review", "Marks the result as undecided. Careful: it still counts as settled by you, so the email leaves the waiting line.", "To ask for a second opinion, use 'Ask a teammate for a second look' instead."),
};
const SETTING: Record<string, GuideLine> = {
  classify_review_below: say("review", "How sure the app must be about what KIND of email it's reading before it trusts itself.", "Raise it and more emails are left for a person."),
  field_review_below: say("review", "How sure the app must be about each compared detail before it calls it a match or a mistake.", "Below this, the row becomes 'unsure' and a person decides."),
  party_fuzzy_match: say("ok", "How alike two company names must be spelled before the app treats them as the same company.", "It only forgives typo-sized differences.", "A missing word is too much for it: that goes to a person, or counts as a different company."),
  party_fuzzy_unsure: say("review", "The bottom edge of the 'close, but not sure' zone for company names.", "Names between this and the level above go to a person. Anything lower counts as a different company."),
  weight_tolerance_kg: say("ok", "How many kilograms the two weights may differ and still count as the same.", "It's meant to forgive rounding only. Raising it can hide a real weight mistake."),
  weight_tolerance_pct: say("ok", "The same allowance as a percentage. Whichever is larger applies.", "On a heavy shipment even a small percent is a lot of kilograms."),
  ocr_auto_accept: say("review", "Whether values read off a scanned page may be trusted without a person checking.", "Off is safer: reading a picture can get a single digit wrong, and in a weight that matters."),
  ocr_min: say("review", "How cleanly a scan must have been read before its values are accepted.", "It only matters while 'auto-accept' is ticked. Below this, the email still goes to a person."),
  llm_enabled: say("brand", "Whether the app may ask an AI model for a second opinion when its own rules aren't sure.", "It does nothing unless an AI key is set up on the server."),
};
const KB_KIND: Record<string, GuideLine> = {
  port_alias: say("brand", "Two spellings of the same port, like an old name and the current one.", "With this entry they count as a match."),
  party_alias: say("brand", "Two ways of writing the same company.", "Use it only when they really are the same company. It switches off a mismatch."),
  label_alias: say("brand", "An unusual heading that documents use for one of the seven details.", "It helps the app find the value."),
  classifier_hint: say("brand", "A phrase that tells the app what kind of email it's looking at."),
  carrier_prefix: say("brand", "The first letters of a booking number, and the shipping line they belong to.", "It's how emails get their shipping-line tag."),
  reply_rule: say("brand", "A sentence the team keeps adding to replies.", "The app adds it to drafts of that kind from the next check on. Replies already drafted stay as they are."),
  example: say("brand", "A past correction kept as an example for the AI helper.", "It does nothing while no AI model is connected."),
};
const ADMIN_TAB: Record<string, GuideLine> = {
  labels: say("brand", "Tags, and the rules that put them on emails automatically."),
  routing: say("brand", "Who gets which emails, based on their tags."),
  team: say("brand", "The pretend team and what each person may do."),
  thresholds: say("review", "How careful the checking is: when the app trusts itself and when it asks a person."),
  kb: say("brand", "The app's notebook of things it was taught, like two spellings of the same port."),
  learning: say("brand", "Suggestions the app built from people's corrections, waiting for a yes or no."),
};

const FAMILIES: Record<string, Maker> = {
  "nav:folder": (c, a) => FOLDER[a]?.(c) ?? null,
  "nav:category": (_c, a) => CATEGORY_NAV[a] ?? null,
  "nav:labelgroup": (_c, a) => LABEL_GROUP[a] ?? null,
  "nav:label": (c, a) => labelLine(c, a, "nav"),
  "list:label": (c, a) => labelLine(c, a, "chip"),
  "case:label": (c, a) => {
    const l = labelLine(c, a, "chip");
    if (cantEdit(c)) return l;                                                  // a viewer gets no x
    const auto = ["auto", "rule"].includes(c.openCase?.labels.find((x) => String(x.id) === a)?.source ?? "");
    return { ...l, text: `${l.text} ${auto ? "The small x takes it off this email, but the app puts it back the next time the email is re-checked." : "The small x takes it off this email only."}` };
  },
  "admin:label": (c, a) => {
    const l = c.labels.find((x) => String(x.id) === a);
    return say("brand", l?.kind !== "custom" ? "A tag the app adds by itself, from the documents or the sender's address, so it can't be edited here."
      : isAdminRole(c.me?.role) ? "A tag your team made. Rest here to recolour or delete it." : "A tag your team made. Only an admin can recolour or delete it.", "The number is how many emails carry it, tidied-away ones included.");
  },
  "list:tab": (_c, a) => TABS[a] ?? null,
  "top:search:op": (_c, a) => SEARCH_OP[a] ?? null,
  "top:user:option": (c, a) => {
    const u = c.users.find((x) => String(x.id) === a);
    if (!u) return null;
    return u.id === c.me?.id ? say("brand", `That's you right now: ${u.name}, ${an(u.role)}.`, ROLE_CAN[u.role])
      : say("brand", `Switch to ${u.name}, ${an(u.role)}.`, ROLE_CAN[u.role], "Whatever you do afterwards is recorded under that name.");
  },
  "list:action": (c, a) => ROW_ACTION[a]?.(c, false) ?? null,
  "list:bulk": (c, a) => ROW_ACTION[a]?.(c, true) ?? null,
  "list:row:assignee": (c, a) => { const u = c.users.find((x) => String(x.id) === a); return u ? say("brand", `Handed to ${u.name}.`, "It shows up in their 'Assigned to me' pile.") : null; },
  "list:row": (c, a) => rowLine(c, a),
  "case:category:option": (c, a) => {
    if (!CATEGORY_NAME[a]) return null;
    if (c.openCase?.category === a) return say("brand", `That's what this email is filed under now: ${CATEGORY_NAME[a]}.`);
    const loses = c.openCase?.category === "BL_COMPARISON" && "The document check disappears, because only document-check emails get one.";
    const gains = a === "BL_COMPARISON" && "The app then tries to compare the attached documents.";
    return say("brand", `Files this email as ${CATEGORY_NAME[a]} instead.`, loses || gains, "There's no undo message.", "You can pick the old kind again, but a verdict a person set and a reply you'd edited won't come back.");
  },
  "case:attachment": (c, a) => docLine(c.openCase, a, true),
  "verify:doc": (c, a) => docLine(c.openCase, a, false),
  "verify:col": (_c, a) => COLUMN[a] ?? null,
  "verify:field": (c, a) => (FIELD_MEANS[a] ? fieldLine(c.openCase?.fields.find((f) => f.field === a), a) : null),
  "verify:evidence": (_c, a) => EVIDENCE[a] ?? null,
  "verify:verdict": (_c, a) => VERDICT_OPTION[a] ?? null,
  "verify:stage": (_c, a) => (STAGE_WORDS[a] ? say("neutral", `One step of the check: "${STAGE_WORDS[a]}".`, "A green dot means it went through last time. A red one is where the app tripped.") : null),
  "admin:tab": (_c, a) => ADMIN_TAB[a] ?? null,
  "admin:thresholds": (_c, a) => SETTING[a] ?? null,
  "admin:thresholds:field": (_c, a) => (FIELD_SHORT[a] ? say("review", `Hold ${FIELD_SHORT[a]} to a stricter or looser standard than the other details.`, "Until you move it, it simply follows the general slider above.", "Once you've moved and saved it, it stays on its own, and only 'Restore defaults' links it back.") : null),
  "admin:kb:group": (_c, a) => KB_KIND[a] ?? null,
};

/** What the app found, in a few words, to follow Avery's AI-written preview of the email. */
function foundLine(r: Row): [GuideTheme, string] {
  if (r.status === "FAILED") return ["failed", "The app tripped over it and couldn't finish. Click to try again."];
  if (r.category !== "BL_COMPARISON") return ["neutral", "No document check is needed. Click to read it."];
  if (r.status === "MISMATCH") return ["mismatch", `The app found the draft wrong in ${details(r.defect_fields.length)}. Click to see what differs.`];
  if (r.status === "NEEDS_REVIEW") return r.resolved || !r.needs_human ? ["neutral", "A person has already dealt with it. Click to look again."] : ["review", "The app couldn't decide alone. Click to decide."];
  if (r.status === "OK") return r.attachments === 0 ? ["ok", "No documents came with it, so nothing was compared yet."] : ["ok", "The app found nothing wrong. Click to see the proof."];
  return ["neutral", "Click to open it."];
}

function rowLine(c: GuideCtx, id: string): GuideLine {
  const r = c.rows[id];
  if (!r) return say("brand", "One email.", "Click to open it and see what the app made of it.");
  if (r.preview && r.status !== "SENT") { const [theme, found] = foundLine(r); return say(theme, r.preview, found); }
  const who = firstName(r.sender.startsWith("To: ") ? "" : r.sender.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()));
  if (r.status === "SENT") return say("brand", "A reply sent from this app. Click to open the email it answers.", "Remember that sending is pretend here.");
  if (r.status === "FAILED") return say("failed", `The app tripped over this email from ${who} and couldn't finish.`, "Click to open it and try again.");
  if (!r.category || r.status === "PENDING") return say("neutral", `From ${who}. It hasn't been checked yet, so there's no result.`, "It gets one the next time the mailbox is processed. Click to read it.");
  if (r.category !== "BL_COMPARISON") return say("neutral", `From ${who}. The app filed it as ${CATEGORY_NAME[r.category ?? ""] ?? "mail"}, so no document check is needed.`, "Click to read it.");
  if (r.status === "MISMATCH") return say("mismatch", `${who} asked for a document check, and the draft came back wrong in ${details(r.defect_fields.length)}.`, "Click to see exactly what differs.");
  if (r.status === "NEEDS_REVIEW") return say("review", `${who} asked for a document check, but the app couldn't decide alone: ${REASON_MEANS[r.review_reason ?? ""] ?? "it wasn't confident enough"}.`, r.resolved || !r.needs_human ? "A person has already dealt with it. Click to look again." : "Click to decide.");
  if (r.status === "OK" && r.attachments === 0) return say("ok", `${who} wrote in about a document check, but no documents came with the email, so nothing was compared yet.`, "It counts as fine until they arrive. Click to read it.");
  if (r.status === "OK") return say("ok", `${who} asked for a document check, and the app found nothing wrong.`, "Click to see the proof and the reply it drafted.");
  return say("neutral", `From ${who}. It hasn't been checked yet.`);
}

/** The one entry point. Pure: same key + same ctx -> same line. Unknown key -> null. */
export function explain(key: string, ctx: GuideCtx): GuideLine | null {
  if (!key || key.split(":").some((part) => part in Object.prototype)) return null;
  const exact = LINES[key];
  if (exact) return exact(ctx);
  const parts = key.split(":");
  for (let i = parts.length - 1; i >= 1; i--) {           // longest family first: "list:row:assignee" before "list:row"
    const maker = FAMILIES[parts.slice(0, i).join(":")];
    if (maker) return maker(ctx, parts.slice(i).join(":"));
  }
  return null;
}

// ------------------------------------------------------------------ for the tests: every key the UI can emit
export const STATIC_KEYS = Object.keys(LINES);
export const FAMILY_ARGS: Record<string, string[]> = {
  "nav:folder": Object.keys(FOLDER), "nav:category": Object.keys(CATEGORY_NAV), "nav:labelgroup": Object.keys(LABEL_GROUP),
  "list:tab": Object.keys(TABS), "top:search:op": Object.keys(SEARCH_OP), "list:action": Object.keys(ROW_ACTION), "list:bulk": Object.keys(ROW_ACTION),
  "case:category:option": Object.keys(CATEGORY_NAME), "verify:col": Object.keys(COLUMN), "verify:field": Object.keys(FIELD_MEANS),
  "verify:evidence": Object.keys(EVIDENCE), "verify:verdict": Object.keys(VERDICT_OPTION), "admin:tab": Object.keys(ADMIN_TAB),
  "admin:thresholds": Object.keys(SETTING), "admin:thresholds:field": Object.keys(FIELD_SHORT), "admin:kb:group": Object.keys(KB_KIND),
  "verify:stage": ["ingest", "classify", "completeness", "extract", "compare", "route"],
};
/** Families whose argument is an id from live data (label id, email id, user id, file name). */
export const ID_FAMILIES = ["nav:label", "list:label", "case:label", "admin:label", "top:user:option", "list:row:assignee", "list:row", "case:attachment", "verify:doc"];
export const FOLDER_KEYS = Object.keys(FOLDER_BADGE);
export { amountWord, answerFor };
