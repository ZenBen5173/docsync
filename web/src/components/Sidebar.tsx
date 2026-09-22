import { useRef, useState } from "react";
import { motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { IconName } from "lucide-react/dynamic";
import { useApp } from "@/lib/app";
import { api } from "@/lib/api";
import { navigate, useRoute } from "@/lib/router";
import { toast } from "@/lib/toast";
import { SPRING } from "@/lib/motion";
import { folderBadge } from "@/guide/facts";
import { cn } from "@/lib/utils";
import { AnimatedLucide, type IconHandle } from "@/components/ui/animated-lucide";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { MathCurveLoader } from "@/components/ui/math-curve-loader";

type Box = { top: number; left: number; width: number; height: number } | null;

/** One highlight for the whole nav, positioned by measurement (ported from the
 *  library's Sidebar 2.0): it never unmounts, so it glides between any two rows. */
function Glide({ box }: { box: Box }) {
  return (
    <motion.div aria-hidden className="pointer-events-none absolute z-0 rounded-r-full bg-foreground/[.07]"
      initial={false} transition={SPRING.default}
      animate={box ? { opacity: 1, top: box.top, left: box.left, width: box.width, height: box.height } : { opacity: 0 }} />
  );
}

function NavRow({ icon, label, count, bold, active, onClick, collapsed, dot, accent, guide }: {
  icon?: IconName; label: string; count?: number; bold?: boolean; active?: boolean; onClick: () => void;
  collapsed: boolean; dot?: string; accent?: string; guide?: string;
}) {
  const ref = useRef<IconHandle>(null);
  return (
    <button data-nav-row data-guide={guide} type="button" onClick={onClick} title={collapsed ? label : undefined}
      onMouseEnter={() => ref.current?.startAnimation()} onMouseLeave={() => ref.current?.stopAnimation()}
      className={cn("relative z-10 flex h-8 w-full items-center gap-4 rounded-r-full pl-[26px] pr-3 text-left text-[14px] transition-colors",
        active ? "bg-brand-soft font-medium text-brand-strong" : "text-foreground/85", bold && !active && "font-medium",
        collapsed && "w-14 justify-center gap-0 rounded-full pl-0 pr-0 mx-auto")}>
      {icon ? <AnimatedLucide ref={ref} name={icon} size={18} trigger="manual" duration={0.45} className={accent} />
        : <span className="grid size-[18px] place-items-center"><span className="size-2.5 rounded-full" style={{ background: dot }} /></span>}
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && count != null && count > 0 && (
        <span className={cn("text-[12px] tabular-nums", bold || active ? "font-medium" : "text-muted-foreground")}>
          <AnimatedNumber value={count} />
        </span>
      )}
    </button>
  );
}

