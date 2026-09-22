// Minimal history-API router: enough for a Gmail-like app, no dependency.
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "list"; folder: string; tags: number[]; q?: string; tab?: string; page: number }
  | { name: "case"; id: string; from: string }
  | { name: "admin"; tab: string }
  | { name: "analytics" };

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener("popstate", notify);

export function navigate(to: string, replace = false) {
  if (to === window.location.pathname + window.location.search) return;
  window.history[replace ? "replaceState" : "pushState"]({}, "", to);
  notify();
}

function snapshot() { return window.location.pathname + window.location.search; }

export function parse(url: string): Route {
  const u = new URL(url, window.location.origin);
  const seg = u.pathname.split("/").filter(Boolean);
  const sp = u.searchParams;
  if (seg[0] === "case" && seg[1]) return { name: "case", id: seg[1], from: sp.get("from") || "/inbox" };
  if (seg[0] === "admin") return { name: "admin", tab: seg[1] || "labels" };
  if (seg[0] === "analytics") return { name: "analytics" };
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const tags = (sp.get("tags") || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (seg[0] === "label" && seg[1]) return { name: "list", folder: "all", tags: [Number(seg[1])], q: sp.get("q") || "", page };   // old tag links still work
  if (seg[0] === "search") return { name: "list", folder: "all", tags, q: sp.get("q") || "", page };
  const folder = seg[0] || "inbox";
  return { name: "list", folder, tags, q: sp.get("q") || "", tab: folder === "inbox" ? sp.get("tab") || "cases" : undefined, page };
}

export function useRoute(): Route {
  const url = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, snapshot);
  return parse(url);
}

export function listUrl(r: Extract<Route, { name: "list" }>, patch: Partial<Extract<Route, { name: "list" }>> = {}) {
  const n = { ...r, ...patch };
  const sp = new URLSearchParams();
  if (n.q) sp.set("q", n.q);
  if (n.tab && n.folder === "inbox" && n.tab !== "cases") sp.set("tab", n.tab);
  if (n.tags.length) sp.set("tags", n.tags.join(","));
  if (n.page > 1) sp.set("page", String(n.page));
  const base = n.q && n.folder === "all" ? "/search" : `/${n.folder}`;
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}
