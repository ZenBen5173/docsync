import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setApiUser, type Counts, type Meta, type User } from "@/lib/api";
import { canEditRole, isAdminRole } from "@/guide/facts";

type Ctx = {
  meta: Meta | undefined; users: User[]; me: User | undefined; setMe: (id: number) => void;
  counts: Counts | undefined; canEdit: boolean; isAdmin: boolean;
  dark: boolean; setDark: (v: boolean) => void;
};
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ["meta"], queryFn: () => api<Meta>("/meta") }).data;
  const usersQ = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/users") });
  const users = usersQ.data ?? meta?.users ?? [];
  const [meId, setMeId] = useState<number>(() => Number(localStorage.getItem("doccheck.user")) || 1);
  const me = users.find((u) => u.id === meId) ?? users[0];
  const [dark, setDarkState] = useState(() => localStorage.getItem("doccheck.dark") === "1");

  useEffect(() => { if (me) setApiUser(me.name); }, [me]);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);

  const counts = useQuery({
    queryKey: ["counts", me?.id], enabled: !!me,
    queryFn: () => api<Counts>(`/counts?user_id=${me!.id}`), refetchInterval: 30000,
  }).data;

  // Live updates: the backend publishes case/run/label events over SSE.
  const serverless = meta?.demo?.serverless;
  useEffect(() => {
    // Wait until we know where we are running. On the serverless deployment there is no event stream
    // (it would pin one function invocation per open tab); the UI refetches after its own actions instead.
    if (serverless === undefined || serverless) return;
    let es: EventSource;
    let timer: number | undefined;
    let retry: number | undefined;
    let stopped = false;
    let bursts = 0;
    const flush = () => {
      timer = undefined;
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["counts"] });
    };
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => flush();        // (re)connected: whatever happened while we were away, catch up once
      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.event === "case" && data.email_id) qc.invalidateQueries({ queryKey: ["case", data.email_id] });
        if (data.event === "run") qc.invalidateQueries({ queryKey: ["pipeline"] });
        if (data.event === "learning") qc.invalidateQueries({ queryKey: ["learning"] });
        if (data.event === "labels" || data.event === "retag") qc.invalidateQueries({ queryKey: ["case"] });
        if (data.event === "reset") { qc.invalidateQueries(); return; }   // demo data restored: refetch everything
        // Batch bursts. A single edit refreshes quickly; during a pipeline run (hundreds of events) every
        // open browser would otherwise refetch the list 3x a second and starve the one server process.
        bursts = data.event === "case" && data.run_id ? bursts + 1 : 0;
        if (!timer) timer = window.setTimeout(flush, bursts > 3 ? 2000 : 350);
      };
      // Hosts cut long-lived connections (Cloud Run after at most 60 min). The browser retries on its own
      // unless the stream ended in the CLOSED state - then we have to reconnect ourselves.
      es.onerror = () => { if (es.readyState === EventSource.CLOSED && !stopped) retry = window.setTimeout(connect, 5000); };
    };
    connect();
    return () => { stopped = true; es.close(); if (timer) clearTimeout(timer); if (retry) clearTimeout(retry); };
  }, [qc, serverless]);

  const value = useMemo<Ctx>(() => ({
    meta, users, me, counts,
    setMe: (id) => { localStorage.setItem("doccheck.user", String(id)); setMeId(id); },
    canEdit: canEditRole(me?.role), isAdmin: isAdminRole(me?.role),
    dark, setDark: (v) => { localStorage.setItem("doccheck.dark", v ? "1" : "0"); setDarkState(v); },
  }), [meta, users, me, counts, dark]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
