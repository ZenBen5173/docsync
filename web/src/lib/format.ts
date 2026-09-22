export function gmailDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date(2026, 8, 19); // demo inbox timeline ends 18 Sep 2026
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString();
}
export function fullDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }) +
    ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function senderName(sender: string): string {
  if (sender.startsWith("To: ")) return sender;
  const local = sender.split("@")[0] || sender;
  return local.split(/[._-]/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
}
export const pct = (v: number | null | undefined) => (v == null ? "-" : `${Math.round(v * 100)}%`);
