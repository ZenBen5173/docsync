import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/lib/app";
import { api, type Label } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Avatar, MenuItem } from "@/components/bits";
import { TagSelect, type TagOption } from "@/components/ui/tag-select";

/** Label picker built on the library's Notion-style TagSelect: search, tick, create what is missing. */
export function LabelPicker({ ids, current, onDone }: { ids: string[]; current: Label[]; onDone?: () => void }) {
  const { counts } = useApp();
  const qc = useQueryClient();
  const all = counts?.labels ?? [];
  const options: TagOption[] = all.map((l) => ({ value: String(l.id), label: l.name }));
  const value = current.map((l) => String(l.id));

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["cases"] }); qc.invalidateQueries({ queryKey: ["counts"] });
    ids.forEach((id) => qc.invalidateQueries({ queryKey: ["case", id] }));
  };
  const apply = async (next: string[]) => {
    const added = next.filter((v) => !value.includes(v));
    const removed = value.filter((v) => !next.includes(v));
    for (const v of added) await api("/cases/bulk", { method: "POST", json: { ids, action: "label", label_id: Number(v) } });
    for (const v of removed) await api("/cases/bulk", { method: "POST", json: { ids, action: "unlabel", label_id: Number(v) } });
    if (added.length || removed.length) { refresh(); toast(added.length ? "Label applied." : "Label removed."); }
  };
  const created = async (next: TagOption[]) => {
    const fresh = next.find((o) => !all.some((l) => String(l.id) === o.value));
    if (!fresh) return;
    try {
      const lab = await api<Label>("/labels", { method: "POST", json: { name: fresh.label } });
      await api("/cases/bulk", { method: "POST", json: { ids, action: "label", label_id: lab.id } });
      refresh(); toast(`Label “${lab.name}” created and applied.`); onDone?.();
    } catch (e) { toast((e as Error).message, { kind: "error" }); }
  };
  return (
    <div className="w-72 p-1">
      <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Label as</div>
      <TagSelect options={options} value={value} multiple reorderable={false} onChange={apply} onOptionsChange={created} />
    </div>
  );
}

export function AssignMenu({ ids, current, onDone }: { ids: string[]; current?: number | null; onDone?: () => void }) {
  const { users } = useApp();
  const qc = useQueryClient();
  const assign = async (user_id: number | null) => {
    await api("/cases/bulk", { method: "POST", json: { ids, action: "assign", user_id } });
    qc.invalidateQueries({ queryKey: ["cases"] }); qc.invalidateQueries({ queryKey: ["counts"] });
    ids.forEach((id) => qc.invalidateQueries({ queryKey: ["case", id] }));
    toast(user_id ? `Assigned to ${users.find((u) => u.id === user_id)?.name}.` : "Unassigned.");
    onDone?.();
  };
  return (
    <div className="w-60">
      <div className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Assign to</div>
      {users.filter((u) => u.active && u.role !== "viewer").map((u) => (
        <MenuItem key={u.id} active={current === u.id} onClick={() => assign(u.id)}>
          <Avatar user={u} size={22} /><span className="truncate">{u.name}</span>
        </MenuItem>
      ))}
      <div className="my-1 border-t" />
      <MenuItem onClick={() => assign(null)}>Unassign (back to auto-routing)</MenuItem>
    </div>
  );
}
