// Tests for Avery's lines. explain() is pure, so no DOM is needed: we feed it keys and a ctx.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CaseDetail, FieldResult, Label, Row } from "@/lib/api";
import { explain, FAMILY_ARGS, FOLDER_KEYS, ID_FAMILIES, STATIC_KEYS, type GuideCtx } from "@/guide/explain";
import { amountWord, answerFor, diffParts, folderBadge, rowsThatMatter } from "@/guide/facts";

// ------------------------------------------------------------------ fixtures
const labels: Label[] = [
  { id: 1, name: "MSC", color: "#1a73e8", kind: "auto", group: "carrier", count: 12 },
  { id: 2, name: "Vital Solutions", color: "#188038", kind: "auto", group: "customer", count: 4 },
  { id: 3, name: "POD Rotterdam", color: "#e37400", kind: "auto", group: "pod", count: 0 },
  { id: 4, name: "Urgent", color: "#d93025", kind: "custom", group: null, count: 2 },
];
const users = [
  { id: 1, name: "Maya Tan", role: "admin" as const, active: true },
  { id: 2, name: "Arif Rahman", role: "reviewer" as const, active: true },
  { id: 5, name: "Guest Viewer", role: "viewer" as const, active: true },
];
const field = (name: string, result: FieldResult["result"]): FieldResult =>
  ({ field: name, si: null, bl: null, result, reason: "", confidence: 0.9, si_norm: null, bl_norm: null });
const row = (id: string, over: Partial<Row>): Row => ({
  id, sender: "jane.doe@vitalsolutions.example", subject: "Draft BL check", snippet: "", received_at: "2026-09-01T08:00:00",
  attachments: 2, is_read: false, starred: false, category: "BL_COMPARISON", status: "OK", confidence: 0.97,
  assignee_id: null, defect_fields: [], labels: [], ...over,
});
const rows: Record<string, Row> = {
  ok: row("ok", {}),
  bad: row("bad", { status: "MISMATCH", defect_fields: ["gross_weight_kg", "consignee"] }),
  unsure: row("unsure", { status: "NEEDS_REVIEW", review_reason: "unreadable" }),
  broken: row("broken", { status: "FAILED" }),
  invoice: row("invoice", { category: "INVOICE_QUERY", status: "OK" }),
  waiting: row("waiting", { attachments: 0 }),
  unchecked: row("unchecked", { category: null, status: "PENDING" }),
  sent: row("sent", { status: "SENT", sender: "To: jane.doe@vitalsolutions.example" }),
};
const openCase = (over: Partial<CaseDetail>): CaseDetail => ({
  id: "bad", sender: "jane.doe@vitalsolutions.example", subject: "Draft BL check", received_at: "2026-09-01T08:00:00",
  body: { message: "", signature: "", quoted: "", banner: "", raw: "" }, attachments: [], is_read: true, starred: false, archived: false,
  category: "BL_COMPARISON", category_confidence: 0.99, classification: null, status: "MISMATCH", review_reason: null, review_detail: null,
  defect_fields: ["gross_weight_kg"], proposed_defect_fields: [], ai_status: "MISMATCH", confidence: 0.95, needs_human: false, resolved: false,
  carrier: "MSC", customer: "Vital Solutions", pod: "Rotterdam", refs: {},
  docs: [
    { path: "a/si.pdf", name: "si.pdf", format: "pdf", readable: true, error: null, method: "text", ocr_confidence: null, type: "SI", subtype: null, type_confidence: 0.99, type_evidence: null, role: "SI" },
    { path: "a/bl.pdf", name: "bl.pdf", format: "pdf", readable: true, error: null, method: "ocr", ocr_confidence: 0.91, type: "BL", subtype: null, type_confidence: 0.99, type_evidence: null, role: "BL" },
    { path: "a/x.pdf", name: "x.pdf", format: "pdf", readable: false, error: "empty", method: "none", ocr_confidence: null, type: null, subtype: null, type_confidence: null, type_evidence: null, role: null },
    { path: "a/inv.pdf", name: "inv.pdf", format: "pdf", readable: true, error: null, method: "text", ocr_confidence: null, type: "OTHER", subtype: "COMMERCIAL_INVOICE", type_confidence: 0.9, type_evidence: null, role: null },
  ],
  fields: [field("shipper", "match"), field("consignee", "unsure"), field("notify_party", "missing"), field("gross_weight_kg", "mismatch"), field("container_count", "not_compared")],
  stages: {}, error: null, assignee_id: 2, labels: [labels[0]], draft: null, ai_draft: null, overrides: {},
  ...over,
} as CaseDetail);

