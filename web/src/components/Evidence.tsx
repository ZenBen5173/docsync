// USP 1 - evidence: the SI snippet and the BL snippet side by side with the value
// highlighted, so a reviewer never has to open the documents and hunt.
import { useState } from "react";
import { motion } from "motion/react";
import type { ContextRow, FieldSide, Loc } from "@/lib/api";
import { cn } from "@/lib/utils";

function locText(loc: Loc | null): string {
  if (!loc) return "";
  switch (loc.kind) {
    case "line": return `line ${loc.line}`;
    case "cell": return `sheet “${loc.sheet}” · cell ${loc.cell}`;
    case "table": return `table ${loc.table + 1} · row ${loc.row + 1}`;
    case "para": return `paragraph ${loc.para + 1}`;
    case "bbox": return `page ${loc.page + 1}`;
  }
}

function Marked({ text, value, tone }: { text: string; value: string | null; tone: string }) {
  if (!value) return <>{text}</>;
  const i = text.toLowerCase().indexOf(value.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (<>{text.slice(0, i)}<mark className={cn("rounded px-0.5 font-semibold text-foreground", tone)}>{text.slice(i, i + value.length)}</mark>{text.slice(i + value.length)}</>);
}

function rowKey(r: ContextRow): string {
  const l = r.loc;
  return l.kind === "line" ? String(l.line) : l.kind === "cell" ? l.cell : l.kind === "table" ? `r${l.row + 1}` : l.kind === "para" ? `¶${l.para + 1}` : "";
}

function Snippet({ side, tone }: { side: FieldSide; tone: string }) {
  const rows = side.context ?? [];
  const structured = rows.some((r) => r.label != null);
  if (!rows.length) return <div className="p-3 text-[12px] text-muted-foreground">No source location stored for this value.</div>;
  return (
    <div className={cn("overflow-hidden text-[12px] leading-5", !structured && "font-mono")}>
      {rows.map((r) => (
        <div key={r.i} className={cn("flex gap-0 border-b border-border/60 last:border-0", r.hit && "bg-[#fff8db] dark:bg-[#3a3210]")}>
          <span className="w-11 shrink-0 select-none border-r bg-muted/60 px-1.5 text-right font-mono text-[10.5px] text-muted-foreground">{rowKey(r)}</span>
          {structured && r.label != null ? (
            <>
              <span className="w-[38%] shrink-0 truncate border-r px-2 text-muted-foreground" title={r.label}>{r.label}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2">{r.hit ? <Marked text={r.value ?? ""} value={side.raw} tone={tone} /> : r.value}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2">{r.hit ? <Marked text={r.text} value={side.raw} tone={tone} /> : r.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Pane({ title, side, caseId, which, tone, accent }: { title: string; side: FieldSide | null; caseId: string; which: "si" | "bl"; tone: string; accent: string }) {
  const [broken, setBroken] = useState(false);
  const [zoom, setZoom] = useState(false);
  return (
    <div data-guide={`verify:evidence:${which}`} className="min-w-0 overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5">
        <span className={cn("rounded px-1.5 py-px text-[11px] font-medium on-status", accent)}>{title}</span>
        <span className="truncate text-[12px] font-medium">{side?.doc ?? "—"}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{locText(side?.loc ?? null)}</span>
      </div>
      {!side ? (
        <div className="p-3 text-[12px] text-muted-foreground">Field not found in this document.</div>
      ) : side.loc?.kind === "bbox" && !broken ? (
        <motion.img
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} onError={() => setBroken(true)} onClick={() => setZoom((z) => !z)}
          src={`/api/cases/${caseId}/evidence/${which}/${side.field}.png`} alt={`${title} evidence for ${side.field}`}
          className={cn("block w-full cursor-zoom-in bg-white transition-transform duration-300", zoom && "origin-left scale-[1.6] cursor-zoom-out")} />
      ) : (
        <Snippet side={side} tone={tone} />
      )}
      {side && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>label: <b className="font-medium text-foreground/80">{side.label ?? "—"}</b></span>
          <span>read by: <b className="font-medium text-foreground/80">{side.method}</b></span>
          <span>confidence: <b className="font-medium text-foreground/80">{Math.round(side.confidence * 100)}%</b></span>
          {side.note && <span className="text-review">{side.note}</span>}
        </div>
      )}
    </div>
  );
}

export function Evidence({ caseId, si, bl, mismatch }: { caseId: string; si: FieldSide | null; bl: FieldSide | null; mismatch: boolean }) {
  const tone = mismatch ? "bg-[#fbc7c2] dark:bg-[#7a2a25]" : "bg-[#fde68a] dark:bg-[#6b5a12]";
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Pane title="Customer asked for" side={si} caseId={caseId} which="si" tone="bg-[#bbf0c8] dark:bg-[#1f5a30]" accent="bg-ok" />
      <Pane title="The draft says" side={bl} caseId={caseId} which="bl" tone={tone} accent={mismatch ? "bg-mismatch" : "bg-[#1a73e8]"} />
    </div>
  );
}
