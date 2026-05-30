// ── AIOS Roles — the shared access-control layer ───────────────────────────
//
// THE single source of truth for WHO can do WHAT. Every channel adapter
// (voice → vapi-tools.js, SMS → sms.js, web chat → v2.js) resolves the caller's
// role here and filters the tools it will run against the same allow-lists.
// Improve the policy once → every door enforces it identically.
//
// Security model (see projects/voice-agent.md):
//   - Vapi runs ONE assistant; the model can be talked around, so THIS code is
//     the real gate. Channels MUST refuse a tool when isToolAllowed() is false.
//   - Owner = a known phone number (frictionless) OR the spoken codeword (works
//     from any phone, defeats caller-ID spoofing).
//   - Everyone else = guest (a receptionist — message + pending booking only).
//   - FAIL CLOSED: missing/garbled identity resolves to guest, never owner.
//
// Config as data (never committed): OWNER_NUMBERS + OWNER_CODEWORD live in env.

// Reduce a phone number to its comparable core: digits only, US 11→10 (drop
// leading country "1"). Makes "+1 (646) 680-9460", "16466809460", and
// "646-680-9460" all match.
export function normalizeNumber(n) {
  if (!n) return "";
  let d = String(n).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d;
}

// Codewords compared loosely: case-insensitive, punctuation/space stripped, so
// "Blue Heron." spoken == "blueheron" in env.
function normalizeWord(w) {
  return String(w || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const OWNER_NUMBERS = new Set(
  (process.env.OWNER_NUMBERS || "")
    .split(",")
    .map((s) => normalizeNumber(s))
    .filter(Boolean)
);

const OWNER_CODEWORD = normalizeWord(process.env.OWNER_CODEWORD || "");

// ── Tool allow-lists (the contract every channel filters against) ───────────
export const GUEST_TOOLS = new Set([
  "leave_message",
  "request_callback",
  "request_calendar_hold",
  "public_info",
]);

// Owner is a superset — everything across every channel, plus the guest tools.
// (Voice uses get_schedule; web uses list_events + save_context — all owner-only.)
export const OWNER_TOOLS = new Set([
  "add_task",
  "list_tasks",
  "complete_task",
  "add_event",
  "list_events",
  "get_schedule",
  "save_note",
  "save_context",
  "read_email",
  "send_email",
  ...GUEST_TOOLS,
]);

// Resolve a caller's role. `channel` is "voice" | "sms" | "web".
export function resolveRole({ channel, callerNumber, ownerKey } = {}) {
  if (channel === "web") return "owner"; // Shawn's private deployment

  const num = normalizeNumber(callerNumber);
  if (num && OWNER_NUMBERS.has(num)) return "owner";

  const key = normalizeWord(ownerKey);
  if (key && OWNER_CODEWORD && key === OWNER_CODEWORD) return "owner";

  return "guest"; // fail closed
}

export function isToolAllowed(role, toolName) {
  const set = role === "owner" ? OWNER_TOOLS : GUEST_TOOLS;
  return set.has(toolName);
}
