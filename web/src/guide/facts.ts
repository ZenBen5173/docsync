// Facts that BOTH the screen and the guide state. Each is computed here, once, so the two can never
// disagree. No UI framework code in this file.
import type { CaseDetail, Counts } from "@/lib/api";

export type Role = "admin" | "reviewer" | "viewer";

/** What a role may do. The app (lib/app.tsx) and the guide both ask here. */
export const canEditRole = (role?: string) => !!role && role !== "viewer";
export const isAdminRole = (role?: string) => role === "admin";

/** Were the two documents actually compared, field by field? (false = e.g. the sender is still waiting for a draft) */
export const wasCompared = (c: Pick<CaseDetail, "fields">) => (c.fields ?? []).some((f) => f.result !== "not_compared");

/** A subject a newcomer can read, put together from details the app already extracted (no AI call: in a full
 *  product a model would write this line, here it is a fixed recipe so it costs nothing and works offline). */
export function readableSubject(e: { category?: string | null; status?: string; carrier?: string | null; customer?: string | null; pod?: string | null; attachments?: number; from?: string }): string | null {
  const nice = (s: string) => s.replace(/^POD\s+/i, "").split(",")[0].toLowerCase().replace(/(^|[\s\-(])\p{L}/gu, (m) => m.toUpperCase());
  const who = e.customer || e.from || "";
  const forWho = who ? ` for ${who}` : "";
  const to = e.pod ? ` · going to ${nice(e.pod)}` : "";
  const line = e.carrier ? `the ${e.carrier} draft` : "the draft";
  switch (e.category) {
    case "BL_COMPARISON": return e.attachments === 0 ? `${who || "The sender"} is asking for ${line}${to}` : `Check ${line}${forWho}${to}`;
    case "SI_REQUEST": return `New shipping instructions${who ? ` from ${who}` : ""}${to}`;
    case "INVOICE_QUERY": return `Invoice question${who ? ` from ${who}` : ""}`;
    case "GENERAL": return `General mail${who ? ` from ${who}` : ""}`;
    case "SPAM": return `Junk${e.from ? ` from ${e.from}` : ""}`;
    default: return null;
  }
}

/** The steps of a check, in the words the screen uses. */
export const STAGE_WORDS: Record<string, string> = { ingest: "Got the email", classify: "Worked out what kind it is", completeness: "Looked for both documents",
  extract: "Read the details", compare: "Compared the two", route: "Decided the result" };

/** Which number a sidebar folder shows, and what that number MEANS (they differ per folder). */
export type BadgeKind = "unread" | "total" | "none";
export const FOLDER_BADGE: Record<string, BadgeKind> = {
  inbox: "unread", assigned: "unread", review: "total", mismatch: "total", failed: "total", sent: "total", all: "none", ok: "none", spam: "none", other: "none",
};
export function folderBadge(folder: string, counts?: Pick<Counts, "folders" | "unread">): number | undefined {
  const kind = FOLDER_BADGE[folder] ?? "total";
  if (kind === "none" || !counts) return undefined;
  return kind === "unread" ? counts.unread[folder] : counts.folders[folder];
}

/** "most of them", "only a few" ... so the guide never has to repeat a figure the screen already shows. */
export function amountWord(part: number, whole: number): string {
  if (!whole || part <= 0) return "none";
  const share = part / whole;
  if (part >= whole) return "all of them";
  if (share >= 0.75) return "most of them";
  if (share >= 0.4) return "about half";
  if (share >= 0.15) return "some of them";
  return "only a few";
}

// ------------------------------------------------------------------ the answer, in plain words
// What an opened email says FIRST: one sentence, and the one next step. The card, the reply button and the
// guide all read this, so they always agree on which situation this is.

/** Plain names for the seven details; the trade word comes second and is only ever shown small. */
export const PLAIN_FIELD: Record<string, [plain: string, trade?: string]> = {
  shipper: ["Sending company", "shipper"], consignee: ["Receiving company", "consignee"], notify_party: ["Who to notify on arrival", "notify party"],
  port_of_loading: ["Loading port"], port_of_discharge: ["Arrival port"], container_count: ["Number of containers"], gross_weight_kg: ["Total weight"],
};
export const plainField = (f: string) => PLAIN_FIELD[f]?.[0] ?? f.replace(/_/g, " ");
const KIND_WORDS: Record<string, string> = { SI_REQUEST: "new shipping instructions", INVOICE_QUERY: "an invoice question", GENERAL: "general mail", SPAM: "junk", BL_COMPARISON: "a document check" };
const listOf = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const aOrAn = (w: string) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);

