// ── Vapi Tools — VOICE channel adapter ─────────────────────────────────────
//
// Thin adapter (references/architecture-principles.md): translates Vapi's
// tool-call webhook format into shared AIOS connector calls and returns the
// voice-friendly `message`. ALL real capability logic lives in _connectors.js
// so voice, web chat, and SMS stay in lockstep — improve once, every channel
// gets it. Add a voice tool = map a name here + add the connector (if new) +
// register the schema in scripts/aios_vapi.py, then `sync`.

import {
  addTask, listTasks, completeTask, addEvent, deleteEvent, moveEvent, listEvents, listCalendars, saveNote,
  leaveMessage, requestCallback, requestCalendarHold, publicInfo,
} from "./_connectors.js";
import { resolveRole, isToolAllowed, unlockChallenge, issueSessionToken } from "./_roles.js";
import { supabaseReady, upsertContact, updateContact, getContactByPhone, insertInteraction, getOpenOutbound, markResolved, getMessages, archiveInteraction } from "./_supabase.js";

// ── Outbound calling (owner: "call X and ask Y, then call me back") ───────────
// Same loop proven by scripts/aios_outbound_call.py (Matt Park test), now cloud-
// driven so Daisy can trigger it by voice. Identity is config-driven (ethos).
const VAPI_KEY       = process.env.VAPI_API_KEY;                    // set in Vercel
const OWNER_CALLBACK = process.env.OWNER_CALLBACK_NUMBER;           // Shawn's cell, set in Vercel
const OUT_PHONE_ID   = "82f23c4f-1e0b-4320-aab6-258875c34a8e";      // Twilio (646) line = caller ID
const OUT_ASSISTANT  = "23850e1c-b0c6-4ea5-89fd-dbcd0e5a8917";      // AIOS assistant
const OUT_NAME       = process.env.ASSISTANT_NAME || "Daisy";        // config knob (productization)
const REC_NOTICE     = process.env.RECORDING_NOTICE || "";           // config knob: "this call may be recorded"; empty = off
const OUT_WEBHOOK    = "https://aios-interface-jet.vercel.app/api/vapi-tools";
const OUT_MAXSEC     = 600;
const OUT_VM_DETECT  = { provider: "vapi", type: "audio", beepMaxAwaitSeconds: 30 };

