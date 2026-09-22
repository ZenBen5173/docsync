// Admin centre, laid out like Gmail Settings: a title and tabs across the top.
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/lib/app";
import { api, type User } from "@/lib/api";
import { navigate } from "@/lib/router";
import { fullDate } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Avatar, Button, IconButton, LabelChip } from "@/components/bits";
import { GenerateButton } from "@/components/ui/generate-button";
import { EmptyState } from "@/components/MailList";

const TABS: [string, string][] = [["labels", "Labels and rules"], ["routing", "Routing"], ["team", "Team"], ["thresholds", "Thresholds"], ["kb", "Knowledge base"], ["learning", "Learning report"]];
const input = "h-9 rounded-lg border bg-card px-2.5 text-[13px] outline-none transition focus:border-brand focus:ring-2 focus:ring-ring/30";
const RULE_FIELDS = ["carrier", "customer", "sender", "sender_domain", "subject", "body", "category", "status", "review_reason", "defect_field", "pod"];
const RULE_OPS = ["contains", "is", "is_not", "starts_with", "ends_with", "regex"];
const COLORS = ["#1a73e8", "#d93025", "#188038", "#e37400", "#9334e6", "#007b83", "#b06000", "#e52592", "#5f6368"];

type Rule = { id?: number; name: string; conditions: { field: string; op: string; value: string }[]; label_id: number | null; enabled: boolean };
type RouteRow = { id?: number; label_id: number | null; user_id: number | null; backup_user_id: number | null; priority: number };
type KBItem = { id?: number; kind: string; key: string; value: string; note?: string; source?: string; active?: boolean; meta?: Record<string, unknown> };
type Suggestion = { id: number; kind: string; title: string; rationale: string; evidence_count: number; evidence: string[]; status: string; payload: KBItem; decided_by?: string };

function Section({ title, hint, children, action, guide }: { title: string; hint?: string; children: ReactNode; action?: ReactNode; guide?: string }) {
  return (
    <section className="grid gap-x-8 gap-y-3 border-b py-6 last:border-0 lg:grid-cols-[220px_1fr]">
      <div data-guide={guide}><div className="text-[14px] font-semibold">{title}</div>{hint && <div className="mt-1 text-[12px] leading-5 text-muted-foreground">{hint}</div>}{action && <div className="mt-3">{action}</div>}</div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => { keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); qc.invalidateQueries({ queryKey: ["counts"] }); qc.invalidateQueries({ queryKey: ["cases"] }); };
}