const busy: GuideCtx = {
  product: "DocSync", me: users[0], users, labels, hosted: false, publicDemo: false, llm: false, running: false, dark: false, rows,
  counts: { folders: { inbox: 137, assigned: 9, review: 23, mismatch: 14, ok: 61, failed: 2, sent: 3, all: 521, spam: 43 }, unread: { inbox: 83, assigned: 4 }, pending_suggestions: 2 },
  openCase: openCase({}),
};
const quiet: GuideCtx = {
  ...busy, me: users[2], hosted: true, publicDemo: true, llm: true, running: true, dark: true, rows: {}, openCase: undefined,
  counts: { folders: { inbox: 0, assigned: 0, review: 0, mismatch: 0, ok: 0, failed: 0, sent: 0, all: 0, spam: 0 }, unread: {}, pending_suggestions: 0 },
};
const bare: GuideCtx = { product: "DocSync", users: [], labels: [], hosted: false, publicDemo: false, llm: false, running: false, dark: false, rows: {} };
const CTXS = { busy, quiet, bare };

const ID_ARGS: Record<string, string[]> = {
  "nav:label": ["1", "2", "3", "4"], "list:label": ["1", "4"], "case:label": ["1", "4"], "admin:label": ["1", "4"],
  "top:user:option": ["1", "2", "5"], "list:row:assignee": ["2"], "list:row": Object.keys(rows),
  "case:attachment": ["si.pdf", "bl.pdf", "x.pdf", "inv.pdf"], "verify:doc": ["si.pdf", "bl.pdf", "x.pdf", "inv.pdf"],
};

/** Every key the app can produce, expanded from the tables explain.ts exports. */
function allKeys(withPeople = true): string[] {
  const keys = [...STATIC_KEYS];
  for (const [family, args] of Object.entries(FAMILY_ARGS)) for (const a of args) keys.push(`${family}:${a}`);
  for (const family of ID_FAMILIES) {
    if (!withPeople && PEOPLE_FAMILIES.includes(family)) continue;
    for (const a of ID_ARGS[family]) keys.push(`${family}:${a}`);
  }
  return keys;
}
const PEOPLE_FAMILIES = ["top:user:option", "list:row:assignee"];

