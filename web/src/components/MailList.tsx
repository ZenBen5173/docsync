import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IconName } from "lucide-react/dynamic";
import { useApp } from "@/lib/app";
import { api, CATEGORY_LABEL, type Label, type ListResponse, type Row } from "@/lib/api";
import { listUrl, navigate, type Route } from "@/lib/router";
import { gmailDate, pct, senderName } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Avatar, IconButton, LabelChip, MenuItem, Popover } from "@/components/bits";
import { AssignMenu, LabelPicker } from "@/components/pickers";
import { AnimatedLucide, type IconHandle } from "@/components/ui/animated-lucide";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { readableSubject } from "@/guide/facts";

type ListRoute = Extract<Route, { name: "list" }>;
const PAGE = 50;

const TABS: [string, string, IconName, string][] = [
  ["cases", "All checks", "file-check-2", "Every document check"], ["review", "Needs review", "triangle-alert", "Waiting for a person"],
  ["mismatch", "Mismatch", "circle-x", "The draft is different"], ["ok", "OK", "circle-check", "Everything matches"],
];
const TITLES: Record<string, string> = {
  inbox: "Inbox", assigned: "Assigned to me", review: "Needs review", mismatch: "Mismatch", ok: "OK", failed: "Failed",
  sent: "Sent", all: "All mail", spam: "Spam", other: "Other mail", bl: "BL check", si: "SI request", invoice: "Invoice query", general: "General", starred: "Starred",
};
const EMPTY: Record<string, [IconName, string, string]> = {
  review: ["party-popper", "Review queue is clear", "Nothing is waiting for a human decision."],
  failed: ["shield-check", "No failed cases", "Every email made it through all pipeline stages."],
  sent: ["send", "No sent replies yet", "Open a case, edit the auto-draft and press Send."],
  assigned: ["coffee", "Nothing assigned to you", "Routing rules in Admin decide who gets which carrier or customer."],
  mismatch: ["circle-check", "No mismatches", "Every compared BL matches its SI."],
};

function Checkbox({ checked, indeterminate, onChange, label, guide }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string; guide?: string }) {
  return (
    <button type="button" role="checkbox" data-guide={guide} aria-checked={indeterminate ? "mixed" : checked} aria-label={label}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-foreground/8">
      <span className={cn("grid size-[15px] place-items-center rounded-[3px] border-2 transition-colors",
        checked || indeterminate ? "border-brand bg-brand text-white" : "border-muted-foreground/60")}>
        {checked && <svg viewBox="0 0 12 12" className="size-3"><path d="M2.5 6.2l2.4 2.4 4.6-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        {indeterminate && !checked && <span className="h-0.5 w-2 rounded bg-white" />}
      </span>
    </button>
  );
}

const STATUS_WORD: Record<string, [word: string, cls: string, dot: string]> = {
  OK: ["OK", "text-muted-foreground", "bg-ok/60"], MISMATCH: ["Mismatch", "text-mismatch", "bg-mismatch"],
  NEEDS_REVIEW: ["Needs review", "text-review", "bg-review"], FAILED: ["Failed", "text-failed", "bg-failed"],
};

/** First thing a newcomer reads: what the app already did, what is waiting, and one way in. Dismissible, remembered. */
function Welcome({ counts, onShow }: { counts?: { review: number; mismatch: number }; onShow: () => void }) {
  const [gone, setGone] = useState(() => { try { return localStorage.getItem("doccheck.welcome") === "0"; } catch { return false; } });
  const glow = useRef<HTMLDivElement>(null);
  if (gone || !counts) return null;
  return (
    <motion.div data-guide="list:welcome" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); glow.current?.style.setProperty("--mx", `${e.clientX - r.left}px`); glow.current?.style.setProperty("--my", `${e.clientY - r.top}px`); }}
      className="group/w relative mx-3 mt-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 overflow-hidden rounded-2xl border border-brand/20 bg-brand-tint/50 px-4 py-3 text-[13.5px]">
      <div ref={glow} aria-hidden className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover/w:opacity-100"
        style={{ background: "radial-gradient(320px circle at var(--mx) var(--my), color-mix(in srgb, var(--brand) 12%, transparent), transparent 70%)" }} />
      <span className="relative min-w-[min(260px,100%)] flex-1 basis-[260px] leading-6 text-foreground/85">
        The app has already compared each shipping line's draft with what the customer asked for.{" "}
        <span className="inline-flex items-baseline gap-1 whitespace-nowrap text-review"><AnimatedNumber value={counts.review} /><span>are waiting for a decision</span></span> and{" "}
        <span className="inline-flex items-baseline gap-1 whitespace-nowrap text-mismatch"><AnimatedNumber value={counts.mismatch} /><span>drafts have differences</span></span>. Open one to see the answer and the reply that's ready to send.
      </span>
      <button type="button" data-guide="list:welcome:show" onClick={onShow}
        className="relative flex h-9 shrink-0 items-center gap-2 rounded-full bg-brand px-4 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-brand-strong hover:shadow-md active:scale-[.97]">
        Show me one <AnimatedLucide name="arrow-right" size={15} />
      </button>
      <IconButton icon="x" label="Hide this" guide="list:welcome:dismiss" onClick={() => { setGone(true); try { localStorage.setItem("doccheck.welcome", "0"); } catch { /* private mode */ } }} className="relative size-8" />
    </motion.div>
  );
}

