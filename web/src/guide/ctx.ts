// Builds the guide's view of the app's LIVE state. The guide never keeps its own copy of anything:
// it reads the same query cache and app context the screens read, and re-renders when they change.
import { useEffect, useReducer } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/lib/app";
import { useRoute } from "@/lib/router";
import type { CaseDetail, ListResponse, Row } from "@/lib/api";
import type { GuideCtx } from "@/guide/explain";

export function useGuideCtx(): GuideCtx {
  const { meta, users, me, counts, dark } = useApp();
  const route = useRoute();
  const qc = useQueryClient();

  // Re-render when any cached data changes (throttled to one per frame), so a line that is on screen
  // follows the app: correct a field and the sentence about it changes with it.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let raf = 0;
    const unsub = qc.getQueryCache().subscribe(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; bump(); }); });
    return () => { unsub(); cancelAnimationFrame(raf); };
  }, [qc]);

  const rows: Record<string, Row> = {};
  for (const [, data] of qc.getQueriesData<ListResponse>({ queryKey: ["cases"], type: "active" })) for (const r of data?.rows ?? []) rows[r.id] = r;

  return {
    product: meta?.product ?? "DocSync",
    me: me ? { id: me.id, name: me.name, role: me.role } : undefined,
    users, labels: counts?.labels ?? [], counts,
    hosted: !!meta?.demo?.serverless, publicDemo: !!meta?.demo?.public, llm: !!meta?.llm.available,
    running: !!counts?.pipeline?.running, dark, rows,
    openCase: route.name === "case" ? qc.getQueryData<CaseDetail>(["case", route.id]) : undefined,
  };
}
