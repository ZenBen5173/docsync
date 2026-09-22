// The manager's report. It reads like a document, top to bottom: each section opens with ONE sentence that says
// what the numbers mean, then a ranked bar list that backs it up. Bars are one colour with a label on every row
// (the status colours are too close to tell apart as chart fills, so colour never carries the meaning alone).
import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { useApp } from "@/lib/app";
import { api } from "@/lib/api";
import { fullDate } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Button } from "@/components/bits";
import { EmptyState } from "@/components/MailList";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { GenerateButton } from "@/components/ui/generate-button";

type Hot = { name: string; checked: number; mismatch: number; rate: number };
type Metrics = {
  emails: number; bl_checks: number; compared: number; status: Record<string, number>; categories: Record<string, number>;
  auto_rate: number; review_rate: number; mismatch_rate: number; review_queue_open: number; review_resolved: number;
  avg_minutes_to_resolve: number | null; replies_sent: number; field_mismatches: { field: string; label: string; count: number }[];
  review_reasons: Record<string, number>; carriers: Hot[]; customers: Hot[]; workload: { name: string; assigned: number; open_review: number }[];
  corrections_total: number; correction_rate: number;
  // absent on reports made before these were added
  outcome?: { clean: number; mistake: number; person: number; failed: number; nothing_yet: number };
  app?: { auto_count: number; overruled_cases: number; overruled_rate: number; overruled_by_kind: Record<string, number>; overruled_fields: { label: string; count: number }[]; replies_edited: number; failed: number };
  ai?: { connected: boolean; model: string | null; calls: number; cost_usd: number; tokens: number; budget_usd: number | null; emails_sorted: number; documents_read: number; previews: number };
  learning?: { pending: number; approved: number; rejected: number };
  cost?: { spent_usd: number; budget_usd: number | null; calls: number; per_email_usd: number; per_check_usd: number; per_1000_emails_usd: number; by_task: { task: string; calls: number; cost_usd: number }[] };
};
type Report = { id: number; created_at: string; metrics: Metrics; summary: string; engine: string };
type Options = { carriers: string[]; customers: string[]; labels: string[]; date_min: string | null; date_max: string | null; last: Report | null };

const input = "h-9 rounded-lg border bg-card px-2.5 text-[13px] outline-none transition focus:border-brand focus:ring-2 focus:ring-ring/30";
const usd = (v: number) => (v > 0 && v < 0.0001 ? `$${v.toFixed(6)}` : v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);   // tiny per-email costs must not round to $0
const STEPS = ["Gathering the emails", "Counting what went wrong", "Working out the cost", "Writing the summary"];
const KIND_WORDS: Record<string, string> = { BL_COMPARISON: "Asked for a document check", SI_REQUEST: "New shipping instructions", INVOICE_QUERY: "Invoice questions", GENERAL: "General mail", SPAM: "Junk" };
const REASON_WORDS: Record<string, string> = { missing_attachment: "A document was missing", unreadable: "A file could not be read", wrong_doc_type: "The wrong document was attached", missing_value: "A detail was blank or unclear" };
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** A ranked list of bars: label on the left, thin bar, the figure in plain ink at the end. One colour; the row says what it is. */
function Bars({ rows, tint = "var(--brand)", unit }: { rows: { label: string; value: number; note?: string; dot?: string }[]; tint?: string; unit?: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">Nothing to show for this selection.</p>;
  return (
    <div className="grid gap-2">
      {rows.map((r, i) => (
        <div key={r.label} title={`${r.label}: ${unit ? unit(r.value) : r.value}${r.note ? ` (${r.note})` : ""}`} className="group grid grid-cols-[minmax(0,210px)_1fr_auto] items-center gap-3 text-[13px] max-sm:grid-cols-[1fr_auto]">
          <span className="flex min-w-0 items-center gap-2">{r.dot && <span className="size-2 shrink-0 rounded-full" style={{ background: r.dot }} />}<span className="truncate">{r.label}</span></span>
          <span className="h-2.5 overflow-hidden rounded-r-[4px] bg-muted/70 max-sm:col-span-2 max-sm:row-start-2">
            <motion.span initial={{ width: 0 }} animate={{ width: `${(r.value / max) * 100}%` }} transition={{ type: "spring", stiffness: 150, damping: 26, delay: 0.1 + i * 0.05 }}
              className="block h-full rounded-r-[4px] transition-[filter] group-hover:brightness-110" style={{ background: tint, minWidth: r.value ? 3 : 0 }} />
          </span>
          <span className="whitespace-nowrap text-right tabular-nums text-foreground/80">{unit ? unit(r.value) : r.value}{r.note && <span className="ml-1.5 text-muted-foreground">{r.note}</span>}</span>
        </div>
      ))}
    </div>
  );
}

/** One numbered section of the report: a heading, the sentence that matters, then the evidence. */
function Section({ n, title, lead, children, guide }: { n: number; title: string; lead: ReactNode; children?: ReactNode; guide?: string }) {
  return (
    <motion.section data-guide={guide} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 * n, duration: 0.4, ease: [0.16, 1, 0.3, 1] }} className="border-t py-7">
      <h3 className="flex items-baseline gap-2.5 text-[12.5px] text-muted-foreground"><span className="tabular-nums">{n}</span>{title}</h3>
      <p className="mt-1.5 max-w-3xl text-[17px] leading-7 text-foreground">{lead}</p>
      {children && <div className="mt-5 grid gap-6">{children}</div>}
    </motion.section>
  );
}
const Sub = ({ title, children, guide }: { title: string; children: ReactNode; guide?: string }) => (
  <div data-guide={guide}><div className="mb-2.5 text-[12.5px] text-muted-foreground">{title}</div>{children}</div>);