const GROUPS: [string, string][] = [["carrier", "Shipping line"], ["customer", "Customer"], ["pod", "Arrival port"], ["", "Your own tags"]];

/** Tags as filters: one button, one menu, and chips only while something is filtered. One tag per group; they combine. */
function Filters({ route }: { route: ListRoute }) {
  const { counts } = useApp();
  const [find, setFind] = useState("");
  const all = counts?.labels ?? [];
  const active = route.tags.map((id) => all.find((l) => l.id === id)).filter((l): l is Label => !!l);
  const toggle = (l: Label) => {
    const sameGroup = new Set(all.filter((x) => (x.group ?? "") === (l.group ?? "")).map((x) => x.id));
    const rest = route.tags.filter((id) => !sameGroup.has(id));
    navigate(listUrl(route, { tags: route.tags.includes(l.id) ? rest : [...rest, l.id], page: 1 }));
  };
  return (
    <>
      <Popover trigger={({ toggle: open, open: isOpen }) => (
        <button type="button" data-guide="list:filter" onClick={open} aria-expanded={isOpen}
          className={cn("ml-2 flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition hover:bg-accent", active.length ? "border-brand/40 text-brand-strong" : "text-foreground/75")}>
          <AnimatedLucide name="list-filter" size={14} /> Filter</button>)}>
        {() => (
          <div className="w-72">
            <input autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a shipping line, customer, port…"
              className="mb-1 h-8 w-full rounded-lg border bg-card px-2.5 text-[12.5px] outline-none focus:border-brand" />
            <div className="scroll-thin max-h-80 overflow-y-auto">
              {GROUPS.map(([g, title]) => {
                const items = all.filter((l) => (l.group ?? "") === g && ((l.count ?? 0) > 0 || !g) && l.name.toLowerCase().includes(find.toLowerCase()));
                if (!items.length) return null;
                return (
                  <div key={g}>
                    <div data-guide={`nav:labelgroup:${g || "custom"}`} className="px-2 pb-0.5 pt-2 text-[11.5px] text-muted-foreground">{title}</div>
                    {items.map((l) => (
                      <MenuItem key={l.id} guide={`nav:label:${l.id}`} active={route.tags.includes(l.id)} onClick={() => toggle(l)}>
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: l.color }} />
                        <span className="min-w-0 flex-1 truncate">{l.name.replace(/^POD\s+/i, "")}</span>
                        <span className="text-[11px] tabular-nums text-muted-foreground">{l.count}</span>
                      </MenuItem>))}
                  </div>);
              })}
            </div>
          </div>)}
      </Popover>
      {active.map((l) => (
        <LabelChip key={l.id} guide="list:filter:chip" name={l.name.replace(/^POD\s+/i, "")} color={l.color} onRemove={() => toggle(l)} />))}
      {active.length > 1 && <button type="button" data-guide="list:filter:clear" onClick={() => navigate(listUrl(route, { tags: [], page: 1 }))} className="rounded-full px-2 text-[12px] text-brand hover:bg-accent">Clear</button>}
    </>
  );
}

