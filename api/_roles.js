// ── AIOS Roles & Auth — the shared access-control layer ────────────────────
//
// THE single source of truth for WHO can do WHAT. Every channel adapter
// (voice → vapi-tools.js, SMS → sms.js, web chat → v2.js) resolves the caller's
// role here and filters tools against the same allow-lists. Improve the policy
// once → every door enforces it identically.
//
// Security model (hardened after a live social-engineering test, 2026-05-30):
//   - Owner access is NOT granted by phone number. A call merged/forwarded/on
//     speaker would otherwise hand owner to whoever is talking. Number alone is
//     worthless here.
//   - Owner unlocks ONLY via an explicit handshake: the caller asks to unlock,
//     the agent challenges, the caller proves it with a PIN (keypad) and/or a
//     spoken passphrase. A secret that merely comes up in conversation does
//     nothing — the model cannot unlock on its own say-so.
//   - The SERVER decides unlocked-ness, not the model (the model was shown to
//     hallucinate "you're recognized"). On a verified unlock the server mints a
//     signed, call-scoped, expiring session token; owner tools require it. The
//     model can carry the token but cannot forge one.
//   - FAIL CLOSED: no valid token → guest.
//
// Config as data (env, never committed):
//   OWNER_PIN          digits for the keypad method      (enables "pin")
//   OWNER_CODEWORD     spoken passphrase                 (enables "passphrase")
//   OWNER_AUTH_MODE    "any" (default) | "all" | "off"
//     any = either enabled method unlocks
//     all = every enabled method required (2FA)
//     off = owner unlock disabled entirely
//   AUTH_SECRET        HMAC key for session tokens (falls back to a stable
//                      server secret so it's optional)

import crypto from "crypto";

// ── helpers ─────────────────────────────────────────────────────────────────
export function normalizeNumber(n) {
  if (!n) return "";
  let d = String(n).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d;
}
function normWord(w) {
  return String(w || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function normPin(p) {
  return String(p || "").replace(/\D/g, "");
}

// ── auth config ──────────────────────────────────────────────────────────────
// Owner phone number(s) — used for the SMS channel only. Texts come from a
// single number (no merged-call/speaker problem voice had), so the sender's
// number is a reasonable owner signal. Voice still requires the codeword/PIN.
const OWNER_NUMBERS = new Set(
  (process.env.OWNER_NUMBERS || "").split(",").map((s) => normalizeNumber(s)).filter(Boolean)
);
const OWNER_PIN = normPin(process.env.OWNER_PIN || "");
const OWNER_CODEWORD = normWord(process.env.OWNER_CODEWORD || "");
const AUTH_MODE = (process.env.OWNER_AUTH_MODE || "any").toLowerCase();
// Token-signing key. Prefer an explicit AUTH_SECRET; else reuse a stable
// server-only secret so tokens still can't be forged by the model/callers.
const AUTH_SECRET =
  process.env.AUTH_SECRET ||
  process.env.TODOIST_API_TOKEN ||
  process.env.GITHUB_TOKEN ||
  "aios-fallback-signing-key";
const TOKEN_TTL_SECONDS = 2 * 60 * 60; // a generous single-call window

// Which methods are live (a method is enabled iff its secret is set).
export function enabledMethods() {
  const m = [];
  if (OWNER_PIN) m.push("pin");
  if (OWNER_CODEWORD) m.push("passphrase");
  return m;
}

// Verify the secret(s) a caller supplied during the unlock handshake.
// Respects AUTH_MODE. Returns true only if the policy is satisfied.
export function verifyOwnerSecret({ pin, passphrase } = {}) {
  if (AUTH_MODE === "off") return false;
  const methods = enabledMethods();
  if (!methods.length) return false; // nothing configured → cannot unlock

  const pinOk = OWNER_PIN && normPin(pin) === OWNER_PIN;
  const wordOk = OWNER_CODEWORD && normWord(passphrase) === OWNER_CODEWORD;

  if (AUTH_MODE === "all") {
    // every enabled method must pass
    return methods.every((mth) => (mth === "pin" ? pinOk : wordOk));
  }
  // "any": at least one enabled method passes
  return Boolean(pinOk || wordOk);
}

// ── call-scoped session tokens (stateless, non-forgeable) ────────────────────
function sign(payload) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
}
// Bind the token to this call id + an expiry. The call id is NOT stored in the
// token (supplied from the live call at verify), so a token can't be replayed
// on a different call.
export function issueSessionToken(callId) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const sig = sign(`${callId || "nocall"}|${exp}`);
  return `${exp}.${sig}`;
}
export function verifySessionToken(token, callId) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [expStr, sig] = token.split(".");
  const exp = parseInt(expStr, 10);
  if (!exp || Math.floor(Date.now() / 1000) > exp) return false;
  const expected = sign(`${callId || "nocall"}|${exp}`);
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── tool allow-lists ─────────────────────────────────────────────────────────
// unlock_owner + public_info are the doors a guest may use. Everything else is
// owner-only.
export const GUEST_TOOLS = new Set([
  "unlock_owner",
  "leave_message",
  "request_callback",
  "request_calendar_hold",
  "public_info",
]);
export const OWNER_TOOLS = new Set([
  "add_task",
  "list_tasks",
  "complete_task",
  "add_event",
  "delete_event",
  "move_event",
  "list_events",
  "get_schedule",
  "list_calendars",
  "save_note",
  "save_context",
  "read_email",
  "send_email",
  ...GUEST_TOOLS,
]);

// Resolve a caller's role.
//  - web:   trusted private deployment → owner.
//  - sms:   owner if the text comes from a known owner number (sender number is
//           the identity for 1:1 texts; voice's merged-call risk doesn't apply).
//  - voice: owner ONLY via a valid in-call session token (codeword/PIN handshake).
// Fails closed: anything unrecognized → guest.
export function resolveRole({ channel, callerNumber, sessionToken, callId } = {}) {
  if (channel === "web") return "owner";
  if (channel === "sms") {
    const num = normalizeNumber(callerNumber);
    return num && OWNER_NUMBERS.has(num) ? "owner" : "guest";
  }
  if (verifySessionToken(sessionToken, callId)) return "owner";
  return "guest";
}

export function isToolAllowed(role, toolName) {
  const set = role === "owner" ? OWNER_TOOLS : GUEST_TOOLS;
  return set.has(toolName);
}
