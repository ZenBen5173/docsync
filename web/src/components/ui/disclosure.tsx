// A fold. The height mechanic is the one in the personal component library's "FAQ Accordion"
// (grid-template-rows 0fr -> 1fr around an overflow-hidden child); only the mechanic was taken, because the
// FAQ's heavy rail-and-chevron skin does not fit a dense app screen. Folds here are independent (opening one
// never closes another) and their content stays mounted, so one print rule can open them all.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Disclosure({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div data-fold className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(.16,1,.3,1)]", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0", className)}
      aria-hidden={!open} {...(!open ? { inert: true } : {})}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** The chevron every fold trigger shares. */
export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-3.5 shrink-0 transition-transform duration-300", open && "rotate-90", className)} fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
