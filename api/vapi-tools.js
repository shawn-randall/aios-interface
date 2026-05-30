// ── Vapi Tools — VOICE channel adapter ─────────────────────────────────────
//
// Thin adapter (references/architecture-principles.md): translates Vapi's
// tool-call webhook format into shared AIOS connector calls and returns the
// voice-friendly `message`. ALL real capability logic lives in _connectors.js
// so voice, web chat, and SMS stay in lockstep — improve once, every channel
// gets it. Add a voice tool = map a name here + add the connector (if new) +
// register the schema in scripts/aios_vapi.py, then `sync`.

import { addTask, listTasks, completeTask, addEvent, listEvents, saveNote } from "./_connectors.js";

// Owner identity (caller number) — for the future role layer. Captured now,
// gating to be added per projects/voice-agent.md.
const OWNER_NUMBERS = (process.env.AIOS_OWNER_NUMBERS || "").split(",").map((s) => s.trim()).filter(Boolean);

// name → connector. The voice channel speaks the connector's `message`.
const TOOLS = {
  add_task: addTask,
  list_tasks: listTasks,
  complete_task: completeTask,
  add_event: addEvent,
  get_schedule: ({ days } = {}) => listEvents({ days }),
  save_note: saveNote,
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const msg = req.body?.message || {};
  const calls = msg.toolCallList || msg.toolCalls || msg.toolCallsList || [];
  const callerNumber = msg.call?.customer?.number || msg.customer?.number || null;
  const role = callerNumber && OWNER_NUMBERS.includes(callerNumber) ? "owner" : "owner"; // TODO: guest default w/ role layer

  const results = [];
  for (const call of calls) {
    const id = call.id || call.toolCallId;
    const fn = call.function || call;
    const name = fn.name;
    let args = fn.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }

    let result;
    const connector = TOOLS[name];
    if (connector) {
      try {
        const r = await connector(args);
        result = r?.message || (r?.ok ? "Done." : "Sorry, that didn't work.");
      } catch (e) {
        result = "Sorry, something went wrong running that.";
      }
    } else {
      result = `Unknown tool: ${name}`;
    }
    results.push({ toolCallId: id, result });
  }

  return res.status(200).json({ results });
}
