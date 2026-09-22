// Ported from the personal component library ("Magnetic Button", src/registry/controls/magnetic-button.tsx):
// the button leans toward the cursor and its label travels a little further, then both spring back.
// Changes for this app: it is a real control (onClick, disabled, guide key, className) instead of a demo.
import { useRef, type ReactNode } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { cn } from "@/lib/utils";

const FOLLOW = { stiffness: 220, damping: 18, mass: 0.4 };

export function MagneticButton({ children, onClick, disabled, className, guide, strength = 0.2, type = "button" }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string; guide?: string;
  /** 0 = inert, 1 = the button sticks to the cursor. */
  strength?: number; type?: "button" | "submit";
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const x = useMotionValue(0), y = useMotionValue(0);
  const sx = useSpring(x, FOLLOW), sy = useSpring(y, FOLLOW);
  const labelX = useTransform(sx, (v) => v * 0.4), labelY = useTransform(sy, (v) => v * 0.4);
  const move = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || disabled) return;
    x.set((e.clientX - (r.left + r.width / 2)) * strength);
    y.set((e.clientY - (r.top + r.height / 2)) * strength);
  };
  const reset = () => { x.set(0); y.set(0); };
  return (
    <motion.button ref={ref} type={type} onClick={onClick} disabled={disabled} data-guide={guide} onMouseMove={move} onMouseLeave={reset}
      style={{ x: sx, y: sy }} whileTap={{ scale: 0.96 }}
      className={cn("relative inline-flex h-10 items-center justify-center rounded-full bg-brand px-5 text-[14px] font-medium text-white shadow-sm transition-[background-color,box-shadow] hover:bg-brand-strong hover:shadow-md disabled:opacity-50", className)}>
      <motion.span style={{ x: labelX, y: labelY }} className="pointer-events-none flex items-center gap-2">{children}</motion.span>
    </motion.button>
  );
}
