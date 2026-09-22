import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/app";
import { navigate, useRoute } from "@/lib/router";
import { Avatar, Button, IconButton, MenuItem, Modal, Popover } from "@/components/bits";
import { AnimatedLucide, type IconHandle } from "@/components/ui/animated-lucide";
import { cn } from "@/lib/utils";

export function Logo({ product }: { product: string }) {
  return (
    <button onClick={() => navigate("/inbox")} data-guide="top:logo" className="group flex items-center gap-2.5 pr-4">
      <span className="grid size-9 place-items-center rounded-xl bg-brand text-white shadow-sm transition-transform group-hover:rotate-[-6deg] group-hover:scale-105">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </span>
      <span className="text-[21px] font-medium tracking-tight text-foreground/80">{product}</span>
    </button>
  );
}

const OPERATORS = [
  ["from:", "sender contains", "from:vitalsolutions"], ["label:", "has label", "label:msc"],
  ["status:", "ok · mismatch · review · failed", "status:mismatch"], ["category:", "bl · si · invoice · general · spam", "category:bl"],
  ["carrier:", "shipping line", "carrier:oocl"], ["field:", "mismatched field", "field:gross_weight_kg"],
  ["assignee:", "person", "assignee:hari"], ["has:attachment", "with files", "has:attachment"], ["is:unread", "not opened yet", "is:unread"],
];

function SearchBar() {
  const route = useRoute();
  const current = route.name === "list" ? route.q ?? "" : "";
  const [q, setQ] = useState(current);
  const [focus, setFocus] = useState(false);
  const [filters, setFilters] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const icon = useRef<IconHandle>(null);
  useEffect(() => setQ(current), [current]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); input.current?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  const go = (text: string) => navigate(text.trim() ? `/search?q=${encodeURIComponent(text.trim())}` : "/inbox");
  return (
    <div className="relative w-full max-w-[720px]">
      <form data-guide="top:search"
        onSubmit={(e) => { e.preventDefault(); go(q); input.current?.blur(); }}
        onMouseEnter={() => icon.current?.startAnimation()} onMouseLeave={() => icon.current?.stopAnimation()}
        className={cn("flex h-12 items-center gap-1 rounded-full pl-2 pr-2 transition-all duration-200",
          focus ? "bg-card shadow-[0_1px_3px_rgba(0,0,0,.2),0_4px_12px_rgba(0,0,0,.08)]" : "bg-[#e7eef0] hover:bg-[#dfe8ea] dark:bg-muted")}
      >
        <button type="submit" aria-label="Search" className="grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-foreground/8">
          <AnimatedLucide ref={icon} name="search" size={19} trigger="manual" duration={0.5} />
        </button>
        <input
          ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail  —  try  label:msc status:mismatch"
          onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
          onKeyDown={(e) => { if (e.key === "Escape") { (e.target as HTMLInputElement).blur(); } }}
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/80"
        />
        {q && <IconButton icon="x" label="Clear search" onClick={() => { setQ(""); go(""); }} />}
        <IconButton icon="sliders-horizontal" label="Show search options" guide="top:search:options" active={filters} onClick={() => setFilters((v) => !v)} />
      </form>
      {(filters || (focus && !q)) && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-2xl border bg-popover p-2 shadow-[0_8px_28px_rgba(0,0,0,.18)]"
          onMouseDown={(e) => e.preventDefault()}>
          <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Search operators</div>
          <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
            {OPERATORS.map(([op, hint, example]) => (
              <button key={op} type="button" data-guide={`top:search:op:${op.split(":")[0]}`}
                onClick={() => { const next = (q ? q.trim() + " " : "") + (op.endsWith(":") ? op : op + " "); setQ(next); input.current?.focus(); setFilters(false); }}
                className="flex items-baseline gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent">
                <code className="rounded bg-brand-tint px-1.5 py-0.5 font-mono text-[12px] text-brand-strong">{op}</code>
                <span className="truncate text-[12px] text-muted-foreground">{hint}</span>
                <span className="ml-auto hidden font-mono text-[11px] text-muted-foreground/60 md:block">{example}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const SHORTCUTS = [["j / k", "Next / previous conversation"], ["o or Enter", "Open conversation"], ["u", "Back to the list"],
  ["x", "Select conversation"], ["e", "Archive"], ["l", "Label"], ["s", "Star"], ["/", "Search"], ["?", "This help"]];

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const { meta, users, me, setMe, dark, setDark, counts } = useApp();
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "?" && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) setHelp(true);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  return (
    <header className="no-print flex h-16 shrink-0 items-center gap-2 px-3">
      <div className="flex w-[236px] shrink-0 items-center gap-1 max-lg:w-auto">
        <IconButton icon="menu" label="Main menu" guide="top:menu" onClick={onMenu} size={20} className="size-11" />
        <Logo product={meta?.product ?? "DocSync"} />
      </div>
      <SearchBar />
      <div className="ml-auto flex items-center gap-0.5 pl-2">
        <IconButton icon="circle-help" label="Keyboard shortcuts (?)" guide="top:help" onClick={() => setHelp(true)} size={20} className="size-10" />
        <IconButton icon={dark ? "sun" : "moon"} label={dark ? "Light mode" : "Dark mode"} guide="top:theme" onClick={() => setDark(!dark)} size={20} className="size-10" />
        <IconButton icon="settings" label="Admin centre" guide="top:admin" onClick={() => navigate("/admin/labels")} size={20} className="size-10"
          badge={counts?.pending_suggestions ? <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-mismatch ring-2 ring-background" /> : undefined} />
        <Popover align="right" trigger={({ toggle }) => (
          <button onClick={toggle} aria-label="Switch user" data-guide="top:user" className="ml-1 rounded-full p-1 transition hover:bg-foreground/8">
            <Avatar user={me} size={34} />
          </button>
        )}>
          {(close) => (
            <div className="w-72">
              <div className="px-2.5 pb-2 pt-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Signed in as (demo role switcher)</div>
              </div>
              {users.filter((u) => u.active).map((u) => (
                <MenuItem key={u.id} guide={`top:user:option:${u.id}`} active={u.id === me?.id} onClick={() => { setMe(u.id); close(); }}>
                  <Avatar user={u} size={28} />
                  <span className="min-w-0 flex-1"><span className="block truncate">{u.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{u.email}</span></span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{u.role}</span>
                </MenuItem>
              ))}
            </div>
          )}
        </Popover>
      </div>
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <div className="grid gap-1.5">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between rounded-lg px-2 py-1.5 odd:bg-muted/60">
              <span className="text-[13px]">{d}</span>
              <kbd className="rounded border bg-card px-2 py-0.5 font-mono text-[12px] shadow-sm">{k}</kbd>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end"><Button variant="primary" onClick={() => setHelp(false)}>Got it</Button></div>
      </Modal>
    </header>
  );
}