const Fact = ({ label, children, guide }: { label: string; children: ReactNode; guide?: string }) => (
  <div data-guide={guide} className="rounded-xl border bg-card px-4 py-3 transition-shadow hover:shadow-sm"><div className="flex items-baseline text-[22px] font-medium leading-7 tabular-nums">{children}</div><div className="mt-0.5 text-[12.5px] text-muted-foreground">{label}</div></div>);
const B = ({ children }: { children: ReactNode }) => <span className="font-medium">{children}</span>;

function Md({ text }: { text: string }) {
  return <>{text.replace(/^#+ .*\n+/, "").split(/\n{2,}|\n(?=- )/).map((p, i) => (
    <p key={i} className="mb-2 last:mb-0">{p.replace(/^- /, "").split(/(\*\*[^*]+\*\*)/).map((s, j) => s.startsWith("**") ? <span key={j} className="font-medium text-foreground">{s.slice(2, -2)}</span> : s)}</p>))}</>;
}

export function Analytics() {
  const { meta } = useApp();
  const opts = useQuery({ queryKey: ["analytics-options"], queryFn: () => api<Options>("/analytics/options") }).data;
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(-1);
  // a manager's own figure: how long one check takes by hand. Remembered; only used for the "time saved" estimate.
  const [minutes, setMinutesState] = useState(() => { try { return Number(localStorage.getItem("doccheck.report.minutes")) || 5; } catch { return 5; } });
  const setMinutes = (v: number) => { setMinutesState(v); try { localStorage.setItem("doccheck.report.minutes", String(v)); } catch { /* private mode */ } };
  const rep = report ?? opts?.last ?? null;
  const m = rep?.metrics;
  const set = (k: string, v: string) => setFilters((f) => { const n = { ...f }; if (v) n[k] = v; else delete n[k]; return n; });
  // The numbers really are worked out on request, but in well under a second (and a repeated AI summary is saved), which
  // reads as fake. The report is shown once the work is done AND each step has had a moment on screen.
  const analyze = async () => {
    setBusy(true); setStep(0);
    const paced = (async () => { for (let i = 0; i < STEPS.length; i++) { setStep(i); await new Promise((r) => setTimeout(r, 650 + Math.random() * 450)); } })();
    try { const [r] = await Promise.all([api<Report>("/analytics/analyze", { method: "POST", json: { filters } }), paced]); setReport(r); }
    catch (e) { toast((e as Error).message, { kind: "error" }); } finally { setBusy(false); setStep(-1); }
  };

  const o = m?.outcome;
  const worstField = m?.field_mismatches[0], worstLine = m?.carriers.find((c) => c.mismatch > 0);
  const hours = m?.app ? Math.round((m.app.auto_count * minutes) / 60) : 0;
  const chosen = Object.entries(filters).map(([k, v]) => `${k.replace("_", " ")}: ${v}`).join(" · ");

  return (
    <div className="print-area flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_rgba(0,0,0,.06)]">
      <div className="no-print shrink-0 border-b px-8 pb-4 pt-5">
        <h1 className="text-[22px] font-normal">Report</h1>
        <div data-guide="analytics:filters" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-[12px] text-muted-foreground">From<input type="date" className={input} min={opts?.date_min?.slice(0, 10)} max={opts?.date_max?.slice(0, 10)} onChange={(e) => set("date_from", e.target.value)} /></label>
          <label className="grid gap-1 text-[12px] text-muted-foreground">To<input type="date" className={input} min={opts?.date_min?.slice(0, 10)} max={opts?.date_max?.slice(0, 10)} onChange={(e) => set("date_to", e.target.value)} /></label>
          {([["label", "Tag", opts?.labels], ["carrier", "Shipping line", opts?.carriers], ["customer", "Customer", opts?.customers]] as const).map(([k, title, list]) => (
            <label key={k} className="grid gap-1 text-[12px] text-muted-foreground">{title}
              <select className={`${input} w-44`} onChange={(e) => set(k, e.target.value)}><option value="">All</option>{list?.map((x) => <option key={x}>{x}</option>)}</select></label>))}
          <span data-guide="analytics:analyze" className="inline-block"><GenerateButton label={rep ? "Update report" : "Make report"} activeLabel="Working" isGenerating={busy} hue={172} onClick={analyze} /></span>
          {busy && step >= 0 && (
            <motion.span key={step} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex h-9 items-center gap-2 text-[12.5px] text-muted-foreground">
              <span className="flex gap-1">{STEPS.map((_, i) => <span key={i} className={`size-1.5 rounded-full transition-colors ${i <= step ? "bg-brand" : "bg-muted-foreground/25"}`} />)}</span>
              {STEPS[step]}…
            </motion.span>)}
          {rep && !busy && (<span className="ml-auto flex gap-2">
            <Button guide="analytics:export:md" onClick={() => window.open(`/api/analytics/${rep.id}/export.md`, "_blank")}>Export as text</Button>
            <Button guide="analytics:export:pdf" onClick={() => window.print()}>Print or save as PDF</Button></span>)}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-background/60 px-6 py-6">
        {busy ? (
          <div className="mx-auto max-w-[940px] rounded-2xl border bg-card px-10 py-8"><div className="skeleton h-7 w-1/2" /><div className="skeleton mt-4 h-20 w-full" />
            {[0, 1, 2].map((i) => <div key={i} className="mt-8"><div className="skeleton h-4 w-40" /><div className="skeleton mt-3 h-6 w-4/5" /><div className="skeleton mt-4 h-24 w-full" /></div>)}</div>
        ) : !m ? <EmptyState guide="analytics:empty" icon="file-chart-column" title="No report yet" hint="Pick a date range, tag, shipping line or customer (or leave everything on All), then press “Make report”." /> : (
          <article key={rep!.id} className="mx-auto max-w-[940px] rounded-2xl border bg-card px-10 pb-4 pt-8 shadow-[0_1px_3px_rgba(0,0,0,.05)] max-sm:px-5">
            <header>
              <div className="text-[12.5px] text-muted-foreground">{meta?.product ?? "DocSync"} report · {fullDate(rep!.created_at)} · {chosen || "all emails"}</div>
              <h2 className="mt-1 text-[26px] font-normal leading-9 tracking-tight">
                {o ? <>{o.mistake} of {m.compared} drafts had a mistake, and {m.review_queue_open} {m.review_queue_open === 1 ? "email is" : "emails are"} waiting for a person.</> : "How the document checks went."}
              </h2>
            </header>

            <motion.div data-guide="analytics:summary" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="mb-2 mt-5 rounded-xl border border-brand/20 bg-brand-tint/40 px-5 py-4">
              <div className="mb-1.5 text-[12px] text-brand-strong">In short · {rep!.engine === "llm" ? "written by AI from the numbers below" : "written from fixed sentences"}</div>
              <div className="text-[14px] leading-6 text-foreground/85"><Md text={rep!.summary} /></div>
            </motion.div>

            <Section n={1} guide="analytics:tile:bl_checks" title="What came in"
              lead={<><B>{m.emails}</B> emails. <B>{m.bl_checks}</B> asked for a document check; the other {m.emails - m.bl_checks} needed no check and were only sorted.</>}>
              <Bars rows={Object.entries(m.categories).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: KIND_WORDS[k] ?? k, value: v }))} />
            </Section>

            {o && (
              <Section n={2} guide="analytics:panel:verdicts" title="What the app found"
                lead={<>Of the <B>{m.bl_checks}</B> check requests, <B>{o.clean}</B> were clean and <B>{o.mistake}</B> had a mistake. <B>{o.person}</B> went to a person, and <B>{o.nothing_yet}</B> had no documents to check yet.</>}>
                <Bars rows={[{ label: "Clean: everything matched", value: o.clean, dot: "var(--ok)" }, { label: "A mistake in the draft", value: o.mistake, dot: "var(--mismatch)" },
                  { label: "Sent to a person", value: o.person, dot: "var(--review)" }, { label: "Nothing to check yet", value: o.nothing_yet }, ...(o.failed ? [{ label: "The check failed", value: o.failed, dot: "var(--failed)" }] : [])]} />
                <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
                  <Fact guide="analytics:tile:auto" label="of check requests needed no person"><AnimatedNumber value={Math.round(m.auto_rate * 100)} />%</Fact>
                  <Fact guide="analytics:tile:mismatch" label="of compared drafts had a mistake"><AnimatedNumber value={Math.round(m.mismatch_rate * 100)} />%</Fact>
                  <Fact guide="analytics:tile:queue" label={m.avg_minutes_to_resolve != null ? `waiting now · about ${m.avg_minutes_to_resolve} min to settle one` : `waiting for a person now · ${m.review_resolved} settled`}><AnimatedNumber value={m.review_queue_open} /></Fact>
                </div>
                {Object.keys(m.review_reasons).length > 0 && (
                  <Sub guide="analytics:panel:reasons" title="Why emails went to a person">
                    <Bars rows={Object.entries(m.review_reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: REASON_WORDS[k] ?? k.replace(/_/g, " "), value: v }))} /></Sub>)}
              </Section>)}

            <Section n={3} title="Where the mistakes come from"
              lead={worstField ? <>The detail that goes wrong most is <B>{worstField.label.toLowerCase()}</B> ({plural(worstField.count, "draft")}).{worstLine && <> The shipping line with the most wrong drafts is <B>{worstLine.name}</B> ({worstLine.mismatch} of {worstLine.checked}).</>}</> : "No mistakes in this selection."}>
              <Sub guide="analytics:panel:fields" title="By detail · drafts where it was wrong"><Bars rows={m.field_mismatches.map((f) => ({ label: f.label, value: f.count }))} /></Sub>
              <div className="grid gap-8 lg:grid-cols-2">
                <Sub guide="analytics:panel:carriers" title="By shipping line · wrong drafts"><Bars rows={m.carriers.filter((c) => c.checked > 0).slice(0, 7).map((c) => ({ label: c.name, value: c.mismatch, note: `of ${c.checked}` }))} /></Sub>
                <Sub guide="analytics:panel:customers" title="By customer · wrong drafts"><Bars rows={m.customers.filter((c) => c.checked > 0).slice(0, 7).map((c) => ({ label: c.name, value: c.mismatch, note: `of ${c.checked}` }))} />
                  <p className="mt-2 text-[12.5px] text-muted-foreground">The customer is guessed from the sender's email address.</p></Sub>
              </div>
            </Section>

            <Section n={4} guide="analytics:panel:workload" title="Who is handling it"
              lead={m.workload.length ? <><B>{m.workload[0].name}</B> has the biggest pile ({plural(m.workload[0].assigned, "email")}). {m.replies_sent ? <>{plural(m.replies_sent, "reply", "replies")} sent so far.</> : "No replies have been sent yet."}</> : "No emails are handed to anyone yet."}>
              <Bars rows={m.workload.map((w) => ({ label: w.name, value: w.assigned, note: w.open_review ? `${w.open_review} waiting` : undefined }))} />
            </Section>

            {m.app && m.learning && (
              <Section n={5} title="How well the app is doing"
                lead={m.app.overruled_cases ? <>People changed the app's answer on <B>{plural(m.app.overruled_cases, "check")}</B> ({Math.round(m.app.overruled_rate * 100)}%). It saved roughly <B>{hours} hours</B> of checking by hand.</>
                  : <>Nobody has had to correct the app yet. It saved roughly <B>{hours} hours</B> of checking by hand.</>}>
                <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
                  <Fact guide="analytics:tile:overruled" label="of checks were changed by a person"><AnimatedNumber value={Math.round(m.app.overruled_rate * 100)} />%</Fact>
                  <Fact guide="analytics:tile:saved" label={`hours saved · ${m.app.auto_count} checks needed no person`}><AnimatedNumber value={hours} /></Fact>
                  <Fact guide="analytics:tile:learned" label={`rules learned from the team · ${m.learning.pending} waiting for a yes or no`}><AnimatedNumber value={m.learning.approved} /></Fact>
                </div>
                <label data-guide="analytics:minutes" className="no-print flex items-center gap-2 text-[12.5px] text-muted-foreground">One check by hand takes about
                  <input type="number" min={1} max={60} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} className={`${input} h-7 w-16 text-center`} /> minutes. Put in your own figure.</label>
                {m.app.overruled_fields.length > 0 && <Sub guide="analytics:panel:overruled" title="Details people corrected most"><Bars rows={m.app.overruled_fields.map((f) => ({ label: f.label, value: f.count }))} /></Sub>}
              </Section>)}

            {m.cost && m.ai && (
              <Section n={6} guide="analytics:panel:cost" title="What the AI costs"
                lead={m.ai.connected || m.cost.spent_usd > 0 ? <>The AI has cost <B>{usd(m.cost.spent_usd)}</B> so far{m.cost.budget_usd ? <> of a {usd(m.cost.budget_usd)} cap</> : null}. That is about <B>{usd(m.cost.per_1000_emails_usd)}</B> for every 1,000 emails.</>
                  : "No AI is connected, so every result came from fixed rules and cost nothing."}>
                <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
                  <Fact guide="analytics:tile:ai" label={`spent so far · ${m.cost.calls} calls`}>{usd(m.cost.spent_usd)}</Fact>
                  <Fact label="per email">{usd(m.cost.per_email_usd)}</Fact>
                  <Fact label="per 1,000 emails">{usd(m.cost.per_1000_emails_usd)}</Fact>
                </div>
                {m.cost.by_task.length > 0 && <Sub title="Where the money went"><Bars unit={usd} rows={m.cost.by_task.map((t) => ({ label: t.task, value: t.cost_usd, note: `${t.calls} calls` }))} /></Sub>}
                <Sub guide="analytics:panel:ai" title="What the AI did">
                  <Bars rows={[{ label: "Emails summarised for Avery", value: m.ai.previews }, { label: "Unclear emails sorted", value: m.ai.emails_sorted }, { label: "Hard documents read", value: m.ai.documents_read }]} />
                  <p className="mt-3 text-[12.5px] leading-5 text-muted-foreground">The comparing is always done by fixed rules. The AI only helps with what is messy, its answers are saved so nothing is paid for twice, and when the cap is reached the app carries on with rules alone.</p>
                </Sub>
              </Section>)}
          </article>
        )}
      </div>
    </div>
  );
}