function MailRow({ row, selected, cursor, onSelect, onOpen, onTag, index, sentView }: {
  row: Row; selected: boolean; cursor: boolean; onSelect: () => void; onOpen: () => void; onTag: (id: number) => void; index: number; sentView: boolean;
}) {
  const { users, canEdit } = useApp();
  const qc = useQueryClient();
  const [menu, setMenu] = useState<null | "label" | "assign">(null);
  const clip = useRef<IconHandle>(null);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => { if (cursor) el.current?.scrollIntoView({ block: "nearest" }); }, [cursor]);
  const assignee = users.find((u) => u.id === row.assignee_id);
  const unread = !row.is_read;
  const check = row.category === "BL_COMPARISON" || row.status === "FAILED";
  const waiting = !!row.needs_human && !row.resolved && row.status !== "NEEDS_REVIEW" && row.status !== "FAILED";
  const title = sentView ? null : readableSubject({ ...row, pod: row.labels.find((l) => l.group === "pod")?.name, from: senderName(row.sender) });
  const handled = row.status === "NEEDS_REVIEW" && (!!row.resolved || !row.needs_human);       // a person dealt with it: no longer amber
  const [word, wordCls, dot] = STATUS_WORD[waiting ? "NEEDS_REVIEW" : row.status] ?? STATUS_WORD.OK;
  const tags = [...row.labels].filter((l) => l.group !== "pod").sort((a, b) => Number(b.group === "carrier") - Number(a.group === "carrier"));

  const act = async (action: string, message: string, undo?: string) => {
    await api("/cases/bulk", { method: "POST", json: { ids: [row.id], action } });
    qc.invalidateQueries({ queryKey: ["cases"] }); qc.invalidateQueries({ queryKey: ["counts"] });
    toast(message, undo ? { undo: async () => { await api("/cases/bulk", { method: "POST", json: { ids: [row.id], action: undo } }); qc.invalidateQueries({ queryKey: ["cases"] }); qc.invalidateQueries({ queryKey: ["counts"] }); } } : {});
  };

  return (
    <motion.div data-guide={`list:row:${row.id}`}
      ref={el} layout="position"
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index, 14) * 0.018, ease: [0.16, 1, 0.3, 1] }}
      onClick={onOpen} onMouseEnter={() => clip.current?.startAnimation()} onMouseLeave={() => { clip.current?.stopAnimation(); }}
      className={cn("group relative flex min-h-[66px] cursor-pointer items-start border-b py-2.5 pr-3 text-[14px] transition-shadow",
        "hover:z-10 hover:shadow-[inset_1px_0_0_#dadce0,inset_-1px_0_0_#dadce0,0_1px_2px_0_rgba(60,64,67,.3),0_1px_3px_1px_rgba(60,64,67,.15)]",
        selected ? "bg-brand-soft/70" : unread ? "bg-[var(--row-unread)]" : "bg-[var(--row-read)]")}
    >
      {cursor && <span className="absolute inset-y-0 left-0 w-[3px] bg-brand" />}
      <div className="-mt-1.5 flex shrink-0 items-center pl-1">
        {!sentView && <Checkbox guide="list:row:select" checked={selected} onChange={onSelect} label="Select conversation" />}
        {!sentView && (
          <button data-guide="list:row:star" aria-label={row.starred ? "Starred" : "Not starred"} onClick={(e) => { e.stopPropagation(); act(row.starred ? "unstar" : "star", row.starred ? "Star removed." : "Conversation starred."); }}
            className="grid size-8 place-items-center rounded-full hover:bg-foreground/8">
            <svg viewBox="0 0 24 24" className={cn("size-[18px] transition-transform active:scale-125", row.starred ? "fill-[#f4b400] text-[#f4b400]" : "fill-none text-muted-foreground/70")} stroke="currentColor" strokeWidth="1.8"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
      {/* Unread is carried by ONE bold element (the sender) plus the white row; bolding the subject and date as
          well, as Gmail does, turns a page of ALL-CAPS shipping subjects into a wall of black. */}
      <div className={cn("w-44 shrink-0 truncate pl-2 pr-4 leading-5 max-xl:w-36 max-md:w-28 max-md:pr-2", unread ? "font-medium text-foreground" : "text-foreground/75")}>{senderName(row.sender)}</div>
      <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2 leading-5 max-md:flex-wrap max-md:gap-y-0.5">
        {row.status !== "SENT" && (handled ? (
          <span data-guide="list:row:handled" className="flex w-[104px] shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/30" />Handled</span>
        ) : check ? (
          <span data-guide={waiting ? "list:row:review" : `status:${row.status}`} className={cn("flex w-[104px] shrink-0 items-center gap-1.5 text-[12.5px]", wordCls)}>
            <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />{word}</span>
        ) : (
          <span data-guide={waiting ? "list:row:review" : "list:row:category"} className={cn("flex w-[104px] shrink-0 items-center gap-1.5 truncate text-[12.5px]", waiting ? "text-review" : "text-muted-foreground")}>
            <span className={cn("size-1.5 shrink-0 rounded-full", waiting ? "bg-review" : "bg-muted-foreground/30")} />{waiting ? "Needs review" : CATEGORY_LABEL[row.category ?? ""] ?? "Not checked"}</span>
        ))}
        <span className="min-w-0 truncate max-md:basis-full" title={row.subject}>
          <span className={cn(unread ? "text-foreground" : "text-foreground/75")}>{title ?? row.subject}</span>
          <span className="text-muted-foreground"> - {title ? row.subject : row.snippet}</span>
        </span>
      </div>
      {/* second line: the tags, starting exactly under the subject */}
      <div className="mt-1.5 flex h-5 min-w-0 items-center gap-1.5 overflow-hidden pl-[112px] max-md:pl-0">
        {tags.slice(0, 4).map((l) => (
          <LabelChip key={l.id} guide={`list:label:${l.id}`} name={l.name} color={l.color} onClick={() => onTag(l.id)} />
        ))}
        {tags.length > 4 && <span className="shrink-0 text-[11.5px] text-muted-foreground" title={tags.slice(4).map((l) => l.name).join(", ")}>+{tags.length - 4}</span>}
      </div>
      </div>
      <div className="ml-3 flex shrink-0 flex-col items-end">
      <div className="flex h-5 items-center gap-2">
        {row.category === "BL_COMPARISON" && row.confidence != null && row.confidence < 0.7 && row.status !== "SENT" && row.status !== "FAILED" && (
          <span title="The app is less sure than usual about this one" data-guide="list:row:confidence" className="text-right text-[11.5px] tabular-nums text-review">{pct(row.confidence)} sure</span>
        )}
        {row.attachments > 0 && <span data-guide="list:row:attachment" className="grid"><AnimatedLucide ref={clip} name="paperclip" size={15} trigger="manual" className="text-muted-foreground" /></span>}
        {assignee ? <Avatar user={assignee} size={22} guide={`list:row:assignee:${assignee.id}`} /> : <span className="w-[22px]" />}
        <span className={cn("w-14 text-right text-[12px]", unread ? "text-foreground/80" : "text-muted-foreground")}>{gmailDate(row.received_at)}</span>
      </div>
      {/* the actions live on the second line, so they never sit on top of the paperclip, the person or the date */}
      {!sentView && (
        <div className={cn("-mr-1.5 mt-0.5 flex h-7 items-center opacity-0 transition-opacity group-hover:opacity-100 [&_button]:size-7", menu && "opacity-100")}>
          {canEdit && (
            <Popover align="right" open={menu === "assign"} onOpenChange={(v) => setMenu(v ? "assign" : null)}
              trigger={({ toggle }) => <IconButton icon="user-plus" label="Assign" guide="list:action:assign" onClick={toggle} />}>
              {(close) => <AssignMenu ids={[row.id]} current={row.assignee_id} onDone={close} />}
            </Popover>
          )}
          {canEdit && (
            <Popover align="right" open={menu === "label"} onOpenChange={(v) => setMenu(v ? "label" : null)}
              trigger={({ toggle }) => <IconButton icon="tag" label="Label" guide="list:action:label" onClick={toggle} />}>
              {(close) => <LabelPicker ids={[row.id]} current={row.labels} onDone={close} />}
            </Popover>
          )}
          {canEdit && <IconButton icon="rotate-cw" label="Retry pipeline" guide="list:action:retry" onClick={() => act("retry", "Re-checking this email…")} />}
          <IconButton icon="archive" label="Archive" guide="list:action:archive" onClick={() => act(row.archived ? "unarchive" : "archive", row.archived ? "Moved to inbox." : "Conversation archived.", row.archived ? "archive" : "unarchive")} />
          <IconButton icon={row.is_read ? "mail" : "mail-open"} label={row.is_read ? "Mark as unread" : "Mark as read"} guide="list:action:read" onClick={() => act(row.is_read ? "unread" : "read", row.is_read ? "Marked as unread." : "Marked as read.")} />
        </div>
      )}
      </div>
    </motion.div>
  );
}