async function vapiPlaceCall(payload) {
  if (!VAPI_KEY) return null;
  try {
    const r = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${VAPI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Call the CONTACT, ask the question, and route the end-of-call report back here.
async function startOutboundCall({ contact_name, contact_number, question } = {}) {
  if (!VAPI_KEY || !OWNER_CALLBACK) return "Outbound calling isn't fully set up yet — Shawn needs to finish the config.";
  if (!contact_number || !question)  return "I need a phone number to call and a question to ask.";
  const who = contact_name || "them";
  const objective =
    `You are ${OUT_NAME}, Shawn Randall's personal AI assistant, making a brief outbound call on his behalf. ` +
    `You are an AI assistant — never pretend to be Shawn. Be warm and concise. Introduce yourself, then ask exactly this: ` +
    `"${question}". Listen, confirm the answer back, thank them, and end the call. If you reach a voicemail, leave the voicemail message.`;
  const call = await vapiPlaceCall({
    phoneNumberId: OUT_PHONE_ID,
    customer: { number: contact_number },
    assistantId: OUT_ASSISTANT,
    metadata: { aiosOutbound: "ask", contactName: who, question },
    assistantOverrides: {
      firstMessage: `Hi! This is ${OUT_NAME}, Shawn Randall's assistant, calling on his behalf.${REC_NOTICE ? " " + REC_NOTICE : ""} Do you have a quick moment?`,
      model: { provider: "openai", model: "gpt-4.1", messages: [{ role: "system", content: objective }] },
      maxDurationSeconds: OUT_MAXSEC,
      voicemailDetection: OUT_VM_DETECT,
      voicemailMessage: `Hi, this is ${OUT_NAME}, Shawn Randall's assistant. Shawn asked me to reach you with a quick question. Please give us a call back when you can. Thank you so much!`,
      server: { url: OUT_WEBHOOK },
      serverMessages: ["end-of-call-report"],
      analysisPlan: { structuredDataPlan: { enabled: true, schema: { type: "object", properties: {
        reached_person: { type: "boolean", description: "Did a live person answer (vs voicemail)?" },
        answer: { type: "string", description: "Answer to Shawn's question in 1-2 sentences; empty if not obtained." },
      } } } },
    },
  });
  // Persist the open question so a callback can recall it (best-effort; no-ops if Supabase off).
  try {
    const [first, ...rest] = (contact_name || "").trim().split(" ");
    const contact = await upsertContact({ first_name: first || undefined, last_name: rest.join(" ") || undefined, phone: contact_number });
    if (contact) await insertInteraction({ contact_id: contact.id, direction: "outbound", channel: "voice", vapi_call_id: call?.id, outbound_question: question, resolved: false });
  } catch {}
  return `Okay, I'm calling ${who} now to ask that. I'll call you right back with what they say.`;
}

// CONTACT call ended → call Shawn back with the captured answer (voicemail fallback).
async function deliverOutboundResult(msg) {
  const meta = msg.call?.metadata || msg.metadata || {};
  if (meta.aiosOutbound !== "ask" || !OWNER_CALLBACK) return;
  const sd = msg.analysis?.structuredData || msg.call?.analysis?.structuredData || {};
  const answer = (sd.answer || "").trim();
  const who = meta.contactName || "them";
  const result = (msg.endedReason === "voicemail" || !answer)
    ? `I couldn't reach ${who}, so I left a voicemail asking them to call back.`
    : `I reached ${who}. They said: ${answer}`;
  await vapiPlaceCall({
    phoneNumberId: OUT_PHONE_ID,
    customer: { number: OWNER_CALLBACK },
    assistantId: OUT_ASSISTANT,
    metadata: { aiosOutbound: "deliver" },
    assistantOverrides: {
      firstMessage: `Hey Shawn, it's ${OUT_NAME} with an update. ${result}`,
      model: { provider: "openai", model: "gpt-4.1", messages: [{ role: "system", content:
        `You are ${OUT_NAME}, Shawn's assistant, calling Shawn to deliver the result of a call you made for him. Greet him, deliver the update clearly, ask if there's anything else, then end. Keep it brief.` }] },
      maxDurationSeconds: OUT_MAXSEC,
      voicemailDetection: OUT_VM_DETECT,
      voicemailMessage: `Hey Shawn, it's ${OUT_NAME}. ${result} Talk soon!`,
    },
  });
}

// recall_caller — at the start of an inbound call, look up THIS caller's record +
// the newest open question Shawn asked them, so the receptionist greets by name and
// can re-ask. Returns a short instruction string the model acts on.
async function recallCaller(caller_id) {
  if (!supabaseReady() || !caller_id) return "NO_MEMORY. No record for this caller — greet normally and offer to help.";
  const contact = await getContactByPhone(caller_id);
  if (!contact) return "NO_MEMORY. No record for this caller — greet normally and offer to help.";
  const first = contact.first_name || "";
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
  const open = await getOpenOutbound(contact.id);
  if (open && open.outbound_question) {
    return `KNOWN_CALLER name="${name}". OPEN_QUESTION: Shawn recently called them to ask: "${open.outbound_question}". They are likely returning that call. Greet ${first || "them"} warmly by name, mention Shawn had a question, then ask it and capture their answer.`;
  }
  return `KNOWN_CALLER name="${name}". No open question. Greet ${first || "them"} warmly by name and ask how you can help.`;
}

// Inbound call ended → persist the verbatim message + sentiment + a Vapi transcript
// link (what a paraphrase loses), and close any open outbound question they answered.
async function captureInboundCall(msg) {
  const callerNumber = msg.call?.customer?.number || null;
  if (!callerNumber) return;
  // The owner's own calls aren't voicemails — don't log them as messages.
  const OWNER_NUMS = (process.env.OWNER_NUMBERS || "").split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean);
  if (OWNER_NUMS.includes(String(callerNumber).replace(/\D/g, ""))) return;
  const sd = msg.analysis?.structuredData || msg.call?.analysis?.structuredData || {};
  const summary = (msg.analysis?.summary || msg.call?.analysis?.summary || "").trim();
  const vapiCallId = msg.call?.id || null;
  const recordingUrl = msg.artifact?.recordingUrl || msg.call?.artifact?.recordingUrl || null;
  const verbatim = (sd.verbatim_message || sd.message || "").trim();
  const sentiment = (sd.sentiment || "").trim();
  const cname = (sd.caller_name || "").trim();
  const nameConfirmed = sd.name_confirmed === true;   // did the caller verify the spelling this call?
  const [first, ...rest] = cname.split(" ");
  const last = rest.join(" ");
  try {
    let contact = await getContactByPhone(callerNumber);
    if (!contact) {
      // brand-new caller — store the name + whether they confirmed the spelling
      contact = await upsertContact({ first_name: first || undefined, last_name: last || undefined, phone: callerNumber, name_confirmed: nameConfirmed });
    } else if (cname && !contact.name_confirmed && (nameConfirmed || !contact.first_name)) {
      // known caller whose name isn't locked yet: update ONLY if they just confirmed
      // the spelling, or we never had a name. A confirmed name is never clobbered.
      contact = await updateContact(contact.id, { first_name: first || null, last_name: last || null, name_confirmed: nameConfirmed }) || contact;
    }
    if (contact?.id) {
      await insertInteraction({ contact_id: contact.id, direction: "inbound", channel: "voice", vapi_call_id: vapiCallId, summary, verbatim, sentiment, recording_url: recordingUrl });
      const open = await getOpenOutbound(contact.id);   // returning our call? close the loop.
      if (open) await markResolved(open.id);
    }
  } catch {}
  // Surface the EXACT record in Todoist (verbatim + ▶ listen + transcript link), best-effort.
  if (verbatim || summary) {
    const who = cname || "a caller";
    const listen = recordingUrl ? ` — ▶ listen: ${recordingUrl}` : "";
    const link = vapiCallId ? ` — transcript: https://dashboard.vapi.ai/calls/${vapiCallId}` : "";
    try { await addTask({ content: `📞 Call recap — ${who}: ${verbatim || summary}${sentiment ? ` (${sentiment})` : ""}${listen}${link}`, labels: ["aios"] }); } catch {}
  }
}

// Voicemail box (owner-only): read back stored messages, and soft-delete them.
async function listMessages({ kind } = {}) {
  if (!supabaseReady()) return "The message store isn't set up yet.";
  const k = (kind || "inbound").toLowerCase();
  const msgs = await getMessages({ kind: k });
  if (!msgs.length) return `No ${k === "all" ? "" : k + " "}messages right now — the box is empty.`;
  const lines = msgs.map((m, i) => {
    const c = m.contacts || {};
    const who = [c.first_name, c.last_name].filter(Boolean).join(" ") || "an unknown caller";
    const when = new Date(m.created_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const what = (m.verbatim || m.summary || "(no message left)").slice(0, 400);
    return `${i + 1}) From ${who} on ${when}: "${what}" [id=${m.id}${m.recording_url ? " has_audio=yes" : ""}]`;
  });
  return `There ${msgs.length === 1 ? "is 1 message" : `are ${msgs.length} messages`}. Read them to Shawn ONE AT A TIME, newest first. After each, ask if he wants to delete it, hear the audio, or move to the next. When he says delete, call archive_message with that message's id. NEVER read an id aloud.\n${lines.join("\n")}`;
}

async function archiveMessage({ message_id } = {}) {
  if (!message_id) return "I'm not sure which message to delete — let's go through them and you can tell me which one.";
  const r = await archiveInteraction(message_id);
  return r === null ? "Hmm, I couldn't delete that one — want me to try again?" : "Done — deleted that message.";
}

// draft_broadcast — owner-only: compose an email to Shawn's Kit list as a DRAFT.
// NEVER sends — Shawn reviews + sends in Kit (so a voice mishear can't blast the list).
const KIT_API_KEY = process.env.KIT_API_KEY;
async function draftBroadcast({ subject, body } = {}) {
  if (!KIT_API_KEY) return "The email list isn't connected yet — Shawn needs to add the Kit key in Vercel.";
  if (!subject || !body) return "I need a subject and a short message to draft the broadcast.";
  const html = "<p>" + String(body).trim().replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
  try {
    const r = await fetch("https://api.kit.com/v4/broadcasts", {
      method: "POST",
      headers: { "X-Kit-Api-Key": KIT_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ subject, content: html, description: "Drafted by Daisy" }),
    });
    if (!r.ok) return "I couldn't create that draft — the email tool returned an error.";
    return `Done — I saved "${subject}" as a draft in Kit. Give it a look and hit send when you're ready; I left it as a draft so nothing goes out until you say so.`;
  } catch { return "I couldn't reach the email tool to draft that."; }
}

// name → connector. Owner tools + guest (receptionist) tools both live here;
// _roles.js decides which the current caller may actually run, and the handler
// refuses the rest. Keep these names in sync with the allow-lists in _roles.js.
const TOOLS = {
  // owner
  add_task: addTask,
  list_tasks: listTasks,
  complete_task: completeTask,
  add_event: addEvent,
  delete_event: deleteEvent,
  move_event: moveEvent,
  get_schedule: ({ days } = {}) => listEvents({ days }),
  list_calendars: listCalendars,
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
  const callerNumber = msg.call?.customer?.number || msg.customer?.number || null; // caller ID, captured automatically

  // Outbound follow-up: a contact call we placed has ended → call Shawn back with the answer.
  if (msg.type === "end-of-call-report") {
    const meta = msg.call?.metadata || msg.metadata || {};
    if (meta.aiosOutbound === "ask") await deliverOutboundResult(msg);   // a contact call WE placed
    else if (!meta.aiosOutbound) await captureInboundCall(msg);          // someone called US
    return res.status(200).json({ received: true });
  }

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
    // Hand the real caller ID to connectors that want it (e.g. receptionist
    // tools), so we capture a number even when the caller never says one.
    toolArgs.caller_id = callerNumber;

    let result;

    // recall_caller — safe for any caller: looks up only THIS caller's own record.
    if (name === "recall_caller") {
      result = await recallCaller(callerNumber);
      results.push({ toolCallId: id, result });
      continue;
    }

    // unlock_owner is the handshake door — verify the secret(s) here and, on
    // success, mint a call-scoped token. The MODEL never decides owner-ness.
    if (name === "unlock_owner") {
      // The SERVER owns the policy (OWNER_AUTH_MODE) and drives the handshake.
      // The model just relays what the server asks for — so flipping the mode
      // changes the conversation with no prompt/code edits (modular for resale).
      const c = unlockChallenge({ pin: toolArgs.pin, passphrase: toolArgs.passphrase });
      if (c.status === "disabled") {
        result = `OWNER_UNLOCK_DISABLED. Owner mode is turned off for this account. Tell the caller owner access is unavailable right now and offer to take a message. Do NOT ask for a PIN or codeword.`;
      } else if (c.status === "challenge") {
        const ask = c.missing
          .map((m) => (m === "pin" ? "enter their PIN on the keypad and press pound" : "say their codeword"))
          .join(c.mode === "all" ? " AND " : " or ");
        const note = c.mode === "all" ? "This account requires BOTH factors." : "Either one is enough.";
        result = `UNLOCK_CHALLENGE. ${note} Ask the caller to ${ask}. Then call unlock_owner again with what they provide. Do not reveal whether any earlier factor was correct.`;
      } else if (c.status === "granted") {
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

    // call_someone — owner-only outbound call (place call → auto call Shawn back).
    if (name === "call_someone") {
      result = role === "owner"
        ? await startOutboundCall(toolArgs)
        : "I can only place calls for Shawn once he's unlocked owner mode.";
      results.push({ toolCallId: id, result });
      continue;
    }

    // Voicemail box — owner-only.
    if (name === "list_messages") {
      result = role === "owner" ? await listMessages(toolArgs) : "I can only read Shawn's messages once he's unlocked owner mode.";
      results.push({ toolCallId: id, result }); continue;
    }
    if (name === "archive_message") {
      result = role === "owner" ? await archiveMessage(toolArgs) : "I can only delete messages once Shawn's unlocked owner mode.";
      results.push({ toolCallId: id, result }); continue;
    }
    if (name === "draft_broadcast") {
      result = role === "owner" ? await draftBroadcast(toolArgs) : "I can only draft broadcasts once Shawn's unlocked owner mode.";
      results.push({ toolCallId: id, result }); continue;
    }

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