/** The rows a person should look at: different, unsure or blank. */
export const rowsThatMatter = (c: Pick<CaseDetail, "fields" | "defect_fields" | "status">) => {
  const marked = new Set(c.status === "MISMATCH" ? c.defect_fields : []);
  const rank: Record<string, number> = { mismatch: 0, unsure: 1, missing: 2 };
  return (c.fields ?? []).filter((f) => f.result in rank || marked.has(f.field)).sort((a, b) => (rank[a.result] ?? 0) - (rank[b.result] ?? 0));
};

/** Split two values into [same start, different middle of a, different middle of b, same end] so only the difference is marked. */
export function diffParts(a: string, b: string): [string, string, string, string] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return [a.slice(0, s), a.slice(s, a.length - e), b.slice(s, b.length - e), e ? a.slice(a.length - e) : ""];
}

export type AnswerKind = "failed" | "nocheck" | "junk" | "kind_unsure" | "mismatch" | "match" | "waiting_for_draft" | "missing_doc"
  | "cant_open" | "scan" | "wrong_doc" | "blank" | "unsure" | "undecided" | "not_sure_enough";
export type Answer = {
  kind: AnswerKind;
  tone: "ok" | "mismatch" | "review" | "failed" | "neutral";
  icon: string;                  // a lucide icon name
  headline: string;
  subline?: string;
  note?: string;                 // who decided, or who asked for a second look
  /** What the ONE filled button on the screen does. */
  step: "send" | "retry" | "decide" | "confirm" | "none";
  button?: string;
  replyHint?: string;            // the line above the drafted reply
  done: boolean;                 // a reply went out and nothing is waiting for a person
};

export type AnswerInput = Pick<CaseDetail, "status" | "category" | "fields" | "docs" | "defect_fields" | "proposed_defect_fields" | "review_reason"
  | "review_detail" | "needs_human" | "resolved" | "overrides" | "ai_status"> & { sent?: unknown[]; activity?: { action: string; at: string }[] };

/** Things a person can do that change the result: a reply sent BEFORE one of these no longer answers the email. */
const RESULT_CHANGES = ["verdict changed", "value corrected", "category changed", "reset to AI result"];