// ------------------------------------------------------------------ labels & rules
function LabelsTab() {
  const { counts, isAdmin } = useApp();
  const inv = useInvalidate();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api<Rule[]>("/rules") }).data ?? [];
  const [draft, setDraft] = useState<Rule | null>(null);
  const [name, setName] = useState("");
  const labels = counts?.labels ?? [];
  const saveRule = useMutation({
    mutationFn: (r: Rule) => api<{ retagged: number }>("/rules", { method: "POST", json: r }),
    onSuccess: (r) => { setDraft(null); inv("rules"); toast(`Rule saved — ${r.retagged} cases re-tagged and re-routed live.`); },
    onError: (e: Error) => toast(e.message, { kind: "error" }),      // e.g. a regex the server refuses
  });
  return (
    <>
      <Section guide="admin:labels" title="Labels" hint="Auto labels come from the documents (shipping line, customer, port of discharge). Custom labels are yours; attach rules or routing to either.">
        <div className="flex flex-wrap gap-2">
          {labels.map((l) => (
            <span key={l.id} data-guide={`admin:label:${l.id}`} className="group flex items-center gap-2 rounded-full border bg-card py-1 pl-2.5 pr-1.5 text-[12.5px] transition hover:shadow-sm">
              <span className="size-2.5 rounded-full" style={{ background: l.color }} />{l.name}
              <span className="tabular-nums text-muted-foreground">{l.count}</span>
              <span className="rounded bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground">{l.group ?? l.kind}</span>
              {isAdmin && l.kind === "custom" && (
                <>
                  <span className="hidden gap-0.5 group-hover:flex">{COLORS.slice(0, 6).map((c) => (
                    <button key={c} aria-label="Set colour" onClick={async () => { await api(`/labels/${l.id}`, { method: "PUT", json: { color: c } }); inv(); }} className="size-3 rounded-full ring-offset-1 hover:ring-2" style={{ background: c }} />))}</span>
                  <button aria-label={`Delete ${l.name}`} data-guide="admin:label:delete" className="rounded-full px-1 text-muted-foreground hover:bg-mismatch-bg hover:text-mismatch"
                    onClick={async () => { if (confirm(`Delete label “${l.name}”? Its rules and routes go too.`)) { await api(`/labels/${l.id}`, { method: "DELETE" }); inv("rules", "routes"); toast("Label deleted."); } }}>×</button>
                </>
              )}
            </span>
          ))}
        </div>
        {isAdmin && (
          <form className="mt-4 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; try { await api("/labels", { method: "POST", json: { name: name.trim() } }); setName(""); inv(); toast("Label created."); } catch (err) { toast((err as Error).message, { kind: "error" }); } }}>
            <input className={cn(input, "w-64")} placeholder="New label name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button guide="admin:labels:create" type="submit" variant="primary" disabled={!name.trim()}>Create label</Button>
          </form>
        )}
      </Section>
      <Section guide="admin:rules" title="Auto-tag rules" hint="When ALL conditions match, the label is applied. Saving a rule re-tags and re-routes every existing case immediately."
        action={isAdmin && <Button guide="admin:rules:new" onClick={() => setDraft({ name: "", conditions: [{ field: "carrier", op: "contains", value: "" }], label_id: labels[0]?.id ?? null, enabled: true })}>+ New rule</Button>}>
        <div className="grid gap-2">
          {rules.map((r) => {
            const lab = labels.find((l) => l.id === r.label_id);
            return (
              <motion.div layout key={r.id} data-guide="admin:rule" className={cn("flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2 text-[13px] transition hover:shadow-sm", !r.enabled && "opacity-55")}>
                <b className="mr-1">{r.name}</b>
                <span className="text-muted-foreground">if</span>
                {r.conditions.map((c, i) => <code key={i} className="rounded bg-muted px-1.5 py-0.5 text-[12px]">{c.field} {c.op} “{c.value}”</code>)}
                <span className="text-muted-foreground">→</span>{lab && <LabelChip name={lab.name} color={lab.color} />}
                {isAdmin && <span className="ml-auto flex items-center">
                  <IconButton icon={r.enabled ? "toggle-right" : "toggle-left"} label={r.enabled ? "Disable" : "Enable"} guide="admin:rule:toggle" onClick={() => saveRule.mutate({ ...r, enabled: !r.enabled })} />
                  <IconButton icon="pencil" label="Edit" guide="admin:rule:edit" onClick={() => setDraft(r)} />
                  <IconButton icon="trash-2" label="Delete" guide="admin:rule:delete" onClick={async () => { await api(`/rules/${r.id}`, { method: "DELETE" }); inv("rules"); toast("Rule deleted — cases re-tagged."); }} />
                </span>}
              </motion.div>
            );
          })}
          {!rules.length && <div className="text-[13px] text-muted-foreground">No rules yet.</div>}
        </div>
        <AnimatePresence>{draft && (
          <motion.div data-guide="admin:ruleeditor" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 rounded-2xl border bg-brand-tint/40 p-4">
            <input className={cn(input, "w-full")} placeholder="Rule name, e.g. “Maersk drafts”" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <div className="mt-3 grid gap-2">{draft.conditions.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-8 text-[12px] text-muted-foreground">{i ? "and" : "if"}</span>
                <select className={input} value={c.field} onChange={(e) => setDraft({ ...draft, conditions: draft.conditions.map((x, j) => j === i ? { ...x, field: e.target.value } : x) })}>{RULE_FIELDS.map((f) => <option key={f}>{f}</option>)}</select>
                <select className={input} value={c.op} onChange={(e) => setDraft({ ...draft, conditions: draft.conditions.map((x, j) => j === i ? { ...x, op: e.target.value } : x) })}>{RULE_OPS.map((f) => <option key={f}>{f}</option>)}</select>
                <input className={cn(input, "min-w-40 flex-1")} placeholder="value" value={c.value} onChange={(e) => setDraft({ ...draft, conditions: draft.conditions.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} />
                {draft.conditions.length > 1 && <IconButton icon="x" label="Remove condition" onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })} />}
              </div>))}</div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { field: "sender_domain", op: "is", value: "" }] })}>+ condition</Button>
              <span className="text-[13px] text-muted-foreground">apply label</span>
              <select className={input} value={draft.label_id ?? ""} onChange={(e) => setDraft({ ...draft, label_id: Number(e.target.value) })}>{labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              <span className="ml-auto flex gap-2"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                <Button guide="admin:ruleeditor:save" variant="primary" disabled={!draft.label_id || draft.conditions.some((c) => !c.value) || saveRule.isPending} onClick={() => saveRule.mutate({ ...draft, name: draft.name || "Untitled rule" })}>Save and re-tag</Button></span>
            </div>
          </motion.div>)}</AnimatePresence>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ routing
