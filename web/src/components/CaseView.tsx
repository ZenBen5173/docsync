// An opened email, read as a thread: what they asked (folded) -> what the app found, in one plain sentence ->
// the reply, with the one filled button of the screen. Everything else is one click away, never in the way.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IconName } from "lucide-react/dynamic";
import { useApp } from "@/lib/app";
import { api, type CaseDetail, type FieldResult } from "@/lib/api";
import { navigate } from "@/lib/router";
import { fullDate, initials, pct, senderName } from "@/lib/format";
import { toast } from "@/lib/toast";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Avatar, Button, IconButton, LabelChip, MenuItem, Modal, Popover, StatusChip } from "@/components/bits";
import { AssignMenu, LabelPicker } from "@/components/pickers";
import { Evidence } from "@/components/Evidence";
import { ReplyBox } from "@/components/ReplyBox";
import { AnimatedLucide, type IconHandle } from "@/components/ui/animated-lucide";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Chevron, Disclosure } from "@/components/ui/disclosure";
import { MagneticButton } from "@/components/ui/magnetic-button";
import { MathCurveLoader } from "@/components/ui/math-curve-loader";
import { readableSubject, answerFor, diffParts, PLAIN_FIELD, rowsThatMatter, STAGE_WORDS, wasCompared, type Answer } from "@/guide/facts";

const RESULT_UI: Record<string, { icon: IconName; cls: string; label: string }> = {
  match: { icon: "circle-check", cls: "text-ok", label: "Same" },
  mismatch: { icon: "circle-x", cls: "text-mismatch", label: "Different" },
  unsure: { icon: "circle-help", cls: "text-review", label: "Not sure" },
  missing: { icon: "circle-dashed", cls: "text-review", label: "Blank" },
  not_compared: { icon: "minus", cls: "text-muted-foreground", label: "Not compared" },
};
const FILE_ICON: Record<string, [IconName, string]> = {
  pdf: ["file-text", "#d93025"], xlsx: ["file-spreadsheet", "#188038"], docx: ["file-type", "#1a73e8"], txt: ["file", "#5f6368"],
};
const KIND_PLAIN: Record<string, string> = { BL_COMPARISON: "Document check", SI_REQUEST: "New shipping instructions", INVOICE_QUERY: "Invoice question", GENERAL: "General mail", SPAM: "Junk" };
const remembered = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const remember = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* private mode */ } };

function ConfidenceBar({ value }: { value: number }) {
  const tone = value >= 0.85 ? "bg-ok" : value >= 0.6 ? "bg-[#f4b400]" : "bg-mismatch";
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <motion.span className={cn("block h-full rounded-full", tone)} initial={{ width: 0 }} animate={{ width: `${value * 100}%` }} transition={SPRING.soft} />
      </span>
      <span className="w-8 text-[11px] tabular-nums text-muted-foreground">{pct(value)}</span>
    </span>
  );
}

/** What one side says, in plain words when there is nothing to show. */
const sideText = (fr: FieldResult, side: "si" | "bl") => fr[side]?.raw || (fr[side] ? "left blank" : "not found");

/** A small amber word, only when it changes what a person should do. */
function CareTag({ fr }: { fr: FieldResult }) {
  const scan = fr.si?.method === "ocr" || fr.bl?.method === "ocr";
  const shaky = fr.result !== "not_compared" && fr.confidence < 0.7;
  if (!scan && !shaky) return null;
  return <span className="ml-2 rounded bg-review-bg px-1.5 py-px align-middle text-[10.5px] text-review">{scan ? "from a scan" : "double-check"}</span>;
}

type EditState = Record<string, { si?: string; bl?: string; result?: string }>;

/** One detail that needs eyes: the two values stacked, only the difference marked, the proof one click away. */
function DiffBlock({ fr, caseId, open, onToggle, index, decide, answer, onAnswer }: {
  fr: FieldResult; caseId: string; open: boolean; onToggle: () => void; index: number;
  decide: boolean; answer?: string; onAnswer: (v: "match" | "mismatch") => void;
}) {
  const [plain, trade] = PLAIN_FIELD[fr.field] ?? [fr.field];
  const si = sideText(fr, "si"), bl = sideText(fr, "bl");
  const [head, , mid, tail] = fr.si?.raw && fr.bl?.raw ? diffParts(si, bl) : ["", "", bl, ""];
  const wrong = fr.result === "mismatch";
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + index * 0.06, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      data-guide={`verify:field:${fr.field}`} className={cn("group/diff rounded-xl border bg-card transition-shadow hover:shadow-[0_2px_10px_rgba(0,0,0,.07)]", open && "shadow-[0_2px_10px_rgba(0,0,0,.07)]")}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="block w-full px-4 py-3 text-left">
        <span className="flex items-baseline gap-1.5 text-[12.5px] text-muted-foreground">{plain}{trade && <span className="opacity-70">· {trade}</span>}<CareTag fr={fr} /></span>
        <span className="mt-1.5 grid grid-cols-[132px_1fr] gap-x-3 gap-y-1 text-[14px] leading-6 max-sm:grid-cols-1">
          <span className="text-muted-foreground">Customer asked for</span>
          <span className={cn("min-w-0 break-words font-medium", !fr.si?.raw && "font-normal italic text-review")}>{si}</span>
          <span className="text-muted-foreground">{fr.bl?.method === "ocr" ? "The scan seems to say" : "The draft says"}</span>
          <span className={cn("min-w-0 break-words font-medium", wrong && "text-mismatch", !fr.bl?.raw && "font-normal italic text-review")}>
            {head}{mid && <mark className={cn("rounded-sm px-0.5 text-inherit", wrong ? "bg-mismatch/15" : "bg-review/15")}>{mid}</mark>}{tail}
          </span>
        </span>
        <span className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-brand transition-colors group-hover/diff:text-brand-strong">
          <Chevron open={open} /> {open ? "Hide the proof" : "See where in the documents"}
        </span>
      </button>
      {decide && fr.result === "unsure" && (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5 text-[13px]">
          <span className="text-muted-foreground">Do these mean the same thing?</span>
          {([["match", "Same"], ["mismatch", "Different"]] as const).map(([v, word]) => (
            <button key={v} type="button" data-guide={v === "match" ? "verify:answer:same" : "verify:answer:different"} onClick={() => onAnswer(v)} aria-pressed={answer === v}
              className={cn("h-8 rounded-full border px-3.5 transition-all active:scale-[.97]", answer === v ? (v === "match" ? "border-ok bg-ok-bg text-ok" : "border-mismatch bg-mismatch-bg text-mismatch") : "hover:bg-accent")}>{word}</button>))}
        </div>
      )}
      <Disclosure open={open}>
        <div className="border-t bg-muted/30 px-4 py-3">
          <div className="mb-2 text-[12px] text-muted-foreground">{fr.reason}</div>
          {open && <Evidence caseId={caseId} si={fr.si} bl={fr.bl} mismatch={wrong} />}
        </div>
      </Disclosure>
    </motion.div>
  );
}

