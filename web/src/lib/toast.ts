// Gmail-style bottom-left toasts with an optional Undo.
import { useSyncExternalStore } from "react";

export type Toast = { id: number; message: string; undo?: () => void; kind?: "info" | "error" };
let toasts: Toast[] = [];
let seq = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

export function toast(message: string, opts: { undo?: () => void; kind?: "info" | "error"; ms?: number } = {}) {
  const t: Toast = { id: seq++, message, undo: opts.undo, kind: opts.kind };
  toasts = [...toasts.slice(-2), t];
  emit();
  setTimeout(() => dismiss(t.id), opts.ms ?? (opts.undo ? 7000 : 4000));
}
export function dismiss(id: number) { toasts = toasts.filter((t) => t.id !== id); emit(); }
export function useToasts() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => toasts);
}