function RoutingTab() {
  const { counts, users, isAdmin } = useApp();
  const inv = useInvalidate();
  const routes = useQuery({ queryKey: ["routes"], queryFn: () => api<RouteRow[]>("/routes") }).data ?? [];
  const labels = counts?.labels ?? [];
  const people = users.filter((u) => u.role !== "viewer");
  const save = async (r: RouteRow) => { const out = await api<{ retagged: number }>("/routes", { method: "POST", json: r }); inv("routes"); toast(`Routing saved — ${out.retagged} cases re-routed.`); };
  return (
    <Section guide="admin:routing" title="Tag → person" hint="Each person works their own carrier's or customer's queue. The first matching route wins (higher priority first). If the primary person is inactive, the backup gets the case. Manual assignments are never overwritten."
      action={isAdmin && <Button guide="admin:routing:new" onClick={() => save({ label_id: labels[0]?.id ?? null, user_id: people[0]?.id ?? null, backup_user_id: null, priority: 0 })}>+ New route</Button>}>
      <div className="overflow-hidden rounded-xl border">
        <div className="grid grid-cols-[1.2fr_1.2fr_1.2fr_90px_44px] gap-2 bg-muted/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"><span>Label</span><span>Primary</span><span>Backup</span><span>Priority</span><span /></div>
        {routes.map((r) => (
          <motion.div layout key={r.id} data-guide="admin:route" className="grid grid-cols-[1.2fr_1.2fr_1.2fr_90px_44px] items-center gap-2 border-t px-3 py-1.5 transition-colors hover:bg-accent/40">
            <select disabled={!isAdmin} className={input} value={r.label_id ?? ""} onChange={(e) => save({ ...r, label_id: Number(e.target.value) })}>{labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
            <select disabled={!isAdmin} className={input} value={r.user_id ?? ""} onChange={(e) => save({ ...r, user_id: Number(e.target.value) })}>{people.map((u) => <option key={u.id} value={u.id}>{u.name}{u.active ? "" : " (inactive)"}</option>)}</select>
            <select disabled={!isAdmin} className={input} value={r.backup_user_id ?? ""} onChange={(e) => save({ ...r, backup_user_id: e.target.value ? Number(e.target.value) : null })}><option value="">— none —</option>{people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            <input data-guide="admin:route:priority" disabled={!isAdmin} type="number" className={input} defaultValue={r.priority} onBlur={(e) => Number(e.target.value) !== r.priority && save({ ...r, priority: Number(e.target.value) })} />
            {isAdmin ? <IconButton icon="trash-2" label="Delete route" guide="admin:route:delete" onClick={async () => { await api(`/routes/${r.id}`, { method: "DELETE" }); inv("routes"); toast("Route deleted — cases re-routed."); }} /> : <span />}
          </motion.div>
        ))}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ team
function TeamTab() {
  const { users, isAdmin, me } = useApp();
  const inv = useInvalidate();
  const [name, setName] = useState("");
  const save = async (u: Partial<User>) => {
    try { await api("/users", { method: "POST", json: u }); }
    catch (e) { toast((e as Error).message, { kind: "error" }); inv("users"); throw e; }   // e.g. "at least one active admin is required"
    inv("users", "meta");
  };
  return (
    <Section guide="admin:team" title="Team and roles" hint="admin: everything. reviewer: review, correct, reply. viewer: read only. Switch who you are from the avatar at the top right (demo - no real sign-in). Deactivating someone hands their queue to the backup.">
      <div className="grid gap-2">
        {users.map((u) => (
          <motion.div layout key={u.id} className={cn("flex flex-wrap items-center gap-3 rounded-xl border bg-card px-3 py-2 transition hover:shadow-sm", !u.active && "opacity-55")}>
            <Avatar user={u} size={34} />
            <div className="min-w-40 flex-1"><div className="text-[13.5px] font-medium">{u.name}{u.id === me?.id && <span className="ml-2 rounded bg-brand-tint px-1.5 text-[10px] font-semibold text-brand-strong">you</span>}</div><div className="text-[12px] text-muted-foreground">{u.email}</div></div>
            <select data-guide="admin:team:role" disabled={!isAdmin} className={input} value={u.role} onChange={(e) => save({ ...u, role: e.target.value as User["role"] }).then(() => toast("Role updated."), () => {})}><option>admin</option><option>reviewer</option><option>viewer</option></select>
            {isAdmin && <Button guide="admin:team:active" variant={u.active ? "outline" : "primary"} onClick={() => save({ ...u, active: !u.active }).then(() => toast(u.active ? `${u.name} deactivated — queue moved to backups.` : `${u.name} reactivated.`), () => {})}>{u.active ? "Deactivate" : "Activate"}</Button>}
          </motion.div>
        ))}
      </div>
      {isAdmin && (
        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save({ name: name.trim(), email: name.trim().toLowerCase().replace(/\s+/g, ".") + "@averis.example", role: "reviewer", color: COLORS[users.length % COLORS.length] }).then(() => { setName(""); toast("Teammate added."); }, () => {}); }}>
          <input className={cn(input, "w-64")} placeholder="Add teammate (full name)" value={name} onChange={(e) => setName(e.target.value)} /><Button guide="admin:team:add" type="submit" variant="primary" disabled={!name.trim()}>Add</Button>
        </form>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ thresholds
function Slider({ label, hint, value, onChange, min = 0, max = 1, step = 0.01, fmt = (v: number) => `${Math.round(v * 100)}%`, disabled, guide }: { guide?: string; label: string; hint?: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; fmt?: (v: number) => string; disabled?: boolean }) {
  return (
    <label data-guide={guide} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-3 py-2.5 transition hover:shadow-sm">
      <span><span className="text-[13px] font-medium">{label}</span>{hint && <span className="block text-[12px] text-muted-foreground">{hint}</span>}</span>
      <span className="w-16 text-right text-[15px] font-semibold tabular-nums text-brand-strong">{fmt(value)}</span>
      <input disabled={disabled} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="col-span-2 accent-[var(--brand)]" />
    </label>
  );
}
function ThresholdsTab() {
  const { meta, isAdmin } = useApp();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api<{ values: Record<string, never>; defaults: Record<string, never> }>("/settings") });
  const [local, setLocal] = useState<Record<string, unknown> | null>(null);
  if (!data) return null;
  const v = { ...data.values, ...(local ?? {}) } as Record<string, number | boolean | Record<string, number>>;
  const set = (k: string, val: unknown) => setLocal({ ...(local ?? {}), [k]: val });
  const ft = (v.field_thresholds ?? {}) as Record<string, number>;
  const dt = (v.doctype_thresholds ?? {}) as Record<string, number>;
  return (
    <>
      <Section title="Auto vs review" hint="Results above the threshold go straight to the report. Anything below, or any unsure field, goes to the review queue with the reason and evidence. Changes apply to the next run or retry.">
        <div className="grid gap-2 xl:grid-cols-2">
          <Slider guide="admin:thresholds:classify_review_below" disabled={!isAdmin} label="Classification: review below" hint="Category confidence under this flags the email for a person" value={v.classify_review_below as number} onChange={(x) => set("classify_review_below", x)} />
          <Slider guide="admin:thresholds:field_review_below" disabled={!isAdmin} label="Fields: review below (default)" hint="Any compared field under this becomes “unsure”" value={v.field_review_below as number} onChange={(x) => set("field_review_below", x)} />
          <Slider guide="admin:thresholds:party_fuzzy_match" disabled={!isAdmin} label="Party names: treat as same company at" hint="Similarity for spelling-level variation" value={v.party_fuzzy_match as number} onChange={(x) => set("party_fuzzy_match", x)} min={0.8} />
          <Slider guide="admin:thresholds:party_fuzzy_unsure" disabled={!isAdmin} label="Party names: unsure above" hint="Between this and the match level a person decides" value={v.party_fuzzy_unsure as number} onChange={(x) => set("party_fuzzy_unsure", x)} min={0.6} />
          <Slider guide="admin:thresholds:weight_tolerance_kg" disabled={!isAdmin} label="Gross weight tolerance (kg)" hint="Absolute difference still counted as a match (rounding only)" value={v.weight_tolerance_kg as number} onChange={(x) => set("weight_tolerance_kg", x)} min={0} max={100} step={0.5} fmt={(x) => `${x} kg`} />
          <Slider guide="admin:thresholds:weight_tolerance_pct" disabled={!isAdmin} label="Gross weight tolerance (%)" hint="Relative tolerance; the larger of the two applies" value={v.weight_tolerance_pct as number} onChange={(x) => set("weight_tolerance_pct", x)} min={0} max={2} step={0.05} fmt={(x) => `${x}%`} />
        </div>
      </Section>
      <Section title="Per field" hint="Override the default review threshold for a single field, e.g. be stricter on consignee.">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{meta?.fields.map((f) => (
          <Slider key={f} guide={`admin:thresholds:field:${f}`} disabled={!isAdmin} label={meta.field_labels[f]} value={ft[f] ?? (v.field_review_below as number)} onChange={(x) => set("field_thresholds", { ...ft, [f]: x })} />))}</div>
      </Section>
      <Section title="Per document type" hint="Scanned, image-only documents are read with OCR. By default their values are proposals only and the case is escalated as “unreadable”.">
        <div className="grid gap-2 xl:grid-cols-2">
          <label data-guide="admin:thresholds:ocr_auto_accept" className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-[13px]"><input disabled={!isAdmin} type="checkbox" className="size-4 accent-[var(--brand)]" checked={!!v.ocr_auto_accept} onChange={(e) => set("ocr_auto_accept", e.target.checked)} />
            <span><b className="font-medium">Auto-accept OCR results</b><span className="block text-[12px] text-muted-foreground">Off = scans always go to a person (recommended)</span></span></label>
          <Slider guide="admin:thresholds:ocr_min" disabled={!isAdmin} label="OCR: minimum confidence" hint="Used only when auto-accept is on" value={dt.ocr ?? 0.99} onChange={(x) => set("doctype_thresholds", { ...dt, ocr: x })} min={0.5} />
          <label data-guide="admin:thresholds:llm_enabled" className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-[13px]"><input disabled={!isAdmin} type="checkbox" className="size-4 accent-[var(--brand)]" checked={!!v.llm_enabled} onChange={(e) => set("llm_enabled", e.target.checked)} />
            <span><b className="font-medium">Use the LLM when rules are unsure</b><span className="block text-[12px] text-muted-foreground">{meta?.llm.available ? `${meta.llm.provider} · ${meta.llm.model}` : "No API key configured — deterministic parsers only"}</span></span></label>
        </div>
        {isAdmin && <div className="mt-4 flex gap-2">
          <Button guide="admin:thresholds:save" variant="primary" disabled={!local} onClick={async () => { await api("/settings", { method: "PUT", json: local }); setLocal(null); qc.invalidateQueries({ queryKey: ["settings"] }); toast("Thresholds saved — they apply to the next run or retry."); }}>Save thresholds</Button>
          <Button guide="admin:thresholds:restore" variant="ghost" onClick={async () => { await api("/settings", { method: "PUT", json: data.defaults }); setLocal(null); qc.invalidateQueries({ queryKey: ["settings"] }); toast("Defaults restored."); }}>Restore defaults</Button>
        </div>}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ knowledge base
const KB_KINDS: Record<string, [string, string, string]> = {
  port_alias: ["Port alias", "variant as written", "canonical port"], party_alias: ["Company alias", "variant as written", "canonical company"],
  label_alias: ["Field label alias", "label text in documents", "field id (e.g. consignee)"], classifier_hint: ["Classifier hint", "regex on subject/body", "category"],
  carrier_prefix: ["Carrier B/L prefix", "B/L or booking number prefix (e.g. MEDU)", "shipping line"],
  reply_rule: ["Reply template line", "OK | MISMATCH | NEEDS_REVIEW | ALL", "sentence to add ({bl_no} {oc_no} allowed)"], example: ["Extraction example", "situation", "what staff decided"],
};
function KBTab() {
  const { isAdmin } = useApp();
  const inv = useInvalidate();
  type H = { id: number; action: string; before: KBItem | null; after: KBItem | null; user: string; at: string };
  const { data } = useQuery({ queryKey: ["kb"], queryFn: () => api<{ items: KBItem[]; history: H[] }>("/kb") });
  const [draft, setDraft] = useState<KBItem | null>(null);
  const save = async (it: KBItem) => { try { await api("/kb", { method: "POST", json: it }); setDraft(null); inv("kb"); toast("Knowledge base updated — used from the next run."); } catch (e) { toast((e as Error).message, { kind: "error" }); } };
  const kinds = Object.keys(KB_KINDS);
  return (
    <>
      <Section guide="admin:kb" title="Knowledge base" hint="Consulted before the pipeline calls a mismatch: aliases are applied ahead of comparison, label aliases during extraction, reply lines in the auto-draft. Only approved items are ever used."
        action={isAdmin && <Button guide="admin:kb:add" onClick={() => setDraft({ kind: "port_alias", key: "", value: "", note: "" })}>+ Add item</Button>}>
        <AnimatePresence>{draft && (
          <motion.form initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4 grid gap-2 rounded-2xl border bg-brand-tint/40 p-4 md:grid-cols-[170px_1fr_1fr]"
            onSubmit={(e) => { e.preventDefault(); save(draft); }}>
            <select className={input} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>{kinds.map((k) => <option key={k} value={k}>{KB_KINDS[k][0]}</option>)}</select>
            <input className={input} placeholder={KB_KINDS[draft.kind][1]} value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
            <input className={input} placeholder={KB_KINDS[draft.kind][2]} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
            <input className={cn(input, "md:col-span-2")} placeholder="Note (why this exists)" value={draft.note ?? ""} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            <span className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" variant="primary" disabled={!draft.key || !draft.value}>Save</Button></span>
          </motion.form>)}</AnimatePresence>
        {kinds.map((k) => {
          const items = (data?.items ?? []).filter((i) => i.kind === k);
          if (!items.length) return null;
          return (
            <div key={k} className="mb-4">
              <div data-guide={`admin:kb:group:${k}`} className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{KB_KINDS[k][0]} · {items.length}</div>
              <div className="overflow-hidden rounded-xl border">{items.map((it) => (
                <div key={it.id} data-guide="admin:kb:item" className={cn("group flex items-center gap-3 border-b px-3 py-1.5 text-[13px] transition-colors last:border-0 hover:bg-accent/40", it.active === false && "opacity-50")}>
                  <code className="max-w-[34%] truncate rounded bg-muted px-1.5 py-0.5 text-[12px]">{it.key}</code><span className="text-muted-foreground">→</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{it.value}</span>
                  <span className="hidden truncate text-[12px] text-muted-foreground lg:block">{it.note}</span>
                  <span className={cn("rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide", it.source === "learned" ? "bg-brand-tint text-brand-strong" : "bg-muted text-muted-foreground")}>{it.source}</span>
                  {isAdmin && <span className="flex opacity-0 transition-opacity group-hover:opacity-100">
                    <IconButton icon="pencil" label="Edit" onClick={() => setDraft(it)} className="size-8" />
                    <IconButton icon="trash-2" label="Remove" guide="admin:kb:item:remove" className="size-8" onClick={async () => { await api(`/kb/${it.id}`, { method: "DELETE" }); inv("kb"); toast("Item removed (kept in history)."); }} />
                  </span>}
                </div>))}</div>
            </div>
          );
        })}
      </Section>
      <Section guide="admin:kb:history" title="History" hint="Every add, edit and removal, with who did it.">
        <div className="grid gap-1 text-[12.5px]">{(data?.history ?? []).slice(0, 25).map((h) => (
          <div key={h.id} className="flex flex-wrap items-baseline gap-2 rounded-lg px-2 py-1 odd:bg-muted/40">
            <span className={cn("w-14 rounded px-1 text-center text-[10px] font-bold uppercase", h.action === "add" ? "bg-ok-bg text-ok" : h.action === "remove" ? "bg-mismatch-bg text-mismatch" : "bg-review-bg text-review")}>{h.action}</span>
            <span className="min-w-0 flex-1 truncate"><code>{(h.after ?? h.before)?.key}</code> → {(h.after ?? h.before)?.value}</span>
            <span className="text-muted-foreground">{h.user} · {fullDate(h.at)}</span>
          </div>))}
          {!data?.history.length && <span className="text-muted-foreground">No changes yet.</span>}</div>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ learning report
function LearningTab() {
  const { isAdmin, meta } = useApp();
  const inv = useInvalidate();
  type Corr = { id: number; email_id: string; kind: string; field: string | null; ai_value: string; final_value: string; user: string; at: string; consumed: boolean };
  const { data } = useQuery({ queryKey: ["learning"], queryFn: () => api<{ reports: { id: number; created_at: string; summary: string; corrections: number; engine: string }[]; suggestions: Suggestion[]; unprocessed_corrections: number; corrections: Corr[] }>("/learning") });
  const [busy, setBusy] = useState(false);
  const pending = (data?.suggestions ?? []).filter((s) => s.status === "pending");
  const decided = (data?.suggestions ?? []).filter((s) => s.status !== "pending").slice(0, 12);
  const generate = async () => { setBusy(true); try { const r = await api<{ suggestions: number; summary: string }>("/learning/generate", { method: "POST", json: {} }); inv("learning"); toast(r.suggestions ? `${r.suggestions} new suggestion(s) ready for review.` : r.summary); } finally { setTimeout(() => setBusy(false), 600); } };
  const decide = async (s: Suggestion, approve: boolean) => { await api(`/learning/suggestions/${s.id}/${approve ? "approve" : "reject"}`, { method: "POST" }); inv("learning", "kb"); toast(approve ? "Added to the knowledge base — re-run the pipeline to apply it." : "Suggestion rejected."); };
  return (
    <>
      <Section guide="admin:learning" title="Daily learning report" hint={`Staff edits are stored as diffs (AI version vs final). This job groups them into proposed knowledge-base changes${meta?.llm.available ? " with the LLM" : " (deterministic grouper - no LLM key set)"}. Nothing is used until you press Add.`}
        action={isAdmin && <span data-guide="admin:learning:generate" className="inline-block"><GenerateButton label="Generate now" activeLabel="Learning" isGenerating={busy} hue={172} onClick={generate} /></span>}>
        <div data-guide="admin:learning:waiting" className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-[13px]">
          <span className="text-[26px] font-semibold tabular-nums text-brand-strong">{data?.unprocessed_corrections ?? 0}</span>
          <span className="text-muted-foreground">staff correction(s) waiting for the next report</span>
          {data?.reports[0] && <span className="ml-auto max-w-xl text-[12px] text-muted-foreground">Last report {fullDate(data.reports[0].created_at)} ({data.reports[0].engine}): {data.reports[0].summary}</span>}
        </div>
        <div className="mt-4 grid gap-3">
          <AnimatePresence>{pending.map((s, i) => (
            <motion.div key={s.id} data-guide="admin:learning:suggestion" layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }} transition={{ delay: i * 0.05 }}
              className="rounded-2xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
              <div className="flex flex-wrap items-start gap-3">
                <span className="rounded bg-brand-tint px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-strong">{KB_KINDS[s.kind]?.[0] ?? s.kind}</span>
                <div className="min-w-0 flex-1"><div className="text-[14px] font-semibold">{s.title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-5 text-muted-foreground">{s.rationale}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">seen in {s.evidence_count} correction(s):
                    {s.evidence.slice(0, 6).map((id) => <button key={id} onClick={() => navigate(`/case/${id}?from=${encodeURIComponent("/admin/learning")}`)} className="rounded bg-muted px-1.5 font-mono hover:bg-accent hover:text-foreground">{id}</button>)}</div>
                </div>
                {isAdmin && <div className="flex gap-2"><Button guide="admin:learning:add" variant="primary" onClick={() => decide(s, true)}>Add</Button><Button guide="admin:learning:reject" variant="danger" onClick={() => decide(s, false)}>Reject</Button></div>}
              </div>
            </motion.div>))}</AnimatePresence>
          {!pending.length && <div className="h-56"><EmptyState icon="graduation-cap" title="No suggestions waiting" hint="Correct a result or edit a reply before sending, then press “Generate now”." /></div>}
        </div>
      </Section>
      {decided.length > 0 && <Section title="Decided" hint="Approved items live in the knowledge base tab.">
        <div className="grid gap-1 text-[12.5px]">{decided.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-lg px-2 py-1 odd:bg-muted/40"><span className={cn("w-16 rounded px-1 text-center text-[10px] font-bold uppercase", s.status === "approved" ? "bg-ok-bg text-ok" : "bg-mismatch-bg text-mismatch")}>{s.status}</span><span className="flex-1 truncate">{s.title}</span><span className="text-muted-foreground">{s.decided_by}</span></div>))}</div>
      </Section>}
      <Section guide="admin:learning:edits" title="Recent staff edits" hint="The raw input of the learning loop.">
        <div className="grid gap-1 text-[12.5px]">{(data?.corrections ?? []).slice(0, 15).map((c) => (
          <button key={c.id} onClick={() => navigate(`/case/${c.email_id}?from=${encodeURIComponent("/admin/learning")}`)} className="flex items-baseline gap-2 rounded-lg px-2 py-1 text-left odd:bg-muted/40 hover:bg-accent">
            <span className="w-24 shrink-0 rounded bg-muted px-1 text-center text-[10px] font-bold uppercase text-muted-foreground">{c.kind.replace("_", " ")}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{c.email_id}</span>
            <span className="min-w-0 flex-1 truncate">{c.field ? <b>{c.field}: </b> : null}{c.kind === "draft" ? "reply edited before sending" : <><s className="text-muted-foreground">{c.ai_value}</s> → {c.final_value}</>}</span>
            <span className="shrink-0 text-muted-foreground">{c.user}{c.consumed ? "" : " · new"}</span>
          </button>))}
          {!data?.corrections.length && <span className="text-muted-foreground">No staff edits yet.</span>}</div>
      </Section>
    </>
  );
}

function ResetDemo() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    if (!confirm("Reset the demo? Every correction, sent reply, label, rule, threshold and knowledge-base change goes back to the original seeded state.")) return;
    setBusy(true);
    try { await api("/demo/reset", { method: "POST" }); await qc.invalidateQueries(); toast("Demo data restored to its original state."); }
    catch (e) { toast((e as Error).message, { kind: "error" }); } finally { setBusy(false); }
  };
  return <Button guide="admin:reset" variant="danger" className="ml-auto" disabled={busy} onClick={reset}>{busy ? "Resetting…" : "Reset demo data"}</Button>;
}

export function Admin({ tab }: { tab: string }) {
  const { isAdmin, counts, meta } = useApp();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_rgba(0,0,0,.06)]">
      <div className="shrink-0 px-8 pt-5">
        <div className="flex items-center gap-3"><h1 className="text-[22px] font-normal">Admin centre</h1>
          {!isAdmin && <span data-guide="admin:readonly" className="rounded-full bg-review-bg px-2.5 py-0.5 text-[12px] font-medium text-review">read only — switch to an admin from the avatar menu to edit</span>}
          {meta?.demo?.reset_available && (isAdmin || meta.demo.public) && <ResetDemo />}</div>
        <div className="mt-3 flex gap-1 overflow-x-auto border-b">
          {TABS.map(([id, label]) => (
            <button key={id} data-guide={`admin:tab:${id}`} onClick={() => navigate(`/admin/${id}`)} className={cn("relative whitespace-nowrap px-4 py-2.5 text-[13.5px] transition-colors hover:text-foreground", tab === id ? "font-semibold text-brand-strong" : "text-muted-foreground")}>
              {label}{id === "learning" && !!counts?.pending_suggestions && <span className="ml-1.5 rounded-full bg-mismatch px-1.5 py-px text-[10px] font-medium on-status">{counts.pending_suggestions}</span>}
              {tab === id && <motion.span layoutId="admin-tab" className="absolute inset-x-2 bottom-0 h-[3px] rounded-t bg-brand" />}
            </button>))}
        </div>
      </div>
      <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-8 pb-10">
        {tab === "labels" && <LabelsTab />}{tab === "routing" && <RoutingTab />}{tab === "team" && <TeamTab />}
        {tab === "thresholds" && <ThresholdsTab />}{tab === "kb" && <KBTab />}{tab === "learning" && <LearningTab />}
      </motion.div>
    </div>
  );
}