/** A row of the full table. Three columns; "How sure" only when "About this check" is on. */
function FieldRow({ fr, caseId, open, onToggle, editing, edit, setEdit, expert }: {
  fr: FieldResult; caseId: string; open: boolean; onToggle: () => void; editing: boolean; edit: EditState; setEdit: (e: EditState) => void; expert: boolean;
}) {
  const ui = RESULT_UI[fr.result] ?? RESULT_UI.not_compared;
  const icon = useRef<IconHandle>(null);
  const [plain, trade] = PLAIN_FIELD[fr.field] ?? [fr.field];
  const tint = fr.result === "mismatch" ? "bg-mismatch-bg/60 hover:bg-mismatch-bg" : fr.result === "unsure" || fr.result === "missing" ? "bg-review-bg/60 hover:bg-review-bg" : "hover:bg-accent/60";
  const cur = edit[fr.field] ?? {};
  const input = "h-7 w-full rounded border bg-card px-1.5 text-[12.5px] outline-none focus:border-brand focus:ring-2 focus:ring-ring/30";
  return (
    <>
      <tr data-guide={`verify:field:${fr.field}`} onClick={editing ? undefined : onToggle} onMouseEnter={() => icon.current?.startAnimation()} onMouseLeave={() => icon.current?.stopAnimation()}
        className={cn("border-t align-top transition-colors", !editing && "cursor-pointer", tint)}>
        <td className="py-2 pl-4 pr-1"><span className={cn("flex", ui.cls)} title={ui.label}><AnimatedLucide ref={icon} name={ui.icon} size={16} trigger="manual" duration={0.5} /><span className="sr-only">{ui.label}</span></span></td>
        <td className="py-2 pr-3 text-[13px]">{plain}{trade && <span className="ml-1 text-[11.5px] text-muted-foreground">· {trade}</span>}<CareTag fr={fr} /></td>
        {(["si", "bl"] as const).map((side) => (
          <td key={side} className="max-w-0 py-2 pr-3 text-[13px]">
            {editing ? (
              <input className={input} value={cur[side] ?? fr[side]?.raw ?? ""} onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEdit({ ...edit, [fr.field]: { ...cur, [side]: e.target.value } })} />
            ) : (
              <span className={cn("block truncate", fr.result === "match" && "text-foreground/70", !fr[side]?.raw && "italic text-review", fr.result === "mismatch" && side === "bl" && "font-medium text-mismatch")} title={fr[side]?.raw ?? ""}>
                {sideText(fr, side)}
                {fr[side]?.method === "human" && <span className="ml-1 rounded bg-brand-tint px-1 text-[10px] text-brand-strong">fixed by a person</span>}
              </span>
            )}
          </td>
        ))}
        {editing && (
          <td className="py-2 pr-3">
            <select value={cur.result ?? fr.result} onClick={(e) => e.stopPropagation()} onChange={(e) => setEdit({ ...edit, [fr.field]: { ...cur, result: e.target.value } })} className={cn(input, "w-28")}>
              <option value="match">Same</option><option value="mismatch">Different</option>
              {!["match", "mismatch"].includes(fr.result) && <option value={fr.result}>{ui.label}</option>}
            </select>
          </td>
        )}
        {expert && !editing && <td className="py-2 pr-4">{fr.result !== "not_compared" && <ConfidenceBar value={fr.confidence} />}</td>}
      </tr>
      {open && !editing && (
        <tr><td colSpan={expert ? 5 : 4} className="p-0">
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
            <div className="border-t bg-muted/30 px-4 py-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
                <span className={ui.cls}>{fr.reason}</span>
                {expert && fr.si_norm != null && <span>compared as: <code className="rounded bg-card px-1">{fr.si_norm}</code> vs <code className="rounded bg-card px-1">{fr.bl_norm}</code></span>}
              </div>
              <Evidence caseId={caseId} si={fr.si} bl={fr.bl} mismatch={fr.result === "mismatch"} />
            </div>
          </motion.div>
        </td></tr>
      )}
    </>
  );
}

