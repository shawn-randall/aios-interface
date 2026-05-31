// ── Vapi Tools — VOICE channel adapter ─────────────────────────────────────
//
// Thin adapter (references/architecture-principles.md): translates Vapi's
// tool-call webhook format into shared AIOS connector calls and returns the
// voice-friendly `message`. ALL real capability logic lives in _connectors.js
// so voice, web chat, and SMS stay in lockstep — improve once, every channel
// gets it. Add a voice tool = map a name here + add the connector (if new) +
// register the schema in scripts/aios_vapi.py, then `sync`.

import {
  addTask, listTasks, completeTask, addEvent, listEvents, saveNote,
  leaveMessage, requestCallback, requestCalendarHold, publicInfo,
} from "./_connectors.js";
import { resolveRole, isToolAllowed, verifyOwnerSecret, issueSessionToken } from "./_roles.js";

// name → connector. Owner tools + guest (receptionist) tools both live here;
// _roles.js decides which the current caller may actually run, and the handler
// refuses the rest. Keep these names in sync with the allow-lists in _roles.js.
const TOOLS = {
  // owner
  add_task: addTask,
  list_tasks: listTasks,
  complete_task: completeTask,
  add_event: addEvent,
  get_schedule: ({ days } = {}) => listEvents({ days }),
  save_note: saveNote,
  // guest / receptionist
  leave_message: leaveMessage,
  request_callback: requestCallback,
  request_calendar_hold: requestCalendarHold,
  public_info: publicInfo,
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const msg = req.body?.message || {};
  const calls = msg.toolCallList || msg.toolCalls || msg.toolCallsList || [];
  const callId = msg.call?.id || msg.callId || null; // binds the session token to THIS call

  const results = [];
  for (const call of calls) {
    const id = call.id || call.toolCallId;
    const fn = call.function || call;
    const name = fn.name;
    let args = fn.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }

    // session_token is the proof of a verified unlock, minted server-side and
    // threaded by the model on owner actions. Strip it before the connector runs.
    const { session_token: sessionToken, ...toolArgs } = args || {};

    let result;

    // unlock_owner is the handshake door — verify the secret(s) here and, on
    // success, mint a call-scoped token. The MODEL never decides owner-ness.
    if (name === "unlock_owner") {
      const ok = verifyOwnerSecret({ pin: toolArgs.pin, passphrase: toolArgs.passphrase });
      if (ok) {
        const token = issueSessionToken(callId);
        result = `OWNER_ACCESS_GRANTED. session_token=${token}. Say only: "You're unlocked." Attach this session_token to every owner action for the rest of this call. NEVER say the token aloud.`;
      } else {
        result = `OWNER_ACCESS_DENIED. Stay in guest mode. Tell the caller that didn't match and offer to try again or take a message. Do not reveal which part was wrong.`;
      }
      results.push({ toolCallId: id, result });
      continue;
    }

    // THE GATE. Owner only via a valid in-call token; else guest (fail closed).
    const role = resolveRole({ channel: "voice", sessionToken, callId });
    const connector = TOOLS[name];
    if (!connector) {
      result = `Unknown tool: ${name}`;
    } else if (!isToolAllowed(role, name)) {
      // Hard refusal — the model can ask but cannot act outside its role.
      result = "I'm not able to do that for you. I can take a message for Shawn, or pass along a request to get on his calendar.";
    } else {
      try {
        const r = await connector(toolArgs);
        result = r?.message || (r?.ok ? "Done." : "Sorry, that didn't work.");
      } catch (e) {
        result = "Sorry, something went wrong running that.";
      }
    }
    results.push({ toolCallId: id, result });
  }

  return res.status(200).json({ results });
}
