// The drafted reply. It opens as a short preview with THE one filled button of the screen ("Ask for a corrected
// draft", "Send the all-clear" ...), and unfolds into the Gmail-style editor on "Read and edit".
// "Send" is simulated: the reply is stored in Sent, and the AI-vs-final diff feeds the learning loop.
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/lib/app";
import { api, type CaseDetail } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Avatar, IconButton } from "@/components/bits";
import { AnimatedLucide, type IconHandle } from "@/components/ui/animated-lucide";
import { MagneticButton } from "@/components/ui/magnetic-button";

const GAP = "(please list the details to amend";      // the placeholder the app leaves when no row is marked wrong: never sendable as is

export function ReplyBox({ c, refresh, label, hint, readOnly, done }: { c: CaseDetail; refresh: () => void; label: string; hint?: string; readOnly?: boolean; done?: boolean }) {
  const { me } = useApp();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"closed" | "preview" | "edit">(!done || readOnly ? "preview" : "closed");
  const [subject, setSubject] = useState(c.draft?.subject ?? "");
  const [body, setBody] = useState(c.draft?.body ?? "");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const sendIcon = useRef<IconHandle>(null);
  const edited = body.trim() !== (c.ai_draft?.body ?? "").trim();
  const last = useRef({ subject: c.draft?.subject ?? "", body: c.draft?.body ?? "" });      // what the server has, not what the prop said at mount
  const blocked = sending || !body.trim() || body.includes(GAP);

  useEffect(() => { const a = area.current; if (a) { a.style.height = "auto"; a.style.height = a.scrollHeight + 2 + "px"; } }, [body, mode]);
  // autosave like Gmail's "Draft saved"
  useEffect(() => {
    if (readOnly || (body === last.current.body && subject === last.current.subject)) return;
    setSaved("saving");
    const t = setTimeout(async () => {
      await api(`/cases/${c.id}/draft`, { method: "PUT", json: { to: c.draft?.to, subject, body } });
      last.current = { subject, body };
      // keep the cached email in step, so leaving and coming back shows the saved wording, not the old one
      qc.setQueryData<CaseDetail>(["case", c.id], (old) => old && { ...old, draft: { to: c.draft?.to ?? "", subject, body } });
      setSaved("saved");
    }, 700);
    return () => clearTimeout(t);
  }, [body, subject]); // eslint-disable-line

  const send = async () => {
    if (readOnly) return;
    setSending(true);
    try {
      const r = await api<{ sent_id: number }>(`/cases/${c.id}/send`, { method: "POST", json: { to: c.draft?.to, subject, body } });
      // replying IS dealing with it: an email that was waiting for a person leaves the waiting line in the same click
      const chained = c.needs_human && !c.resolved;
      if (chained) await api(`/cases/${c.id}/confirm`, { method: "POST", json: { user_id: me?.id } });
      toast("Reply sent.", { undo: async () => {
        await api(`/sent/${r.sent_id}`, { method: "DELETE" });
        if (chained) await api(`/cases/${c.id}/send-to-review`, { method: "POST", json: {} });      // undo both halves: back in the waiting line
        refresh(); toast("Sending undone.");
      } });
      setMode("closed"); refresh();
    } catch (e) { toast((e as Error).message, { kind: "error" }); } finally { setSending(false); }
  };

  if (mode === "closed") return (
    <div className="no-print mt-5 flex gap-2">
      <button data-guide="reply:open" onClick={() => setMode("edit")} className="flex h-9 items-center gap-2 rounded-full border px-4 text-[13px] text-foreground/80 transition hover:bg-accent hover:shadow-sm">
        <AnimatedLucide name="reply" size={16} /> Write another reply
      </button>
    </div>
  );

  if (mode === "preview") return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
      className="no-print group/reply mt-4 rounded-2xl border bg-card transition-shadow hover:shadow-[0_2px_10px_rgba(0,0,0,.08)]">
      <div data-guide="reply:preview" className="px-4 pt-3.5">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <AnimatedLucide name="reply" size={15} />
          <span>{readOnly ? "The reply the app drafted" : hint ?? "A reply is already written for you."}</span>
        </div>
        <p className={cn("mt-2 whitespace-pre-line border-l-2 pl-3 text-[13.5px] leading-6 text-foreground/75", !readOnly && "line-clamp-3")}>{body.replace(/\n{2,}/g, "\n").trim()}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3">
        {readOnly ? (
          <span className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><AnimatedLucide name="eye" size={15} /> You're looking around as a viewer, so sending is switched off. Pick another person from the round picture at the top right to try it.</span>
        ) : (
          <>
            <MagneticButton guide="reply:send" onClick={send} disabled={blocked}>
              {sending ? "Sending…" : label}<AnimatedLucide name="send-horizontal" size={15} />
            </MagneticButton>
            <button data-guide="reply:open" onClick={() => setMode("edit")} className="h-9 rounded-full px-3.5 text-[13px] text-foreground/75 transition hover:bg-accent hover:text-foreground">Read and edit</button>
            <span className="ml-auto text-[12px] text-muted-foreground">to {c.draft?.to}</span>
          </>
        )}
      </div>
    </motion.div>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }} className="no-print mt-4 flex gap-3">
      <Avatar user={me} size={40} className="max-md:hidden" />
      <div className="min-w-0 flex-1 rounded-2xl border bg-card shadow-[0_1px_3px_rgba(0,0,0,.14),0_4px_14px_rgba(0,0,0,.06)] transition-shadow focus-within:shadow-[0_2px_6px_rgba(0,0,0,.18),0_8px_24px_rgba(0,0,0,.1)]">
        <div className="flex items-center gap-2 border-b px-4 py-2 text-[13px]">
          <AnimatedLucide name="reply" size={15} className="text-muted-foreground" />
          <span data-guide="reply:to" className="rounded-full border px-2.5 py-0.5 text-[12.5px]">{c.draft?.to}</span>
          <span data-guide={edited ? "reply:badge:edited" : "reply:badge:ai"} className={cn("ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium", edited ? "bg-[#e8f0fe] text-[#1a73e8] dark:bg-[#1a2c4a] dark:text-[#8ab4f8]" : "bg-brand-tint text-brand-strong")}>
            {edited ? "Edited" : "Written by the app"}
          </span>
        </div>
        <input data-guide="reply:subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject"
          className="w-full border-b bg-transparent px-4 py-2 text-[13px] text-muted-foreground outline-none focus:text-foreground" />
        <textarea data-guide="reply:body" ref={area} value={body} onChange={(e) => setBody(e.target.value)} spellCheck aria-label="Reply body"
          className="block min-h-40 w-full resize-none bg-transparent px-4 py-3 text-[14px] leading-6 outline-none" />
        <div className="flex items-center gap-1 px-3 pb-3 pt-1">
          <button data-guide="reply:send" onClick={send} disabled={blocked} onMouseEnter={() => sendIcon.current?.startAnimation()} onMouseLeave={() => sendIcon.current?.stopAnimation()}
            className="group flex h-9 items-center gap-2 rounded-full bg-brand pl-5 pr-4 text-[14px] font-medium text-white shadow-sm transition-all hover:bg-brand-strong hover:shadow-md active:scale-[.97] disabled:opacity-60">
            {sending ? "Sending…" : label}
            <span className="transition-transform group-hover:translate-x-0.5"><AnimatedLucide ref={sendIcon} name="send-horizontal" size={15} trigger="manual" /></span>
          </button>
          {edited && (
            <button data-guide="reply:restore" onClick={() => { setBody(c.ai_draft?.body ?? ""); setSubject(c.ai_draft?.subject ?? ""); }} className="ml-1 h-8 rounded-full px-3 text-[12px] text-muted-foreground hover:bg-accent">Put the app's draft back</button>
          )}
          <span className="ml-2 text-[12px] text-muted-foreground">{saved === "saving" ? "Saving…" : saved === "saved" ? "Draft saved" : ""}</span>
          <span className="ml-auto" />
          <IconButton icon="trash-2" label="Discard draft" guide="reply:discard" onClick={() => { setBody(c.ai_draft?.body ?? ""); setSubject(c.ai_draft?.subject ?? ""); setMode(c.sent.length ? "closed" : "preview"); }} />
        </div>
      </div>
    </motion.div>
  );
}