/** "Other options": every action that is not the one obvious next step, each with a line saying what it does. */
function OptionsMenu({ c, compared, settled, onFix, call, setVerdict, refresh }: {
  c: CaseDetail; compared: boolean; settled: boolean; onFix: () => void; refresh: () => void;
  call: (name: string, fn: () => Promise<unknown>, done: string) => Promise<boolean>; setVerdict: (s: string) => void;
}) {
  const { me } = useApp();
  const [page, setPage] = useState<"main" | "overrule" | "hand">("main");
  const Item = ({ icon, title, hint, guide, onClick, disabled }: { icon: IconName; title: string; hint: string; guide: string; onClick: () => void; disabled?: boolean }) => {
    const ref = useRef<IconHandle>(null);
    return (
      <button type="button" data-guide={guide} disabled={disabled} onClick={onClick} onMouseEnter={() => ref.current?.startAnimation()} onMouseLeave={() => ref.current?.stopAnimation()}
        className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent disabled:opacity-45">
        <span className="mt-0.5 text-muted-foreground"><AnimatedLucide ref={ref} name={icon} size={16} trigger="manual" /></span>
        <span className="min-w-0"><span className="block text-[13px]">{title}</span><span className="block text-[12px] leading-4 text-muted-foreground">{hint}</span></span>
      </button>
    );
  };
  return (
    <Popover onOpenChange={(v) => { if (!v) setPage("main"); }} trigger={({ toggle, open }) => (
      <button type="button" data-guide="verify:options" onClick={toggle} aria-expanded={open} className="flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] text-foreground/75 transition hover:bg-accent hover:text-foreground">
        Other options <Chevron open={open} className="rotate-90" />
      </button>)}>
      {(close) => page === "overrule" ? (
        <div className="w-72">
          <button type="button" onClick={() => setPage("main")} className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-accent"><Chevron open={false} className="rotate-180" /> Decide the result yourself</button>
          {["OK", "MISMATCH", "NEEDS_REVIEW"].map((s) => (
            <MenuItem key={s} guide={`verify:verdict:${s}`} active={c.status === s} onClick={() => { close(); setVerdict(s); }}><StatusChip status={s} guide={`verify:verdict:${s}`} /></MenuItem>))}
          {Object.keys(c.overrides ?? {}).length > 0 && (<><div className="my-1 border-t" />
            <MenuItem guide="verify:reset" onClick={() => { close(); call("reset", () => api(`/cases/${c.id}/reset`, { method: "POST" }), "Back to the app's own answer."); }}>Go back to the app's own answer</MenuItem></>)}
        </div>
      ) : page === "hand" ? (
        <div className="w-72">
          <button type="button" onClick={() => setPage("main")} className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-accent"><Chevron open={false} className="rotate-180" /> Hand to someone else</button>
          <AssignMenu ids={[c.id]} current={c.assignee_id} onDone={() => { close(); refresh(); }} />
        </div>
      ) : (
        <div className="w-80">
          {compared && <Item icon="pencil" guide="verify:action:correct" title="Fix something the app misread" hint="Correct a value, or say a row is the same or different." onClick={() => { close(); onFix(); }} />}
          <Item icon="gavel" guide="verify:action:verdict" title="Decide the result yourself" hint="Overrule the app. Your decision sticks." onClick={() => setPage("overrule")} />
          <Item icon="check" guide="verify:action:confirm" disabled={settled} title={settled ? "Already marked as checked" : "Mark as checked, no reply needed"} hint="Says a person looked and agrees." onClick={() => { close(); call("confirm", () => api(`/cases/${c.id}/confirm`, { method: "POST", json: { user_id: me?.id } }), "Marked as checked."); }} />
          <Item icon="flag" guide="verify:action:review" disabled={c.needs_human && !c.resolved} title="Ask a teammate for a second look" hint="Puts it in the 'Needs review' line." onClick={() => { close(); call("review", () => api(`/cases/${c.id}/send-to-review`, { method: "POST", json: { note: "second opinion requested" } }), "Waiting for a second look."); }} />
          <Item icon="user-plus" guide="verify:action:reassign" title="Hand to someone else" hint="Moves it to a teammate's pile." onClick={() => setPage("hand")} />
          <Item icon="rotate-cw" guide="verify:action:retry" title="Run the check again" hint="Reads the documents afresh. Your fixes are kept." onClick={() => { close(); call("retry", () => api(`/cases/${c.id}/retry`, { method: "POST", json: {} }), "Checked again."); }} />
        </div>
      )}
    </Popover>
  );
}

/** The facts behind the answer, for people who want them: one toggle, remembered. */
function AboutPanel({ c }: { c: CaseDetail }) {
  const { users } = useApp();
  const assignee = users.find((u) => u.id === c.assignee_id);
  const Row = ({ label, children, guide }: { label: string; children: ReactNode; guide?: string }) => (
    <div data-guide={guide} className="grid grid-cols-[150px_1fr] gap-3 py-1.5 text-[13px] max-sm:grid-cols-1 max-sm:gap-0"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0">{children}</dd></div>);
  return (
    <dl className="border-t px-4 py-2">
      <Row label="Shipping line" guide="verify:carrier">{c.carrier ?? "The app couldn't tell"}</Row>
      <Row label="In whose pile" guide="verify:assignee">{assignee ? <span className="inline-flex items-center gap-1.5"><Avatar user={assignee} size={18} />{assignee.name}</span> : "Nobody yet"}</Row>
      <Row label="How sure the app is" guide="verify:confidence"><ConfidenceBar value={c.confidence} /></Row>
      {c.docs.length > 0 && <Row label="Files the app read">
        <span className="flex flex-wrap gap-1.5">{c.docs.map((d) => (
          <span key={d.name} data-guide={`verify:doc:${d.name}`} className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[12px]", !d.readable && "border-mismatch/40 bg-mismatch-bg text-mismatch", d.type === "OTHER" && "border-review/40 bg-review-bg text-review")}>
            {d.name}<span className="text-muted-foreground">· {docWords(d)}</span></span>))}</span></Row>}
      {c.status === "NEEDS_REVIEW" && c.review_detail && <Row label="Why the app stopped" guide="verify:reason">{c.review_detail}</Row>}
      {c.status === "FAILED" && c.error && <Row label="What went wrong"><code className="break-words text-[12px] text-failed">{c.error}</code></Row>}
      {Object.keys(c.stages).length > 0 && <Row label="What each step did">
        <span className="flex flex-wrap gap-x-4 gap-y-1">{Object.entries(c.stages).map(([s, v]) => (
          <span key={s} data-guide={`verify:stage:${s}`} className="inline-flex items-center gap-1.5 text-[12.5px]"><span className={cn("size-2 rounded-full", v.status === "done" ? "bg-ok" : v.status === "failed" ? "bg-mismatch" : "bg-muted-foreground/40")} />{STAGE_WORDS[s] ?? s}</span>))}</span></Row>}
      <Row label="Reference" guide="case:id"><span className="font-mono text-[12px]">{c.id}</span></Row>
      {c.activity.length > 0 && <Row label="History" guide="case:activity">
        <span className="grid gap-0.5 text-[12.5px]">{c.activity.map((a, i) => <span key={i}>{a.user} {a.action}{a.detail ? `: ${a.detail}` : ""} <span className="text-muted-foreground">· {fullDate(a.at)}</span></span>)}</span></Row>}
    </dl>
  );
}

const docWords = (d: CaseDetail["docs"][number]) => !d.readable ? "can't be opened"
  : d.type === "OTHER" ? `${(d.subtype ?? "other document").replace(/_/g, " ").toLowerCase()}, not the draft`
  : `${d.role === "SI" ? "customer's instructions" : d.role === "BL" ? "shipping line's draft" : "unknown document"}${d.method === "ocr" ? ", scanned picture" : ""}`;

function AnswerCard({ c, answer, about, setAbout, refresh, from, editing, setEditing }: {
  c: CaseDetail; answer: Answer; about: boolean; setAbout: (v: boolean) => void; refresh: () => void; from: string;
  editing: boolean; setEditing: (v: boolean) => void;       // owned by the page: while fixing values, the reply (and its filled button) steps aside
}) {
  const { me, canEdit } = useApp();
  const compared = wasCompared(c);
  const matter = useMemo(() => rowsThatMatter(c), [c]);
  const others = c.fields.length - matter.length;
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [edit, setEdit] = useState<EditState>({});
  const [answers, setAnswers] = useState<Record<string, "match" | "mismatch">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const spot = useRef<HTMLDivElement>(null);
  const tone = answer.tone === "neutral" ? "brand" : answer.tone;
  const settled = c.resolved && !c.needs_human;
  const decide = answer.step === "decide" && canEdit;
  const unsure = matter.filter((f) => f.result === "unsure");
  const last = c.sent[c.sent.length - 1];

  /** Resolves to whether it worked, so a failed save never throws away what the person typed. */
  const call = async (name: string, fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(name);
    try { await fn(); toast(done); refresh(); return true; } catch (e) { toast((e as Error).message, { kind: "error" }); return false; } finally { setBusy(null); }
  };
  const save = () => {
    const field_values: Record<string, Record<string, string>> = {};
    const field_results: Record<string, string> = {};
    for (const [f, v] of Object.entries(edit)) {
      const fr = c.fields.find((x) => x.field === f)!;
      const sides: Record<string, string> = {};
      if (v.si != null && v.si !== (fr.si?.raw ?? "")) sides.si = v.si;
      if (v.bl != null && v.bl !== (fr.bl?.raw ?? "")) sides.bl = v.bl;
      if (Object.keys(sides).length) field_values[f] = sides;
      if (v.result && v.result !== fr.result && ["match", "mismatch"].includes(v.result)) field_results[f] = v.result;
    }
    if (!Object.keys(field_values).length && !Object.keys(field_results).length) { setEditing(false); return; }
    call("save", () => api(`/cases/${c.id}/correct`, { method: "POST", json: { field_values, field_results, user_id: me?.id } }),
      "Saved. The result and the reply were updated.").then((ok) => { if (ok) { setEditing(false); setEdit({}); } });
  };
  const setVerdict = (status: string) => call("verdict", () => api(`/cases/${c.id}/correct`, {
    method: "POST", json: { verdict: { status, defect_fields: status === "MISMATCH" ? (c.defect_fields.length ? c.defect_fields : c.proposed_defect_fields) : [], review_reason: status === "NEEDS_REVIEW" ? c.review_reason ?? "missing_value" : null }, user_id: me?.id },
  }), "Result changed.");
  const primary = () => {
    if (answer.step === "retry") return call("retry", () => api(`/cases/${c.id}/retry`, { method: "POST", json: {} }), "Checked again.");
    if (answer.step === "confirm") return call("confirm", () => api(`/cases/${c.id}/confirm`, { method: "POST", json: { user_id: me?.id } }), "Thanks. Marked as checked.");
    // only the rows that are in question NOW: an answer given before a row was fixed must not come along
    if (answer.step === "decide") return call("decide", () => api(`/cases/${c.id}/correct`, { method: "POST", json: { field_results: Object.fromEntries(unsure.map((f) => [f.field, answers[f.field]])), user_id: me?.id } }),
      "Saved. The result and the reply were updated.").then((ok) => { if (ok) setAnswers({}); });
  };

  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); spot.current?.style.setProperty("--mx", `${e.clientX - r.left}px`); spot.current?.style.setProperty("--my", `${e.clientY - r.top}px`); }}
      className="group/card relative mt-4 rounded-2xl border bg-card shadow-[0_1px_3px_rgba(0,0,0,.06)]">
      {/* cursor glow (the library's Spotlight Card mechanic) on its own clipped layer, so menus opened inside the card are never cut off */}
      <div ref={spot} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl opacity-0 transition-opacity duration-300 group-hover/card:opacity-100"
        style={{ background: `radial-gradient(360px circle at var(--mx) var(--my), color-mix(in srgb, var(--${tone}) 9%, transparent), transparent 70%)` }} />

      <div data-guide={c.category === "BL_COMPARISON" || c.status === "FAILED" ? "verify:card" : "case:nocheck"} className="relative flex items-start gap-3.5 rounded-t-2xl px-4 py-4" style={{ background: answer.tone === "neutral" ? undefined : `var(--${tone}-bg)` }}>
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-card shadow-sm" style={{ color: answer.done ? undefined : `var(--${tone})` }}>
          <AnimatedLucide name={(answer.done ? "circle-check-big" : answer.icon) as IconName} size={21} duration={0.8} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-medium leading-6" style={{ color: answer.done || answer.tone === "neutral" ? undefined : `var(--${tone})` }}>{answer.headline}</h2>
          {answer.subline && <p data-guide={c.status === "NEEDS_REVIEW" ? "verify:reason" : undefined} className="mt-1 max-w-3xl text-[13.5px] leading-5 text-foreground/75">{answer.subline}</p>}
          {answer.note && <p className="mt-1 text-[12.5px] text-muted-foreground">{answer.note}</p>}
          {answer.done && last && <p data-guide="case:done" className="mt-1 text-[12.5px] text-muted-foreground">Done. {last.user} replied on {fullDate(last.sent_at)}.</p>}
        </div>
      </div>

      {(matter.length > 0 || (compared && others > 0) || (!compared && c.status === "NEEDS_REVIEW")) && (
        <div className="relative grid gap-2.5 border-t px-4 py-3.5">
          {matter.map((fr, i) => (
            <DiffBlock key={fr.field} fr={fr} index={i} caseId={c.id} open={openRow === fr.field} onToggle={() => setOpenRow(openRow === fr.field ? null : fr.field)}
              decide={decide} answer={answers[fr.field]} onAnswer={(v) => setAnswers({ ...answers, [fr.field]: v })} />))}

          {!compared && c.status === "NEEDS_REVIEW" && (
            <div data-guide="verify:files" className="flex flex-wrap gap-2.5">
              {c.attachments.map((a) => <AttachmentChip key={a.name} c={c} name={a.name} />)}
              {c.review_reason === "missing_attachment" && ([["SI", "the customer's instructions"], ["BL", "the shipping line's draft"]] as const)
                .filter(([role]) => !c.docs.some((d) => d.role === role)).map(([role, words]) => (
                  <span key={role} className="flex w-56 items-center gap-2.5 rounded-xl border border-dashed border-review/50 p-2 text-[13px] text-review">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-dashed border-review/50"><AnimatedLucide name="file-question" size={19} /></span>
                    <span>Missing: {words}</span>
                  </span>))}
            </div>
          )}

          {compared && (
            <div>
              <button type="button" data-guide="verify:more" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll || editing}
                className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[13px] text-foreground/75 transition-colors hover:text-foreground">
                <Chevron open={showAll || editing} />
                {matter.length === 0 ? "All 7 details match" : <><AnimatedNumber value={others} /> other detail{others === 1 ? "" : "s"} match{others === 1 ? "es" : ""}</>}
                <span className="text-brand">{showAll || editing ? "Hide" : "Show them"}</span>
              </button>
              <Disclosure open={showAll || editing}>
                <div className="mt-1.5 overflow-hidden rounded-xl border">
                  <table className="w-full table-fixed border-collapse">
                    <thead>
                      <tr className="bg-muted/40 text-left text-[12px] text-muted-foreground">
                        <th data-guide="verify:col:result" className="w-9 py-1.5 pl-4 font-normal"><span className="sr-only">Result</span></th>
                        <th data-guide="verify:col:field" className="w-[30%] py-1.5 font-normal">Detail</th>
                        <th data-guide="verify:col:si" className="py-1.5 font-normal">Customer asked for <span className="opacity-70">· this side counts</span></th>
                        <th data-guide="verify:col:bl" className="py-1.5 font-normal">The draft says</th>
                        {editing && <th className="w-32 py-1.5 font-normal">Your call</th>}
                        {about && !editing && <th data-guide="verify:col:confidence" className="w-[110px] py-1.5 font-normal">How sure</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {[...matter, ...c.fields.filter((f) => !matter.includes(f))].map((fr) => (
                        <FieldRow key={fr.field} fr={fr} caseId={c.id} editing={editing} edit={edit} setEdit={setEdit} expert={about}
                          open={showAll && openRow === `t:${fr.field}`} onToggle={() => setOpenRow(openRow === `t:${fr.field}` ? null : `t:${fr.field}`)} />))}
                    </tbody>
                  </table>
                </div>
              </Disclosure>
            </div>
          )}
        </div>
      )}

      {c.status === "FAILED" && c.error && <div className="relative border-t px-4 py-2.5 font-mono text-[12px] text-failed">{c.error}</div>}

      <div className="relative flex flex-wrap items-center gap-1.5 border-t px-3 py-2.5">
        {editing ? (
          <>
            <MagneticButton guide="verify:action:save" onClick={save} disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save my fixes"}</MagneticButton>
            <Button guide="verify:action:cancel" variant="ghost" onClick={() => { setEditing(false); setEdit({}); }}>Cancel</Button>
            <span className="ml-1 text-[12.5px] text-muted-foreground">Fix a value the app misread, or say a row is the same or different.</span>
          </>
        ) : (
          <>
            {canEdit && answer.step !== "send" && answer.step !== "none" && answer.button && (
              <MagneticButton guide={answer.step === "retry" ? "verify:action:retry" : answer.step === "decide" ? "verify:action:saveanswers" : "verify:action:confirm"}
                onClick={primary} disabled={!!busy || (answer.step === "decide" && unsure.some((f) => !answers[f.field]))}>
                {busy ? <MathCurveLoader size={16} curve="lissajous" strokeWidth={2} /> : null}{answer.button}
              </MagneticButton>)}
            {answer.done && <Button guide="case:back" variant="ghost" onClick={() => navigate(from)}><AnimatedLucide name="arrow-left" size={14} /> Back to the list</Button>}
            {canEdit && (c.category === "BL_COMPARISON" || c.status === "FAILED") && (
              <OptionsMenu c={c} compared={compared} settled={settled} onFix={() => { setEditing(true); setShowAll(true); }} call={call} setVerdict={setVerdict} refresh={refresh} />)}
            {!canEdit && <span className="flex items-center gap-2 px-1.5 text-[12.5px] text-muted-foreground"><AnimatedLucide name="eye" size={15} /> You're looking around as a viewer, so the buttons are switched off.</span>}
            <button type="button" data-guide="verify:about" onClick={() => setAbout(!about)} aria-expanded={about}
              className="ml-auto flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] text-foreground/75 transition hover:bg-accent hover:text-foreground">
              About this check <Chevron open={about} className="rotate-90" />
            </button>
          </>
        )}
      </div>
      <Disclosure open={about && !editing}><AboutPanel c={c} /></Disclosure>
    </motion.section>
  );
}

