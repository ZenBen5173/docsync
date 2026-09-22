// Small shared pieces. Icons come from the personal component library's
// AnimatedLucide (strokes draw on); buttons and rows drive the animation
// through the ref so the hover target is the control, not the 16px glyph.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { IconName } from "lucide-react/dynamic";
import { AnimatedLucide, type IconHandle } from "@/components/ui/animated-lucide";
import { cn } from "@/lib/utils";
import { SPRING } from "@/lib/motion";
import { initials } from "@/lib/format";
import { STATUS_LABEL, type Status, type User } from "@/lib/api";

export function IconButton({ icon, label, onClick, className, size = 18, active, disabled, badge, guide }: {
  icon: IconName; label: string; onClick?: (e: React.MouseEvent) => void; className?: string; size?: number;
  active?: boolean; disabled?: boolean; badge?: ReactNode; guide?: string;
}) {
  const ref = useRef<IconHandle>(null);
  const [tip, setTip] = useState(false);
  return (
    <button
      type="button" aria-label={label} disabled={disabled} data-guide={guide}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      onMouseEnter={() => { ref.current?.startAnimation(); setTip(true); }}
      onMouseLeave={() => { ref.current?.stopAnimation(); setTip(false); }}
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors",
        "hover:bg-foreground/8 hover:text-foreground active:scale-95 disabled:opacity-40 disabled:hover:bg-transparent",
        active && "bg-brand-soft text-brand-strong", className)}
    >
      <AnimatedLucide ref={ref} name={icon} size={size} trigger="manual" duration={0.45} />
      {badge}
      <AnimatePresence>
        {tip && !disabled && (
          <motion.span
            initial={{ opacity: 0, y: -2, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }} transition={{ duration: 0.12, delay: 0.35 }}
            className="pointer-events-none absolute top-full z-50 mt-1 whitespace-nowrap rounded bg-[#3c4043] px-2 py-1 text-[11px] font-medium text-white shadow"
          >{label}</motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

export function Avatar({ user, size = 24, className, ring, guide }: { user?: Pick<User, "name" | "color"> | null; size?: number; className?: string; ring?: boolean; guide?: string }) {
  if (!user) return null;
  return (
    <span
      title={user.name} data-guide={guide}
      className={cn("grid shrink-0 place-items-center rounded-full font-semibold text-white select-none", ring && "ring-2 ring-card", className)}
      style={{ width: size, height: size, background: user.color, fontSize: size * 0.4 }}
    >{initials(user.name)}</span>
  );
}

const STATUS_CLASS: Record<string, string> = {
  OK: "bg-ok-bg text-ok", MISMATCH: "bg-mismatch-bg text-mismatch", NEEDS_REVIEW: "bg-review-bg text-review",
  FAILED: "bg-failed-bg text-failed", PENDING: "bg-muted text-muted-foreground", SENT: "bg-brand-soft text-brand-strong",
};
export function StatusChip({ status, className, guide }: { status: Status | string; className?: string; guide?: string }) {
  return (
    <span data-guide={guide ?? `status:${status}`} className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-semibold tracking-wide", STATUS_CLASS[status] ?? STATUS_CLASS.PENDING, className)}>
      <span className="size-1.5 rounded-full bg-current" />{STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function LabelChip({ name, color, onRemove, onClick, guide }: { name: string; color: string; onRemove?: () => void; onClick?: () => void; guide?: string }) {
  return (
    <span data-guide={guide}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      className={cn("group/chip inline-flex h-5 max-w-40 items-center gap-1 rounded px-1.5 text-[11px] font-medium", onClick && "cursor-pointer hover:brightness-95")}
      style={{ background: `${color}1f`, color }}
    >
      <span className="truncate">{name}</span>
      {onRemove && (
        <button aria-label={`Remove ${name}`} onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="-mr-0.5 hidden rounded-sm px-0.5 leading-none hover:bg-black/10 group-hover/chip:block">×</button>
      )}
    </span>
  );
}

/** Click-away popover anchored to its trigger. */
export function Popover({ trigger, children, align = "left", className, open: controlled, onOpenChange }: {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode; children: (close: () => void) => ReactNode;
  align?: "left" | "right"; className?: string; open?: boolean; onOpenChange?: (v: boolean) => void;
}) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const setOpen = (v: boolean) => { setInner(v); onOpenChange?.(v); };
  const host = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  // open upward when the trigger sits low on the screen, so a menu never opens below the fold
  useLayoutEffect(() => {
    if (!open || !host.current) return;
    const r = host.current.getBoundingClientRect(), below = window.innerHeight - r.bottom;
    setUp(below < 360 && r.top > below);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!host.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  });
  return (
    <div ref={host} className="relative" data-popover-open={open || undefined} onClick={(e) => e.stopPropagation()}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: up ? 4 : -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: up ? 4 : -4, scale: 0.98 }} transition={SPRING.snappy}
            className={cn("absolute z-50 min-w-52 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-[0_8px_28px_rgba(0,0,0,.18)]",
              up ? "bottom-full mb-1" : "top-full mt-1", align === "right" ? "right-0" : "left-0",
              up ? (align === "right" ? "origin-bottom-right" : "origin-bottom-left") : (align === "right" ? "origin-top-right" : "origin-top-left"), className)}
          >{children(() => setOpen(false))}</motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({ children, onClick, active, danger, guide }: { children: ReactNode; onClick?: () => void; active?: boolean; danger?: boolean; guide?: string }) {
  return (
    <button type="button" onClick={onClick} data-guide={guide}
      className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent",
        active && "bg-brand-tint font-medium text-brand-strong", danger && "text-destructive")}>
      {children}
    </button>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div data-modal-open className="fixed inset-0 z-[80] grid place-items-center bg-black/40 p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }}
            transition={SPRING.default} onMouseDown={(e) => e.stopPropagation()}
            className={cn("flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl bg-card shadow-2xl", wide ? "max-w-4xl" : "max-w-lg")}
          >
            <div className="flex items-center justify-between border-b px-5 py-3">
              <div className="text-[15px] font-medium">{title}</div>
              <IconButton icon="x" label="Close" onClick={onClose} />
            </div>
            <div className="scroll-thin overflow-auto p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Button({ children, onClick, variant = "outline", disabled, className, type = "button", guide, guideSay, guideTheme }: {
  children: ReactNode; onClick?: () => void; variant?: "primary" | "outline" | "ghost" | "danger"; disabled?: boolean; className?: string; type?: "button" | "submit";
  guide?: string; guideSay?: string; guideTheme?: string;
}) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} data-guide={guide} data-guide-say={guideSay} data-guide-theme={guideTheme}
      className={cn("inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-4 text-[13px] font-medium transition-all active:scale-[.97] disabled:opacity-50",
        variant === "primary" && "bg-brand text-white shadow-sm hover:bg-brand-strong hover:shadow",
        variant === "outline" && "border bg-card hover:bg-accent",
        variant === "ghost" && "hover:bg-accent",
        variant === "danger" && "border border-mismatch/30 text-mismatch hover:bg-mismatch-bg", className)}>
      {children}
    </button>
  );
}
