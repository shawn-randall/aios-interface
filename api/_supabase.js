// ── Supabase (caller memory / CRM store) ───────────────────────────────────
//
// Thin fetch wrapper over Supabase's REST API (PostgREST). Persists contacts +
// interactions so the voice receptionist can recall WHY we called someone and
// store the verbatim message a call summary would lose. See
// references/supabase-api.md for schema + setup.
//
// GRACEFUL BY DESIGN: every function returns null on any failure (missing env,
// paused free-tier project, network). Callers treat null as "no memory" and fall
// back to today's behavior — the receptionist always still works.
//
// Multi-tenant-ready, single-owner now: every row carries owner_id (OWNER_ID env).

const URL = process.env.SUPABASE_URL;            // https://<ref>.supabase.co
const KEY = process.env.SUPABASE_SERVICE_KEY;    // service_role secret (server-only)
const OWNER = process.env.OWNER_ID || "owner";   // per-tenant key (generic default)

export function supabaseReady() {
  return Boolean(URL && KEY);
}

// Normalize phone so spoken "720-517-1809" and caller-ID "+17205171809" match.
export function normalizePhone(num) {
  const d = String(num || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d ? `+${d}` : "";
}

async function sb(method, path, { body, prefer } = {}) {
  if (!supabaseReady()) return null;
  try {
    const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(`${URL}/rest/v1/${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) return null;
    const txt = await r.text();
    return txt ? JSON.parse(txt) : [];
  } catch { return null; }
}

// Insert-or-update a contact by (owner_id, phone). Returns the row, or null.
export async function upsertContact({ first_name, last_name, phone, email, notes } = {}) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const row = { owner_id: OWNER, phone: p, updated_at: new Date().toISOString() };
  if (first_name) row.first_name = first_name;
  if (last_name) row.last_name = last_name;
  if (email) row.email = email;
  if (notes) row.notes = notes;
  const out = await sb("POST", "contacts?on_conflict=owner_id,phone", {
    body: row, prefer: "resolution=merge-duplicates,return=representation",
  });
  return Array.isArray(out) ? out[0] || null : out;
}

export async function getContactByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const out = await sb("GET", `contacts?owner_id=eq.${OWNER}&phone=eq.${encodeURIComponent(p)}&select=*`);
  return Array.isArray(out) ? out[0] || null : null;
}

export async function insertInteraction(fields = {}) {
  const row = { owner_id: OWNER, ...fields };
  const out = await sb("POST", "interactions", { body: row, prefer: "return=representation" });
  return Array.isArray(out) ? out[0] || null : out;
}

// Newest unresolved outbound "ask" for a contact — what we still owe an answer to.
export async function getOpenOutbound(contactId) {
  if (!contactId) return null;
  const out = await sb("GET",
    `interactions?owner_id=eq.${OWNER}&contact_id=eq.${contactId}&direction=eq.outbound&resolved=eq.false&order=created_at.desc&limit=1`);
  return Array.isArray(out) ? out[0] || null : null;
}

export async function markResolved(interactionId) {
  if (!interactionId) return null;
  return sb("PATCH", `interactions?id=eq.${interactionId}`, { body: { resolved: true } });
}
