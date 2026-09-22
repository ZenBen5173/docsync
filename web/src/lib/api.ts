// Thin typed client for the FastAPI backend.

export type Label = { id: number; name: string; color: string; kind?: string; group?: string | null; count?: number; source?: string };
export type User = { id: number; name: string; email: string; role: "admin" | "reviewer" | "viewer"; color: string; active: boolean };
export type Status = "OK" | "MISMATCH" | "NEEDS_REVIEW" | "FAILED" | "PENDING" | "SENT";

export type Row = {
  id: string; sent_id?: number; sender: string; subject: string; snippet: string; received_at: string;
  attachments: number; is_read: boolean; starred: boolean; archived?: boolean; category: string | null;
  status: Status; review_reason?: string | null; confidence: number | null; needs_human?: boolean;
  resolved?: boolean; carrier?: string | null; customer?: string | null; assignee_id: number | null;
  defect_fields: string[]; labels: Label[]; error?: string | null; user?: string;
  preview?: string | null;      // Avery's AI-written "who wants what", made once when the email was processed
};
export type ListResponse = { total: number; page: number; page_size: number; rows: Row[]; sent?: boolean };

export type Loc =
  | { kind: "line"; line: number }
  | { kind: "bbox"; page: number; bbox: number[] }
  | { kind: "cell"; sheet: string; cell: string; row: number }
  | { kind: "para"; para: number }
  | { kind: "table"; table: number; row: number; col?: number };
export type ContextRow = { i: number; text: string; label: string | null; value: string | null; loc: Loc; hit: boolean };
export type FieldSide = {
  field: string; raw: string | null; full: string | null; label: string | null; loc: Loc | null; confidence: number;
  method: string; blank: boolean; note: string | null; doc: string | null; format: string | null; context?: ContextRow[];
};
export type FieldResult = {
  field: string; si: FieldSide | null; bl: FieldSide | null;
  result: "match" | "mismatch" | "unsure" | "missing" | "not_compared"; reason: string; confidence: number;
  si_norm: string | null; bl_norm: string | null;
};
export type DocMeta = {
  path: string; name: string; format: string; readable: boolean; error: string | null; method: string;
  ocr_confidence: number | null; type: string | null; subtype: string | null; type_confidence: number | null;
  type_evidence: string | null; role: string | null;
};
export type CaseDetail = {
  id: string; sender: string; subject: string; received_at: string;
  body: { message: string; signature: string; quoted: string; banner: string; raw: string };
  attachments: { path: string; name: string }[]; is_read: boolean; starred: boolean; archived: boolean;
  category: string; category_confidence: number;
  classification: { scores: Record<string, number>; evidence: string[]; decided_by: string } | null;
  status: Status; review_reason: string | null; review_detail: string | null; defect_fields: string[];
  proposed_defect_fields: string[]; ai_status: string | null; confidence: number; needs_human: boolean;
  resolved: boolean; carrier: string | null; customer: string | null; pod: string | null;
  refs: Record<string, string>; docs: DocMeta[]; fields: FieldResult[];
  stages: Record<string, { status: string; ms?: number; error?: string }>; error: string | null;
  assignee_id: number | null; labels: Label[]; draft: Draft | null; ai_draft: Draft | null;
  overrides: Record<string, unknown>;
  preview?: string | null;
  sent: { id: number; to: string; subject: string; body: string; user: string; sent_at: string }[];
  activity: { user: string; action: string; detail: string; at: string }[];
};
export type Draft = { to: string; subject: string; body: string };
export type Counts = {
  folders: Record<string, number>; unread: Record<string, number>; tabs: Record<string, number>; labels: Label[];
  pending_suggestions: number; pipeline: { running: boolean; done: number; total: number; error: string | null };
};
export type Meta = {
  product: string; fields: string[]; field_labels: Record<string, string>; categories: string[];
  review_reasons: string[]; users: User[]; llm: { available: boolean; provider: string; model: string };
  demo: { public: boolean; reset_available: boolean; serverless: boolean };
};

let currentUserName = "system";
export function setApiUser(name: string) { currentUserName = name; }

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { "x-user": currentUserName };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch { /* not json */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  const ct = res.headers.get("content-type") || "";
  return (ct.includes("json") ? res.json() : res.text()) as Promise<T>;
}

export const CATEGORY_LABEL: Record<string, string> = {
  BL_COMPARISON: "BL check", SI_REQUEST: "SI request", INVOICE_QUERY: "Invoice query", GENERAL: "General", SPAM: "Spam",
};
export const STATUS_LABEL: Record<string, string> = {
  OK: "OK", MISMATCH: "Mismatch", NEEDS_REVIEW: "Review", FAILED: "Failed", PENDING: "Pending", SENT: "Sent",
};
export const REASON_LABEL: Record<string, string> = {
  wrong_doc_type: "Wrong document type", missing_attachment: "Missing attachment",
  unreadable: "Unreadable document", missing_value: "Missing value",
};