function AttachmentChip({ c, name }: { c: CaseDetail; name: string }) {
  const [open, setOpen] = useState(false);
  const ext = name.split(".").pop()!.toLowerCase();
  const [icon, color] = FILE_ICON[ext] ?? FILE_ICON.txt;
  const doc = c.docs.find((d) => d.name === name);
  const ref = useRef<IconHandle>(null);
  return (
    <>
      <button data-guide={`case:attachment:${name}`} onClick={() => setOpen(true)} onMouseEnter={() => ref.current?.startAnimation()} onMouseLeave={() => ref.current?.stopAnimation()}
        className="group flex w-56 items-center gap-2.5 overflow-hidden rounded-xl border bg-card p-2 text-left transition-all hover:-translate-y-0.5 hover:shadow-md">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg text-white" style={{ background: color }}><AnimatedLucide ref={ref} name={icon} size={20} trigger="manual" /></span>
        <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{name}</span>
          <span className={cn("block truncate text-[11.5px] first-letter:uppercase", doc && (!doc.readable ? "text-mismatch" : doc.type === "OTHER" ? "text-review" : "text-muted-foreground"))}>{doc ? docWords(doc) : ext.toUpperCase()}</span></span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={name} wide><AttachmentPreview caseId={c.id} name={name} /></Modal>
    </>
  );
}