export function MailList({ route }: { route: ListRoute }) {
  const { me, counts, canEdit } = useApp();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [bulkMenu, setBulkMenu] = useState<null | "label" | "assign">(null);

  const params = new URLSearchParams({ folder: route.folder, page: String(route.page), page_size: String(PAGE) });
  if (route.tab) params.set("tab", route.tab);
  if (route.tags.length) params.set("tags", route.tags.join(","));
  if (route.q) params.set("q", route.q);
  if (me) params.set("user_id", String(me.id));
  const key = params.toString();
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["cases", key], queryFn: () => api<ListResponse>(`/cases?${key}`), placeholderData: keepPreviousData, enabled: !!me,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const here = listUrl(route);
  const sentView = route.folder === "sent";
  useEffect(() => { setSelected(new Set()); setCursor(0); }, [key]);

  const open = (r: Row) => navigate(`/case/${r.id}?from=${encodeURIComponent(here)}`);
  const ids = useMemo(() => [...selected], [selected]);
  const bulk = async (action: string, message: string, undo?: string) => {
    const target = ids;
    await api("/cases/bulk", { method: "POST", json: { ids: target, action } });
    qc.invalidateQueries({ queryKey: ["cases"] }); qc.invalidateQueries({ queryKey: ["counts"] });
    setSelected(new Set());
    toast(message, undo ? { undo: async () => { await api("/cases/bulk", { method: "POST", json: { ids: target, action: undo } }); qc.invalidateQueries({ queryKey: ["cases"] }); qc.invalidateQueries({ queryKey: ["counts"] }); } } : {});
  };

  // Gmail keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" && t.closest("button, a, [role=checkbox], [role=button]")) return;      // Enter on a focused button presses THAT button
      const row = rows[cursor];
      if (e.key === "j") setCursor((c) => Math.min(rows.length - 1, c + 1));
      else if (e.key === "k") setCursor((c) => Math.max(0, c - 1));
      else if ((e.key === "o" || e.key === "Enter") && row) open(row);
      else if (e.key === "x" && row) setSelected((s) => { const n = new Set(s); n.has(row.id) ? n.delete(row.id) : n.add(row.id); return n; });
      else if (e.key === "e" && row && !sentView) {
        const target = ids.length ? ids : [row.id];
        api("/cases/bulk", { method: "POST", json: { ids: target, action: "archive" } }).then(() => {
          qc.invalidateQueries({ queryKey: ["cases"] }); qc.invalidateQueries({ queryKey: ["counts"] }); setSelected(new Set());
          toast(`${target.length > 1 ? target.length + " conversations" : "Conversation"} archived.`, { undo: async () => { await api("/cases/bulk", { method: "POST", json: { ids: target, action: "unarchive" } }); qc.invalidateQueries({ queryKey: ["cases"] }); } });
        });
      } else if (e.key === "s" && row) api("/cases/bulk", { method: "POST", json: { ids: [row.id], action: row.starred ? "unstar" : "star" } }).then(() => qc.invalidateQueries({ queryKey: ["cases"] }));
      else if (e.key === "l" && row && canEdit) { if (!ids.length) setSelected(new Set([row.id])); setBulkMenu("label"); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const from = total ? (route.page - 1) * PAGE + 1 : 0;
  const to = Math.min(total, route.page * PAGE);
  const title = route.q ? `Search results for “${route.q}”` : TITLES[route.folder] ?? route.folder;
  const addTag = (id: number) => { if (!route.tags.includes(id)) navigate(listUrl(route, { tags: [...route.tags, id], page: 1 })); };
  const empty = EMPTY[route.folder];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_rgba(0,0,0,.06)]">
      {/* toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-1 px-2 pl-1">
        {!sentView && <Checkbox guide="list:selectall" checked={allSelected} indeterminate={selected.size > 0} label="Select all"
          onChange={() => setSelected(allSelected || selected.size ? new Set() : new Set(rows.map((r) => r.id)))} />}
        <AnimatePresence mode="wait" initial={false}>
          {selected.size ? (
            <motion.div key="bulk" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex items-center">
              <span data-guide-say={selected.size === 1 ? "One email is ticked. The buttons next to this act on it." : "These emails are ticked. The buttons next to this act on all of them at once, so look twice before you tidy or re-check."} className="px-2 text-[13px] font-medium text-brand-strong">{selected.size} selected</span>
              <IconButton icon="archive" label="Archive" guide="list:bulk:archive" onClick={() => bulk("archive", `${ids.length} archived.`, "unarchive")} />
              <IconButton icon="mail-open" label="Mark as read" guide="list:bulk:read" onClick={() => bulk("read", "Marked as read.", "unread")} />
              {canEdit && (
                <Popover open={bulkMenu === "label"} onOpenChange={(v) => setBulkMenu(v ? "label" : null)}
                  trigger={({ toggle }) => <IconButton icon="tag" label="Label" guide="list:bulk:label" onClick={toggle} />}>
                  {(close) => <LabelPicker ids={ids} current={[]} onDone={close} />}
                </Popover>
              )}
              {canEdit && (
                <Popover open={bulkMenu === "assign"} onOpenChange={(v) => setBulkMenu(v ? "assign" : null)}
                  trigger={({ toggle }) => <IconButton icon="user-plus" label="Assign" guide="list:bulk:assign" onClick={toggle} />}>
                  {(close) => <AssignMenu ids={ids} onDone={() => { close(); setSelected(new Set()); }} />}
                </Popover>
              )}
              {canEdit && <IconButton icon="rotate-cw" label="Retry pipeline" guide="list:bulk:retry" onClick={() => bulk("retry", `Re-checking ${ids.length} email(s)…`)} />}
            </motion.div>
          ) : (
            <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center">
              <IconButton icon="rotate-cw" label="Refresh" guide="list:refresh" onClick={() => { refetch(); qc.invalidateQueries({ queryKey: ["counts"] }); }} className={cn(isFetching && "[&_svg]:animate-spin")} />
              {route.folder === "failed" && total > 0 && canEdit && (
                <button data-guide="list:retryfailed" onClick={async () => { await api("/pipeline/run", { method: "POST", json: { failed: true } }); toast("Retrying all failed cases…"); }}
                  className="ml-1 rounded-full border px-3 py-1 text-[12px] font-medium hover:bg-accent">Retry all failed</button>
              )}
              <span className="ml-2 truncate text-[13px] font-medium text-foreground/70">{route.folder !== "inbox" || route.q ? title : ""}</span>
              {!sentView && <Filters route={route} />}
            </motion.div>
          )}
        </AnimatePresence>
        <div data-guide="list:paging" className="ml-auto flex items-center text-[12px] text-muted-foreground">
          <span className="px-2 tabular-nums">{total ? `${from}–${to} of ${total.toLocaleString()}` : ""}</span>
          <IconButton icon="chevron-left" label="Newer" disabled={route.page <= 1} onClick={() => navigate(listUrl(route, { page: route.page - 1 }))} />
          <IconButton icon="chevron-right" label="Older" disabled={to >= total} onClick={() => navigate(listUrl(route, { page: route.page + 1 }))} />
        </div>
      </div>

      {route.folder === "inbox" && !route.q && !route.tags.length && (
        <Welcome counts={counts ? { review: counts.folders.review ?? 0, mismatch: counts.folders.mismatch ?? 0 } : undefined}
          onShow={() => { const r = rows.find((x) => x.status === "MISMATCH") ?? rows.find((x) => x.status === "NEEDS_REVIEW"); if (r) open(r); else navigate("/mismatch"); }} />
      )}
      {/* inbox tabs */}
      {route.folder === "inbox" && !route.q && (
        <div className="scroll-thin flex shrink-0 overflow-x-auto border-b">
          {TABS.map(([id, label, icon, hint]) => {
            const active = (route.tab ?? "cases") === id;
            const n = counts?.tabs[id] ?? 0;
            return (
              <button key={id} data-guide={`list:tab:${id}`} onClick={() => navigate(listUrl(route, { tab: id, page: 1 }))}
                className={cn("group/tab relative flex h-14 min-w-[148px] max-w-64 flex-1 items-center gap-4 px-4 text-left text-[14px] transition-colors hover:bg-accent/60 max-md:gap-2.5 max-md:px-3",
                  active ? "font-medium text-brand-strong" : "text-muted-foreground")}>
                <TabIcon name={icon} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">{label}
                    {n > 0 && <span className="text-[12px] tabular-nums text-muted-foreground">{n}</span>}
                  </span>
                  <span className="block truncate text-[12px] font-normal text-muted-foreground">{hint}</span>
                </span>
                {active && <motion.span layoutId="tab-underline" className="absolute inset-x-0 bottom-0 h-[3px] rounded-t bg-brand" />}
              </button>
            );
          })}
        </div>
      )}

      {/* rows */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="flex h-[66px] items-center gap-4 border-b px-4">
              <span className="skeleton size-4" /><span className="skeleton h-3 w-32" /><span className="skeleton h-3 flex-1" /><span className="skeleton h-3 w-12" />
            </div>
          ))
        ) : rows.length === 0 ? (
          <EmptyState guide="list:empty" icon={empty?.[0] ?? (route.q ? "search-x" : "inbox")} title={empty?.[1] ?? (route.q ? "No messages matched your search" : "Nothing here")}
            hint={empty?.[2] ?? (route.q ? "Try fewer operators, e.g. status:mismatch or label:msc." : "Run the pipeline to refresh the inbox.")} />
        ) : (
          <AnimatePresence initial={false}>
            {rows.map((r, i) => (
              <MailRow key={r.sent_id ? `s${r.sent_id}` : r.id} row={r} index={i} sentView={sentView} selected={selected.has(r.id)} cursor={i === cursor}
                onTag={addTag} onSelect={() => setSelected((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })}
                onOpen={() => { setCursor(i); open(r); }} />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

function TabIcon({ name }: { name: IconName }) {
  const ref = useRef<IconHandle>(null);
  return (
    <span onMouseEnter={() => ref.current?.startAnimation()} onMouseLeave={() => ref.current?.stopAnimation()}>
      <AnimatedLucide ref={ref} name={name} size={20} trigger="manual" />
    </span>
  );
}

export function EmptyState({ icon, title, hint, guide }: { icon: IconName; title: string; hint: string; guide?: string }) {
  return (
    <motion.div data-guide={guide} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid h-full place-items-center p-10 text-center">
      <div>
        <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
          className="mx-auto grid size-20 place-items-center rounded-full bg-brand-tint text-brand">
          <AnimatedLucide name={icon} size={34} duration={0.9} />
        </motion.div>
        <div className="mt-4 text-[16px] font-medium">{title}</div>
        <div className="mt-1 max-w-sm text-[13px] text-muted-foreground">{hint}</div>
      </div>
    </motion.div>
  );
}
