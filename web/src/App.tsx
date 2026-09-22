import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "@/lib/app";
import { useRoute } from "@/lib/router";
import { dismiss, useToasts } from "@/lib/toast";
import { TopBar } from "@/components/TopBar";
import { Sidebar } from "@/components/Sidebar";
import { MailList } from "@/components/MailList";
import { CaseView } from "@/components/CaseView";
import { Admin } from "@/components/Admin";
import { Analytics } from "@/components/Analytics";
import { Guide } from "@/guide/Guide";

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="no-print pointer-events-none fixed bottom-6 left-6 z-[90] flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} layout initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className={`pointer-events-auto flex min-w-72 max-w-md items-center gap-4 rounded-lg px-4 py-3 text-[14px] text-white shadow-xl ${t.kind === "error" ? "bg-[#8c1d18]" : "bg-[#202124]"}`}>
            <span className="flex-1">{t.message}</span>
            {t.undo && <button onClick={() => { t.undo!(); dismiss(t.id); }} className="rounded px-2 py-1 text-[13px] font-semibold text-[#7fd6cb] hover:bg-white/10">Undo</button>}
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="rounded px-1.5 text-white/70 hover:bg-white/10">✕</button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const { meta } = useApp();
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1100);
  useEffect(() => { document.title = meta?.product ?? "DocSync"; }, [meta]);
  return (
    <div className="flex h-full flex-col">
      <TopBar onMenu={() => setCollapsed((v) => !v)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar collapsed={collapsed} />
        <main className="flex min-w-0 flex-1 flex-col pb-4 pr-4">
          {route.name === "list" && <MailList route={route} />}
          {route.name === "case" && <CaseView key={route.id} id={route.id} from={route.from} />}
          {route.name === "admin" && <Admin tab={route.tab} />}
          {route.name === "analytics" && <Analytics />}
        </main>
      </div>
      <Toasts />
      <Guide />
    </div>
  );
}