function AttachmentPreview({ caseId, name }: { caseId: string; name: string }) {
  type Preview = { format: string; readable: boolean; error: string | null; method: string; rows: { text: string; label: string | null; value: string | null; indent: boolean }[] };
  const { data, isLoading } = useQuery({ queryKey: ["preview", caseId, name], queryFn: () => api<Preview>(`/cases/${caseId}/attachments/${encodeURIComponent(name)}/preview`) });
  if (isLoading) return <div className="grid h-40 place-items-center"><MathCurveLoader curve="butterfly" size={48} /></div>;
  if (!data) return null;
  if (!data.readable) return (
    <div className="grid gap-4">
      <div data-guide="case:preview:unreadable" className="rounded-xl bg-mismatch-bg p-4 text-[13px] text-mismatch">No text could be read from this file.<div className="mt-1 font-mono text-[12px]">{data.error}</div></div>
      {/* an image-only scan still has a page to look at (a corrupted file does not: the image just fails to load) */}
      {data.format === "pdf" && <img src={`/api/cases/${caseId}/attachments/${encodeURIComponent(name)}/page/0.png`} alt={name}
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} className="w-full rounded-lg border bg-white" />}
    </div>
  );
  return (
    <div className="grid gap-4">
      {data.format === "pdf" && <img src={`/api/cases/${caseId}/attachments/${encodeURIComponent(name)}/page/0.png`} alt={name} className="w-full rounded-lg border bg-white" />}
      {data.method === "ocr" && <div data-guide="case:preview:ocr" className="rounded-lg bg-review-bg px-3 py-2 text-[12px] text-review">This is a scanned picture. The text below was read off it by software, so treat it as a suggestion.</div>}
      <div data-guide="case:preview:rows" className={cn("overflow-hidden rounded-lg border text-[12.5px] leading-5", data.format === "txt" && "font-mono")}>
        {data.rows.map((r, i) => (
          <div key={i} className="flex border-b last:border-0 odd:bg-muted/30">
            <span className="w-9 shrink-0 select-none border-r bg-muted/50 px-1 text-right font-mono text-[10.5px] text-muted-foreground">{i + 1}</span>
            {r.label != null && data.format !== "txt" ? (<><span className="w-[34%] shrink-0 border-r px-2 text-muted-foreground">{r.label}</span><span className="flex-1 whitespace-pre-wrap px-2">{r.value}</span></>)
              : <span className={cn("flex-1 whitespace-pre-wrap px-2", r.indent && "pl-6")}>{r.text || " "}</span>}
          </div>
        ))}
      </div>
      <a href={`/api/cases/${caseId}/attachments/${encodeURIComponent(name)}`} target="_blank" rel="noreferrer" data-guide="case:preview:open" className="justify-self-end text-[12px] text-brand hover:underline">Open the original file ↗</a>
    </div>
  );
}