export function answerFor(c: AnswerInput, who = "The sender"): Answer {
  const waiting = c.needs_human && !c.resolved;
  const lastSent = (c.sent as { sent_at?: string }[] | undefined)?.at(-1)?.sent_at;
  const changedSince = !!lastSent && (c.activity ?? []).some((a) => RESULT_CHANGES.includes(a.action) && a.at > lastSent);
  const replied = (c.sent?.length ?? 0) > 0 && !changedSince;
  const whom = who === "The sender" ? "the sender" : who;                 // the same name, mid-sentence
  const person = !!(c.overrides as { verdict?: unknown } | undefined)?.verdict;
  const finish = (a: Omit<Answer, "done" | "step"> & { step?: Answer["step"] }): Answer => {
    const out: Answer = { ...a, step: a.step ?? "send", done: replied && !waiting };
    const said: Record<string, string> = { OK: "all fine", MISMATCH: "different", NEEDS_REVIEW: "not sure" };
    if (person) out.note = c.ai_status && c.ai_status !== c.status ? `Decided by a person. The app first said: ${said[c.ai_status] ?? "something else"}.` : "Decided by a person.";
    if (waiting && (c.status === "OK" || c.status === "MISMATCH")) {
      // a second pair of eyes was asked for: the one thing to do is to say whether you agree
      const asked = /^Sent to review by ([^:]+):/.exec(c.review_detail ?? "")?.[1];
      out.note = asked ? `${asked} asked for a second look at this one.` : "The app wasn't fully sure about this one, so it's asking a person to look.";
      out.step = "confirm"; out.button = "I agree with this result";
    } else if (replied && waiting && out.step === "send") {
      out.headline = "You've asked for what's needed. Nothing more to do until they answer.";
      out.subline = "When the new file arrives it will come in as a new email."; out.step = "confirm"; out.button = "Mark as handled";
    } else if (out.done && out.step === "send") out.step = "none";
    return out;
  };

  if (c.status === "FAILED") return finish({ kind: "failed", tone: "failed", icon: "bug", headline: "The app couldn't finish checking this email.",
    subline: "That's a hiccup in the app, not a problem with the shipment. Trying again usually fixes it.", step: "retry", button: "Try again" });

  if (c.status === "PENDING" || !c.category) return { kind: "nocheck", tone: "neutral", icon: "hourglass", headline: "This email hasn't been checked yet.",
    subline: "It gets a result the next time the mailbox is processed.", step: "none", done: false };

  if (c.category !== "BL_COMPARISON") {
    const kind = KIND_WORDS[c.category] ?? "ordinary mail";
    if (waiting) return { kind: "kind_unsure", tone: "review", icon: "circle-help", headline: "The app isn't sure what kind of email this is.",
      subline: `Its best guess: ${kind}. If that's right, no check is needed.`, step: "confirm", button: "Yes, that's right", done: false };
    if (c.category === "SPAM") return { kind: "junk", tone: "neutral", icon: "octagon-alert", headline: "This looks like junk.",
      subline: "The app goes by wording and suspicious addresses, so it can be wrong. Nothing is deleted.", step: "none", done: false };
    return { kind: "nocheck", tone: "neutral", icon: "info", headline: `No check needed: this is ${kind}.`,
      subline: "Only emails asking to check a draft get compared. Read this one like normal mail.", step: "none", done: false };
  }

  if (c.status === "MISMATCH") {
    const names = c.defect_fields.map(plainField), n = names.length;
    return finish({ kind: "mismatch", tone: "mismatch", icon: "shield-x",
      headline: n === 0 ? "A person decided this draft is wrong." : n <= 2 ? `${listOf(names.map((x, i) => (i ? x.toLowerCase() : x)))} ${n === 1 ? "is" : "are"} different from what the customer asked for.` : `${n} details are different from what the customer asked for.`,
      subline: n === 0 ? "No row is marked as wrong yet, so say what to fix in the reply before you send it." : undefined,
      button: "Ask for a corrected draft",
      replyHint: n === 0 ? "The reply has a gap where the fixes go. Press 'Read and edit' and fill it in before sending." : "The reply is already written and lists what to fix. Read it, then send." });
  }
  if (c.status === "OK" && person) return finish({ kind: wasCompared(c) ? "match" : "waiting_for_draft", tone: "ok", icon: "shield-check", headline: "A person decided this draft is fine.",
    subline: rowsThatMatter(c).length ? "The rows below still show what the app itself found." : undefined,
    button: "Send the all-clear", replyHint: "A reply saying the draft is good to go is already written." });
  if (c.status === "OK") return wasCompared(c)
    ? finish({ kind: "match", tone: "ok", icon: "shield-check", headline: "All 7 details match what the customer asked for.", subline: "Nothing needs fixing.",
        button: "Send the all-clear", replyHint: "A reply saying the draft is good to go is already written." })
    : finish({ kind: "waiting_for_draft", tone: "ok", icon: "hourglass", headline: "Nothing to check yet: no draft has arrived.",
        subline: `${who} is asking for the draft, not sending one, so there is nothing to compare. It counts as fine until the documents arrive.`,
        button: "Send the short reply", replyHint: "A short reply saying you'll check it when it arrives is already written." });

  // ---- NEEDS_REVIEW: say why in plain words, from what actually arrived
  const review = { tone: "review" as const, icon: "shield-alert" };
  if (person) return finish({ ...review, kind: "undecided", headline: "A person marked this one as undecided.",
    subline: "When you know the answer, settle it under 'Other options'.", step: "none" });
  const docs = c.docs ?? [], roles = new Set(docs.map((d) => d.role));
  if (c.review_reason === "missing_attachment") return finish({ ...review, kind: "missing_doc", headline: "This can't be checked yet: a document is missing.",
    subline: roles.has("SI") && !roles.has("BL") ? "The customer's instructions arrived, but the shipping line's draft didn't."
      : roles.has("BL") && !roles.has("SI") ? "The shipping line's draft arrived, but the customer's instructions didn't." : "The email mentions attachments, but none arrived.",
    button: "Ask for the missing document", replyHint: `A reply asking ${whom} to send it is already written.` });
  if (c.review_reason === "unreadable") {
    const broken = docs.find((d) => !d.readable), scan = docs.find((d) => d.method === "ocr");
    if (broken || !scan) return finish({ ...review, kind: "cant_open", headline: "This can't be checked yet: a file couldn't be opened.",
      subline: `${broken?.name ?? "One of the files"} is damaged or empty, so there is nothing to compare it with.`,
      button: "Ask for a readable copy", replyHint: "A reply asking for a fresh copy is already written." });
    const guess = c.proposed_defect_fields.map((f) => plainField(f).toLowerCase());
    const open = (c.fields ?? []).filter((f) => f.result === "missing" || f.result === "unsure").length;
    const read = guess.length ? `From what it could read, ${listOf(guess)} ${guess.length === 1 ? "looks" : "look"} different.`
      : open ? `From what it could read, nothing looks different, but ${open === 1 ? "one detail" : "some details"} could not be found.`
      : wasCompared(c) ? "From what it could read, all 7 details look the same." : "";
    return finish({ ...review, kind: "scan", headline: "Please double-check this one: a file is a scanned picture.",
      subline: `${scan.name} is a photo of a page. The app read it, but it can get a letter or a digit wrong, so it won't decide alone. ${read}`.trim(),
      button: "Ask for a readable copy", replyHint: "Safest is to ask for a typed copy. That reply is already written." });
  }
  if (c.review_reason === "wrong_doc_type") {
    const other = docs.find((d) => d.type === "OTHER");
    return finish({ ...review, kind: "wrong_doc", headline: "This can't be checked yet: the wrong document was attached.",
      subline: `${other?.name ?? "One attachment"} looks like ${aOrAn((other?.subtype ?? "different document").replace(/_/g, " ").toLowerCase())}, not the shipping line's draft.`,
      button: "Ask for the right document", replyHint: "A reply asking for the right document is already written." });
  }
  const blanks = (c.fields ?? []).filter((f) => f.result === "missing"), unsure = (c.fields ?? []).filter((f) => f.result === "unsure");
  if (unsure.length && !blanks.length) return finish({ ...review, kind: "unsure", icon: "circle-help",
    headline: `The app isn't sure about ${unsure.length === 1 ? plainField(unsure[0].field).toLowerCase() : `${unsure.length} details`}. Can you decide?`,
    subline: "Your answer settles the result and rewrites the reply to match.", step: "decide", button: "Save my answer" });
  if (blanks.length) return finish({ ...review, kind: "blank",
    headline: blanks.length === 1 ? `This can't be finished: ${plainField(blanks[0].field).toLowerCase()} was left blank.` : `This can't be finished: ${blanks.length} details were left blank.`,
    subline: "A blank is a question for the sender, not a mistake in the draft, so the app asks instead of guessing.",
    button: "Ask them to fill the gap", replyHint: `A reply asking ${whom} to confirm it is already written.` });
  return finish({ ...review, kind: "not_sure_enough", headline: "The app wasn't sure enough to decide this one alone.",
    subline: "Look at the rows below, then settle it under 'Other options'.", button: "Send the reply", replyHint: "A reply is already written. Read it before you send." });
}