const FOLDERS: [string, string, IconName, string?][] = [
  ["inbox", "Inbox", "inbox"], ["assigned", "Assigned to me", "user-check"], ["review", "Needs review", "triangle-alert", "text-review"],
  ["mismatch", "Mismatch", "circle-x", "text-mismatch"], ["ok", "OK", "circle-check", "text-ok"], ["failed", "Failed", "bug"],
  ["other", "Other mail", "mails"], ["spam", "Spam", "octagon-alert"], ["sent", "Sent", "send"], ["all", "All mail", "archive"],
];
const TUCKED = new Set(["failed", "sent", "all"]);        // less-used places live under "More"
const CATS: [string, string, IconName][] = [
  ["bl", "BL check", "file-check-2"], ["si", "SI request", "file-input"], ["invoice", "Invoice query", "receipt-text"], ["general", "General", "messages-square"],
];

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { counts, isAdmin, canEdit, meta } = useApp();
  const serverless = !!meta?.demo?.serverless;
  const route = useRoute();
  const qc = useQueryClient();
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>(null);
  // less-used places fold away under "More"; a folder with something in it that needs attention is never hidden
  const [more, setMoreState] = useState(() => { try { return localStorage.getItem("doccheck.nav.more") === "1"; } catch { return false; } });
  const setMore = (v: boolean) => { setMoreState(v); try { localStorage.setItem("doccheck.nav.more", v ? "1" : "0"); } catch { /* private mode */ } };
  const runIcon = useRef<IconHandle>(null);

  const track = (e: React.PointerEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-nav-row]");
    const h = host.current;
    if (!row || !h || !h.contains(row)) return;
    const r = row.getBoundingClientRect(), p = h.getBoundingClientRect();
    setBox({ top: r.top - p.top + h.scrollTop, left: r.left - p.left, width: r.width, height: r.height });
  };

  const run = useMutation({
    mutationFn: () => api("/pipeline/run", { method: "POST", json: { note: "run from UI" } }),
    onSuccess: () => { toast("Pipeline started — the inbox updates live."); qc.invalidateQueries({ queryKey: ["counts"] }); },
    onError: (e: Error) => toast(e.message, { kind: "error" }),
  });

  const pipe = counts?.pipeline;
  const running = !!pipe?.running;
  const progress = running && pipe!.total ? pipe!.done / pipe!.total : 0;
  const isList = route.name === "list";
  const folderActive = (f: string) => isList && !(route.q && route.folder === "all" && f === "all") && route.folder === f;
  const showMore = more;      // the button and the fold read ONE value; the place you are in always shows by itself (folderActive)

  return (
    <aside className={cn("no-print flex shrink-0 flex-col transition-[width] duration-200", collapsed ? "w-[72px]" : "w-[256px]")}>
      <div className={cn("px-2 pb-3 pt-1", collapsed && "px-2")}>
        <button type="button" disabled={running || !canEdit} data-guide="nav:run"
          onClick={() => serverless
            ? toast("This hosted copy shows pre-computed results for all 520 emails. The pipeline runs live in the local app — here you can still retry individual emails.", { ms: 8000 })
            : run.mutate()}
          onMouseEnter={() => runIcon.current?.startAnimation()} onMouseLeave={() => runIcon.current?.stopAnimation()}
          className={cn("group relative flex h-14 items-center gap-3 overflow-hidden rounded-2xl bg-brand-soft pl-4 pr-6 text-[14px] font-semibold text-brand-strong shadow-sm transition-all",
            "hover:shadow-[0_2px_10px_rgba(15,118,110,.28)] active:scale-[.98] disabled:opacity-90", collapsed && "w-14 justify-center px-0")}>
          {running && <span className="absolute inset-y-0 left-0 bg-brand/15 transition-[width] duration-300" style={{ width: `${progress * 100}%` }} />}
          <span className="relative grid size-6 place-items-center">
            {running ? <MathCurveLoader curve="rose" size={24} speed={2.2} strokeWidth={2.2} label="Pipeline running" />
              : <AnimatedLucide ref={runIcon} name="refresh-cw" size={20} trigger="manual" duration={0.6} />}
          </span>
          {!collapsed && (
            <span className="relative flex flex-col items-start leading-tight">
              <span>{running ? "Checking inbox…" : "Run pipeline"}</span>
              {running && <span className="text-[11px] font-medium tabular-nums opacity-80">{pipe!.done} / {pipe!.total || "…"}</span>}
            </span>
          )}
        </button>
      </div>

      <div ref={host} onPointerOver={track} onPointerLeave={() => setBox(null)}
        className="scroll-thin relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2 pr-2">
        <Glide box={collapsed ? null : box} />
        {FOLDERS.filter(([f]) => showMore || !TUCKED.has(f) || folderActive(f) || (f === "failed" && (counts?.folders.failed ?? 0) > 0)).map(([f, label, icon, accent]) => (
          <NavRow key={f} guide={`nav:folder:${f}`} icon={icon} label={label} accent={folderActive(f) ? undefined : accent} collapsed={collapsed}
            count={folderBadge(f, counts)}
            bold={(f === "inbox" || f === "assigned") && !!counts?.unread[f]} active={folderActive(f)} onClick={() => navigate(`/${f}`)} />
        ))}
        {showMore && !collapsed && <div className="px-[26px] pb-1 pt-3 text-[12px] text-muted-foreground">Kinds of email</div>}
        {CATS.filter(([f]) => showMore || folderActive(f)).map(([f, label, icon]) => (
          <NavRow key={f} guide={`nav:category:${f}`} icon={icon} label={label} collapsed={collapsed} count={counts?.folders[f]} active={folderActive(f)} onClick={() => navigate(`/${f}`)} />
        ))}
        <NavRow guide="nav:more" icon={showMore ? "chevron-up" : "chevron-down"} label={showMore ? "Less" : "More"} collapsed={collapsed} onClick={() => setMore(!more)} />
      </div>

      <div className="border-t py-2 pr-2">
        <NavRow guide="nav:analytics" icon="chart-no-axes-combined" label="Report" collapsed={collapsed} active={route.name === "analytics"} onClick={() => navigate("/analytics")} />
        <NavRow guide="nav:admin" icon="shield-check" label="Admin" collapsed={collapsed} active={route.name === "admin"}
          count={isAdmin ? counts?.pending_suggestions : undefined} onClick={() => navigate("/admin/labels")} />
      </div>

    </aside>
  );
}