export function CaseView({ id, from }: { id: string; from: string }) {
  const { meta, canEdit, me } = useApp();
  const qc = useQueryClient();
  const { data: c, isLoading, error } = useQuery({ queryKey: ["case", id], queryFn: () => api<CaseDetail>(`/cases/${id}`) });
  const [showQuoted, setShowQuoted] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [unfolded, setUnfolded] = useState<boolean | null>(null);      // null = let the email decide
  const [editing, setEditing] = useState(false);
  const [about, setAboutState] = useState(() => remembered("doccheck.about"));
  const setAbout = (v: boolean) => { setAboutState(v); remember("doccheck.about", v); };
  const refresh = () => { qc.invalidateQueries({ queryKey: ["case", id] }); qc.invalidateQueries({ queryKey: ["cases"] }); qc.invalidateQueries({ queryKey: ["counts"] }); };

  useEffect(() => {
    if (c && !c.is_read) api(`/cases/${id}`, { method: "PATCH", json: { is_read: true } }).then(() => { qc.invalidateQueries({ queryKey: ["counts"] }); qc.invalidateQueries({ queryKey: ["cases"] }); });
  }, [c?.id, c?.is_read]); // eslint-disable-line
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return;
      if (document.querySelector("[data-popover-open],[data-modal-open]")) return;      // Escape closes the menu, it must not also leave the page
      if (e.key === "u" || e.key === "Escape") navigate(from);
      if (e.key === "l" && canEdit) setLabelOpen(true);
      if (e.key === "e") patch({ archived: true }, "Conversation archived.", { archived: false }, true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const patch = async (json: Record<string, unknown>, msg: string, undo?: Record<string, unknown>, back?: boolean) => {
    await api(`/cases/${id}`, { method: "PATCH", json }); refresh();
    toast(msg, undo ? { undo: async () => { await api(`/cases/${id}`, { method: "PATCH", json: undo }); refresh(); } } : {});
    if (back) navigate(from);
  };
  const sender = useMemo(() => (c ? { name: senderName(c.sender), color: "#" + ((parseInt(c.sender.replace(/\W/g, "").slice(0, 6), 36) % 0xaaaaaa) + 0x333333).toString(16).slice(0, 6) } : null), [c?.sender]); // eslint-disable-line
  // a shared mailbox ("exports@", "docs@") is not a person: say "The sender" instead of "Exports is asking..."
  const who = (name: string) => (/^(docs?|logistics|exports?|imports?|sales|info|admin|operations|ops|hr|documentation|shipping|team|support|billing|accounts?|no-?reply)$/i.test(name) || name.length < 3 ? "The sender" : name);
  const answer = useMemo(() => (c ? answerFor(c, who(senderName(c.sender).split(" ")[0])) : null), [c]);

  if (isLoading) return (
    <div className="min-h-0 flex-1 rounded-2xl bg-card p-6"><div className="skeleton h-7 w-2/3" /><div className="skeleton mt-6 h-4 w-1/3" /><div className="skeleton mt-3 h-24 w-full" /><div className="skeleton mt-6 h-64 w-full" /></div>
  );
  if (error || !c || !answer) return <div className="flex-1 rounded-2xl bg-card p-10 text-center text-muted-foreground">This conversation could not be loaded.</div>;

  // the email folds to one line only when there is an answer worth reading first
  const foldable = wasCompared(c) && c.status !== "FAILED";
  const open = unfolded ?? !foldable;
  const shownLabels = c.labels.slice(0, 3);

  return (
    <div className="print-area flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_rgba(0,0,0,.06)]">
      <div className="no-print flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <IconButton icon="arrow-left" label="Back to list (u)" guide="case:back" onClick={() => navigate(from)} />
        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton icon="archive" label="Archive (e)" guide="case:archive" onClick={() => patch({ archived: !c.archived }, c.archived ? "Moved to inbox." : "Conversation archived.", { archived: c.archived }, !c.archived)} />
        <IconButton icon="mail" label="Mark as unread" guide="case:unread" onClick={() => patch({ is_read: false }, "Marked as unread.", undefined, true)} />
        {canEdit && (
          <Popover open={labelOpen} onOpenChange={setLabelOpen} trigger={({ toggle }) => <IconButton icon="tag" label="Label (l)" guide="case:label" onClick={toggle} />}>
            {(close) => <LabelPicker ids={[c.id]} current={c.labels} onDone={close} />}
          </Popover>
        )}
        {canEdit && (
          <Popover trigger={({ toggle }) => <button onClick={toggle} data-guide="case:category" className="ml-1 flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-foreground/75 transition hover:bg-accent hover:text-foreground"><span className="text-muted-foreground">Filed as</span>{KIND_PLAIN[c.category] ?? c.category ?? "not checked yet"} ▾</button>}>
            {(close) => (<div className="w-72">
              <div className="px-2.5 pb-1 pt-1 text-[12px] text-muted-foreground">File it as something else · the app is {pct(c.category_confidence)} sure</div>
              {meta?.categories.map((cat) => (
                <MenuItem key={cat} guide={`case:category:option:${cat}`} active={cat === c.category} onClick={async () => { close(); if (cat !== c.category) { await api(`/cases/${c.id}/correct`, { method: "POST", json: { category: cat, user_id: me?.id } }); toast(`Filed as ${KIND_PLAIN[cat] ?? cat}.`); refresh(); } }}>
                  <span className="flex-1">{KIND_PLAIN[cat] ?? cat}</span><span className="text-[11px] tabular-nums text-muted-foreground">{c.classification?.scores?.[cat]?.toFixed(1) ?? ""}</span>
                </MenuItem>))}
              {c.classification?.evidence?.length ? (<><div className="my-1 border-t" /><div data-guide="case:category:why" className="max-h-40 overflow-auto px-2.5 py-1 text-[11px] leading-4 text-muted-foreground">
                <span className="text-foreground/70">Why ({c.classification.decided_by}):</span>{c.classification.evidence.map((e, i) => <div key={i}>{e}</div>)}</div></>) : null}
            </div>)}
          </Popover>
        )}
        <span className="ml-auto" />
        <IconButton icon="printer" label="Print" guide="case:print" onClick={() => window.print()} />
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-5 lg:px-10">
        <div className="mx-auto max-w-[980px]">
          <div className="flex flex-wrap items-start gap-2">
            <h1 className="text-[20px] font-normal leading-7">{readableSubject({ ...c, attachments: c.attachments.length, from: sender?.name }) ?? c.subject}</h1>
            <span className="flex flex-wrap items-center gap-1 pt-1">
              {shownLabels.map((l) => <LabelChip key={l.id} guide={`case:label:${l.id}`} name={l.name} color={l.color} onClick={() => navigate(`/label/${l.id}`)}
                onRemove={canEdit ? async () => { await api("/cases/bulk", { method: "POST", json: { ids: [c.id], action: "unlabel", label_id: l.id } }); refresh(); } : undefined} />)}
              {c.labels.length > 3 && <span className="text-[12px] text-muted-foreground" title={c.labels.slice(3).map((l) => l.name).join(", ")}>+{c.labels.length - 3}</span>}
            </span>
          </div>

          {readableSubject({ ...c, attachments: c.attachments.length, from: sender?.name }) && (
            <p data-guide="case:subject" className="mt-1 truncate text-[12.5px] text-muted-foreground" title={c.subject}>Their subject: {c.subject}</p>)}

          {/* 1 · what they asked */}
          {!open ? (
            <><button type="button" data-guide="case:request" onClick={() => setUnfolded(true)}
              className="no-print group mt-3 flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2 text-left transition-all hover:bg-accent/50 hover:shadow-sm">
              <Avatar user={sender} size={28} />
              <span className="shrink-0 text-[13.5px] font-medium">{sender?.name}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                {c.preview && <AnimatedLucide name="sparkles" size={13} className="mr-1.5 inline align-[-2px] text-brand" />}{c.preview ?? c.body.message.replace(/\s+/g, " ")}</span>
              {c.attachments.length > 0 && <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground"><AnimatedLucide name="paperclip" size={14} />{c.attachments.length}</span>}
              <span className="shrink-0 text-[12px] text-muted-foreground max-md:hidden">{fullDate(c.received_at)}</span>
              <span className="shrink-0 text-[12.5px] text-brand opacity-0 transition-opacity group-hover:opacity-100">Read it</span>
            </button>
            {/* paper has no "unfold": a printout always carries what the customer wrote */}
            <div className="mt-3 hidden whitespace-pre-wrap text-[14px] leading-6 print:block">{sender?.name} &lt;{c.sender}&gt; · {fullDate(c.received_at)}{"\n\n"}{c.body.message}</div></>
          ) : (
            <motion.div initial={foldable ? { opacity: 0, y: -6 } : false} animate={{ opacity: 1, y: 0 }} className="mt-4 flex gap-3">
              <Avatar user={sender} size={40} />
              <div className="min-w-0 flex-1">
                <div data-guide="case:sender" className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[14px] font-medium">{sender?.name}</span><span className="text-[12px] text-muted-foreground">&lt;{c.sender}&gt;</span>
                  <span className="ml-auto text-[12px] text-muted-foreground">{fullDate(c.received_at)}</span>
                  {foldable && <button type="button" data-guide="case:request:fold" onClick={() => setUnfolded(false)} className="rounded-full px-2 text-[12px] text-brand hover:bg-accent">Fold</button>}
                </div>
                {c.body.banner && <div data-guide="case:banner" className="mt-3 rounded-lg border border-[#f4b400]/40 bg-[#fef7e0] px-3 py-1.5 text-[12px] text-[#7a5a00] dark:bg-[#3a2a0a] dark:text-[#f4d58a]">⚠ {c.body.banner}</div>}
                <div data-guide="case:message" className="mt-3 whitespace-pre-wrap text-[14px] leading-6">{c.body.message}</div>
                {(c.body.signature || c.body.quoted) && (
                  <div className="mt-3">
                    <button data-guide="case:quoted" onClick={() => setShowQuoted((v) => !v)} aria-label="Show the sign-off and older emails" title="Show the sign-off and older emails"
                      className="flex h-3.5 items-center rounded-full bg-muted px-2 text-[14px] leading-none tracking-widest text-muted-foreground transition hover:bg-accent">···</button>
                    <AnimatePresence initial={false}>{showQuoted && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                        {c.body.signature && <div data-guide="case:signature" className="mt-2 whitespace-pre-wrap border-l-2 pl-3 text-[12.5px] leading-5 text-muted-foreground">{c.body.signature}</div>}
                        {c.body.quoted && <div className="mt-2 whitespace-pre-wrap border-l-2 border-[#9334e6]/40 pl-3 text-[12.5px] leading-5 text-muted-foreground">{c.body.quoted}</div>}
                      </motion.div>)}</AnimatePresence>
                  </div>
                )}
                {c.attachments.length > 0 && !(c.status === "NEEDS_REVIEW" && !wasCompared(c)) && (
                  <div className="mt-4">
                    <div className="mb-2 text-[13px] text-muted-foreground">{c.attachments.length} file{c.attachments.length > 1 ? "s" : ""} came with this email</div>
                    <div className="flex flex-wrap gap-2.5">{c.attachments.map((a) => <AttachmentChip key={a.name} c={c} name={a.name} />)}</div>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* 2 · what the app found */}
          <AnswerCard key={c.id} c={c} answer={answer} about={about} setAbout={setAbout} refresh={refresh} from={from} editing={editing && canEdit} setEditing={setEditing} />

          {/* 3 · the reply */}
          {c.sent.map((s) => (
            <motion.div key={s.id} data-guide="case:sent" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-4 rounded-2xl border bg-brand-tint/50 p-4">
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><span className="grid size-6 place-items-center rounded-full bg-brand text-[10px] font-medium text-white">{initials(s.user)}</span>
                <span className="text-foreground">{s.user}</span> replied to {s.to}<span className="ml-auto">{fullDate(s.sent_at)}</span></div>
              <div className="mt-2 whitespace-pre-wrap text-[13.5px] leading-6">{s.body}</div>
            </motion.div>
          ))}
          {/* hidden, not unmounted, while values are being fixed: what was typed into the reply must survive a Cancel */}
          {c.draft && (answer.step === "send" || answer.done || !canEdit) && (
            <div className={editing && canEdit ? "hidden" : undefined}>
              <ReplyBox key={c.id + (c.ai_draft?.body ?? "") + c.sent.length + (canEdit ? ":e" : ":v") + (answer.done ? ":d" : "")} c={c} refresh={refresh}
                label={answer.button ?? "Send the reply"} hint={answer.replyHint} readOnly={!canEdit} done={answer.done} />
            </div>)}
        </div>
      </div>
    </div>
  );
}