// ------------------------------------------------------------------ what the UI actually emits
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx$/.test(e.name) ? [join(dir, e.name)] : []);
}
const SRC = resolve(__dirname, "..");
const code = sources(SRC).filter((f) => !/[\\/]guide[\\/]/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
const literalKeys = [
  ...[...code.matchAll(/\bguide="([^"]+)"/g)].map((m) => m[1]),                                // guide="x" and data-guide="x"
  ...[...code.matchAll(/\bguide=\{([^{}`]*)\}/g)].flatMap((m) => [...m[1].matchAll(/"([a-z]+(?::[a-z_]+)+)"/g)].map((k) => k[1])),   // guide={a ? "x" : "y"}
];
const templateKeys = [...code.matchAll(/\bguide=\{(?:guide \?\? )?`([^`$]*)\$\{/g)].map((m) => m[1].replace(/:$/, ""));

describe("every key the UI can emit gets a line", () => {
  it("finds the wiring at all (guards the scanner itself)", () => {
    expect(literalKeys.length).toBeGreaterThan(120);
    expect(templateKeys.length).toBeGreaterThan(20);
  });
  it.each([...new Set(literalKeys)])("literal key %s", (key) => {
    for (const ctx of Object.values(CTXS)) expect(explain(key, ctx), key).not.toBeNull();
  });
  it.each([...new Set(templateKeys)])("template family %s:<arg> is a known family", (family) => {
    const known = family in FAMILY_ARGS || ID_FAMILIES.includes(family) || family === "status";
    expect(known, `"${family}" is built in the UI but explain.ts has no family for it`).toBe(true);
  });
  it("covers every status a chip can show", () => {
    for (const s of ["OK", "MISMATCH", "NEEDS_REVIEW", "FAILED"]) expect(explain(`status:${s}`, busy)).not.toBeNull();
  });
  it("covers every sidebar folder", () => {
    for (const f of FOLDER_KEYS) expect(explain(`nav:folder:${f}`, busy), f).not.toBeNull();
  });
  it("has no orphan lines: every static key is used somewhere in the UI", () => {
    const used = new Set(literalKeys);
    const orphans = STATIC_KEYS.filter((k) => !used.has(k) && k !== "guide:hello" && !k.startsWith("status:"));
    expect(orphans).toEqual([]);
  });
});

describe("every line is fit to show", () => {
  for (const [name, ctx] of Object.entries(CTXS)) {
    it.each(allKeys(ctx.users.length > 0))(`${name}: %s`, (key) => {
      const line = explain(key, ctx);
      expect(line, key).not.toBeNull();
      const { text, theme } = line!;
      expect(["brand", "ok", "mismatch", "review", "failed", "neutral"]).toContain(theme);
      expect(text.length, "too short to be useful").toBeGreaterThan(20);
      expect(text.length, "too long for the bubble").toBeLessThan(400);
      expect(text).not.toMatch(/undefined|NaN|\bnull\b|\[object|\$\{|\{\w+\}|%s| {2}/);
      expect(text, "ends mid-sentence").toMatch(/[.!?'")]$/);
      expect(text.split(/(?<=[.!?])\s+/).length, "more than four sentences").toBeLessThanOrEqual(4);
    });
  }
  it("keeps numbers rare: no line repeats a count from the screen", () => {
    for (const key of allKeys()) {
      const text = explain(key, busy)!.text;
      for (const n of [137, 83, 521, 61, 43, 23]) expect(text, key).not.toContain(String(n));
    }
  });
});

describe("lines follow the app's state", () => {
  const differs = (key: string, a: GuideCtx, b: GuideCtx) => expect(explain(key, a)!.text, key).not.toBe(explain(key, b)!.text);
  it("an empty pile reads differently from a full one", () => {
    for (const f of ["review", "mismatch", "failed", "assigned", "sent"]) differs(`nav:folder:${f}`, busy, quiet);
    expect(explain("nav:folder:review", quiet)!.text).toMatch(/empty/);
  });
  it("the online copy is honest that it cannot run the pipeline", () => {
    differs("nav:run", busy, quiet);
  });
  it("a viewer is told why a button is off", () => {
    differs("list:action:assign", busy, quiet);
    expect(explain("list:action:assign", quiet)!.text).toMatch(/viewer/);
  });
  it("theme, AI and role lines describe what is true now", () => {
    differs("top:theme", busy, quiet);
    differs("top:user", busy, quiet);
    expect(explain("top:user:option:1", busy)!.text).toMatch(/you right now/);
    expect(explain("top:user:option:2", busy)!.text).toMatch(/Switch to Arif/);
  });
  it("a field row takes the colour and words of its result", () => {
    expect(explain("verify:field:shipper", busy)!.theme).toBe("ok");
    expect(explain("verify:field:gross_weight_kg", busy)!.theme).toBe("mismatch");
    expect(explain("verify:field:consignee", busy)!.theme).toBe("review");
    expect(explain("verify:field:notify_party", busy)!.text).toMatch(/couldn't find this detail/);      // one side has no value at all
    const side = { field: "notify_party", raw: "", full: "", label: "Notify", loc: null, confidence: 0.9, method: "text", blank: true, note: null, doc: "si.pdf", format: "pdf" };
    const blank = { ...busy, openCase: openCase({ fields: [{ ...field("notify_party", "missing"), si: side, bl: { ...side, raw: "ACME", blank: false } }] }) };
    expect(explain("verify:field:notify_party", blank)!.text).toMatch(/leaves this blank/);
    expect(explain("verify:field:container_count", busy)!.theme).toBe("neutral");
  });
  it("an email row says what happened to that email", () => {
    expect(explain("list:row:ok", busy)!.theme).toBe("ok");
    expect(explain("list:row:bad", busy)!.text).toMatch(/two details/);
    expect(explain("list:row:unsure", busy)!.text).toMatch(/couldn't be read/);
    expect(explain("list:row:waiting", busy)!.text).toMatch(/nothing was compared yet/);
    expect(explain("list:row:unchecked", busy)!.text).toMatch(/hasn't been checked yet/);
    expect(explain("list:row:broken", busy)!.theme).toBe("failed");
    expect(explain("list:row:invoice", busy)!.text).toMatch(/invoice question/);
    expect(explain("list:row:sent", busy)!.text).toMatch(/pretend/);
  });
  it("with an AI preview, Avery says what the email wants and then what the app found", () => {
    const withPreview = { ...busy, rows: { ...rows, bad: { ...rows.bad, preview: "Jane asks the team to check a draft against her instructions." } } };
    const line = explain("list:row:bad", withPreview)!;
    expect(line.text).toMatch(/^Jane asks the team/);
    expect(line.text).toMatch(/draft wrong in two details/);
    expect(line.theme).toBe("mismatch");
  });
  it("a document chip says which side it is and whether it could be read", () => {
    expect(explain("verify:doc:si.pdf", busy)!.theme).toBe("ok");
    expect(explain("verify:doc:bl.pdf", busy)!.text).toMatch(/scan/);
    expect(explain("verify:doc:x.pdf", busy)!.theme).toBe("mismatch");
    expect(explain("verify:doc:inv.pdf", busy)!.text).toMatch(/commercial invoice/);
  });
  it("the verdict card follows the open email", () => {
    const ok = { ...busy, openCase: openCase({ status: "OK", defect_fields: [], fields: [field("shipper", "match")] }) };
    const waiting = { ...busy, openCase: openCase({ status: "OK", defect_fields: [], fields: [field("shipper", "not_compared")] }) };
    differs("verify:card", busy, ok);
    differs("verify:card", ok, waiting);
  });
  it("same key and same state always give the same line", () => {
    for (const key of allKeys()) expect(explain(key, busy)).toEqual(explain(key, busy));
  });
});

describe("unknown keys stay silent", () => {
  it.each(["", "nope", "nav", "nav:folder:doesnotexist", "verify:field:bogus", "admin:thresholds:bogus", "top:user:option:999",
    "list:row:assignee:999", "verify:verdict:MAYBE", "admin:tab:secret", "analytics:tile:bogus", "constructor", "__proto__"])("%s -> null", (key) => {
    expect(explain(key, busy)).toBeNull();
  });
});

describe("shared facts", () => {
  it("amountWord never needs a figure", () => {
    expect(amountWord(0, 10)).toBe("none");
    expect(amountWord(1, 100)).toBe("only a few");
    expect(amountWord(5, 10)).toBe("about half");
    expect(amountWord(9, 10)).toBe("most of them");
    expect(amountWord(10, 10)).toBe("all of them");
    expect(amountWord(3, 0)).toBe("none");
  });
  it("the answer names the detail in plain words and gives exactly one next step", () => {
    const wrong = answerFor(openCase({}), "Jane");
    expect(wrong.headline).toBe("Total weight is different from what the customer asked for.");
    expect([wrong.kind, wrong.step, wrong.button]).toEqual(["mismatch", "send", "Ask for a corrected draft"]);
    const waiting = answerFor(openCase({ status: "OK", defect_fields: [], fields: [field("shipper", "not_compared")] }), "Jane");
    expect(waiting.kind).toBe("waiting_for_draft");
    expect(waiting.subline).toMatch(/^Jane is asking for the draft/);
    const three = answerFor(openCase({ defect_fields: ["shipper", "consignee", "gross_weight_kg"] }));
    expect(three.headline).toMatch(/^3 details are different/);
  });
  it("every situation has plain words, and never a trade word alone in the headline", () => {
    const base = { defect_fields: [], needs_human: true, resolved: false, status: "NEEDS_REVIEW" as const };
    const cases = [
      openCase({ ...base, review_reason: "missing_attachment", docs: openCase({}).docs.slice(0, 1) }),
      openCase({ ...base, review_reason: "unreadable" }),
      openCase({ ...base, review_reason: "unreadable", docs: openCase({}).docs.slice(0, 2) }),
      openCase({ ...base, review_reason: "wrong_doc_type" }),
      openCase({ ...base, review_reason: "missing_value", fields: [field("notify_party", "missing")] }),
      openCase({ ...base, review_reason: "missing_value", fields: [field("consignee", "unsure")] }),
      openCase({ status: "FAILED" }), openCase({ category: "SPAM" }), openCase({ category: "INVOICE_QUERY" }),
      openCase({ category: "GENERAL", needs_human: true, resolved: false }),
    ];
    const kinds = cases.map((k) => answerFor(k).kind);
    expect(kinds).toEqual(["missing_doc", "cant_open", "scan", "wrong_doc", "blank", "unsure", "failed", "junk", "nocheck", "kind_unsure"]);
    for (const k of cases) {
      const a = answerFor(k);
      expect(a.headline).not.toMatch(/undefined|NaN|\bSI\b|\bBL\b|consignee|shipper|notify party|verdict|OCR|pipeline/i);
      expect(`${a.subline ?? ""}`).not.toMatch(/undefined|NaN|\bSI\b|\bBL\b|OCR|pipeline/);
      expect(a.step === "none" || !!a.button, "a step needs a label").toBe(true);
    }
  });
  it("a second look and a finished email change the one next step", () => {
    const second = answerFor(openCase({ needs_human: true, resolved: false, review_detail: "Sent to review by Maya Tan: second opinion requested" }));
    expect([second.step, second.button, second.note]).toEqual(["confirm", "I agree with this result", "Maya Tan asked for a second look at this one."]);
    const done = answerFor({ ...openCase({ resolved: true }), sent: [{}] });
    expect([done.done, done.step]).toEqual([true, "none"]);
  });
  it("the answer never says more than the app knows", () => {
    const scan = { status: "NEEDS_REVIEW" as const, review_reason: "unreadable", defect_fields: [], needs_human: true, docs: openCase({}).docs.slice(0, 2) };
    expect(answerFor(openCase({ ...scan, fields: [field("shipper", "match"), field("port_of_loading", "missing")] })).subline).toMatch(/one detail could not be found/);
    expect(answerFor(openCase({ ...scan, fields: [field("shipper", "match")] })).subline).toMatch(/all 7 details look the same/);
    const unchecked = answerFor(openCase({ status: "PENDING", category: null as unknown as string }));
    expect([unchecked.headline, unchecked.step]).toEqual(["This email hasn't been checked yet.", "none"]);
    const overruled = answerFor(openCase({ status: "OK", defect_fields: [], overrides: { verdict: { status: "OK" } } }));
    expect(overruled.headline).toBe("A person decided this draft is fine.");
    expect(answerFor(openCase({ defect_fields: ["consignee", "notify_party"] })).headline).toBe("Receiving company and who to notify on arrival are different from what the customer asked for.");
  });
  it("a reply sent before the result changed does not count as done", () => {
    const sent = [{ sent_at: "2026-09-10T10:00:00" }];
    expect(answerFor({ ...openCase({ resolved: true }), sent }).done).toBe(true);
    const changed = answerFor({ ...openCase({ resolved: true }), sent, activity: [{ action: "verdict changed", at: "2026-09-11T09:00:00" }] });
    expect([changed.done, changed.step]).toEqual([false, "send"]);
  });
  it("only the difference is marked, and the rows that need eyes come first", () => {
    expect(diffParts("61,250 KG", "61,520 KG")).toEqual(["61,", "25", "52", "0 KG"]);
    expect(diffParts("SAME", "SAME")).toEqual(["SAME", "", "", ""]);
    expect(rowsThatMatter(openCase({})).map((f) => f.result)).toEqual(["mismatch", "unsure", "missing"]);
  });
  it("folder badges mean what the guide says they mean", () => {
    expect(folderBadge("inbox", busy.counts)).toBe(83);        // unread
    expect(folderBadge("review", busy.counts)).toBe(23);       // total
    expect(folderBadge("ok", busy.counts)).toBeUndefined();    // no badge
  });
});
