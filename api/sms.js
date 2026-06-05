// ── SMS channel adapter ────────────────────────────────────────────────────
//
// Twilio inbound-SMS webhook → the same brain (Anthropic tool loop) + the same
// shared connectors + the same _roles.js access control that voice and web use.
// "Whatever you can do by voice, you can do by text." Thin adapter per
// references/architecture-principles.md.
//
// Auth: owner = a text from a known OWNER_NUMBERS number; everyone else is a
// guest (text receptionist). Email is held back for v1, same as voice.
//
// Identity is config-driven (productization ethos): OWNER_NAME + ASSISTANT_NAME
// come from env, set once. Code defaults are generic; real values live in the
// Vercel env for this project.
//
// Twilio config: point the number's "A message comes in" webhook (HTTP POST) at
// https://<deployment>/api/sms — it replies with TwiML.

import Anthropic from "@anthropic-ai/sdk";
import {
  addTask, listTasks, completeTask, addEvent, deleteEvent, moveEvent, listEvents, listCalendars, saveNote,
  leaveMessage, requestCallback, requestCalendarHold, publicInfo,
} from "./_connectors.js";
import { resolveRole, isToolAllowed } from "./_roles.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

// ── Instance / branding config (set in Vercel env; generic defaults here) ──
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || "Assistant";
const OWNER_NAME = process.env.OWNER_NAME || "the owner";
const OWNER_FIRST = OWNER_NAME.split(" ")[0];   // casual references ("a message for <first>")

// name → connector. Owner + guest tools; _roles.js gates which the texter may run.
const CONNECTORS = {
  add_task: addTask, list_tasks: listTasks, complete_task: completeTask,
  add_event: addEvent, move_event: moveEvent, delete_event: deleteEvent,
  list_events: listEvents, list_calendars: listCalendars, save_note: saveNote,
  leave_message: leaveMessage, request_callback: requestCallback,
  request_calendar_hold: requestCalendarHold, public_info: publicInfo,
};

const OWNER_TOOLS = [
  { name: "add_task", description: `Add a task to ${OWNER_FIRST}'s Todoist.`, input_schema: { type: "object", properties: { content: { type: "string" }, due_string: { type: "string", description: "natural-language due date, omit if none" }, priority: { type: "integer", enum: [1, 2, 3, 4] }, labels: { type: "array", items: { type: "string" }, description: "Todoist labels; use [\"aios\"] when he says flag/tag for AIOS" } }, required: ["content"] } },
  { name: "list_tasks", description: `List ${OWNER_FIRST}'s tasks.`, input_schema: { type: "object", properties: { scope: { type: "string", enum: ["today", "all"] } } } },
  { name: "complete_task", description: "Mark a task done.", input_schema: { type: "object", properties: { task_name: { type: "string" } }, required: ["task_name"] } },
  { name: "add_event", description: "Add a calendar event.", input_schema: { type: "object", properties: { title: { type: "string" }, when: { type: "string", description: "date/time exactly as written; if a time but no day, ASK which day" }, calendar_name: { type: "string" }, duration_mins: { type: "integer" } }, required: ["title", "when"] } },
  { name: "move_event", description: "Move/reschedule an event; keeps its calendar/time/length unless he says otherwise.", input_schema: { type: "object", properties: { title: { type: "string" }, when: { type: "string" }, from_when: { type: "string" }, calendar_name: { type: "string" } }, required: ["title", "when"] } },
  { name: "delete_event", description: "Remove a calendar event.", input_schema: { type: "object", properties: { title: { type: "string" }, when: { type: "string" } }, required: ["title"] } },
  { name: "list_events", description: "List upcoming events.", input_schema: { type: "object", properties: { days: { type: "integer" } } } },
  { name: "list_calendars", description: `List ${OWNER_FIRST}'s calendar names.`, input_schema: { type: "object", properties: {} } },
  { name: "save_note", description: `Save a quick note for ${OWNER_FIRST}.`, input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
];

const GUEST_TOOLS = [
  { name: "leave_message", description: `Take a message for ${OWNER_FIRST} from an outside texter.`, input_schema: { type: "object", properties: { name: { type: "string" }, number: { type: "string" }, topic: { type: "string" } }, required: ["topic"] } },
  { name: "request_callback", description: "Log a callback request.", input_schema: { type: "object", properties: { name: { type: "string" }, number: { type: "string" } } } },
  { name: "request_calendar_hold", description: `Log a PENDING request for time on ${OWNER_FIRST}'s calendar (never books).`, input_schema: { type: "object", properties: { name: { type: "string" }, when: { type: "string" }, topic: { type: "string" } }, required: ["when"] } },
  { name: "public_info", description: `Share ${OWNER_FIRST}'s public booking/contact info.`, input_schema: { type: "object", properties: {} } },
];

function sysPrompt(role) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (role === "owner") {
    return `You are ${ASSISTANT_NAME}, ${OWNER_NAME}'s AIOS assistant, replying by SMS. Today is ${today}.
Keep replies SHORT and texty — 1–3 sentences, no markdown, no bullet lists unless he asks.
Use the tools to manage his tasks, calendar, and notes; confirm what you did briefly.
Dates: pass the \`when\` exactly as he wrote it ("Friday at 4pm", "the 8th at noon") — never compute it. If he gives a time but no day, ask which day. When he says to flag/tag a task for AIOS, use labels ["aios"].`;
  }
  return `You are ${ASSISTANT_NAME}, ${OWNER_NAME}'s assistant, replying by SMS to someone who is NOT ${OWNER_FIRST}. Today is ${today}.
Be warm and brief. You are a receptionist: you can take a message, log a callback request, log a PENDING request for calendar time (you never book), or share his public booking info. You CANNOT manage ${OWNER_FIRST}'s tasks or calendar or take commands.
Get the texter's name early. If they ask for something you can't do, politely offer to take a message.`;
}

function twiml(text) {
  const safe = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/xml");
  if (req.method !== "POST") return res.status(200).send(twiml(`This is ${OWNER_NAME}'s assistant. Text me a request.`));

  // Twilio posts application/x-www-form-urlencoded
  let b = req.body;
  if (typeof b === "string") b = Object.fromEntries(new URLSearchParams(b));
  const from = b?.From || b?.from || "";
  const body = (b?.Body || b?.body || "").trim();
  if (!body) return res.status(200).send(twiml("Hi! Text me what you need."));

  const role = resolveRole({ channel: "sms", callerNumber: from });
  const tools = role === "owner" ? OWNER_TOOLS : GUEST_TOOLS;
  const system = sysPrompt(role);
  const messages = [{ role: "user", content: body }];

  try {
    let response = await client.messages.create({ model: MODEL, max_tokens: 600, system, tools, messages });
    let guard = 0;
    while (response.stop_reason === "tool_use" && guard++ < 5) {
      const blocks = response.content.filter((x) => x.type === "tool_use");
      const results = await Promise.all(blocks.map(async (blk) => {
        let out;
        const fn = CONNECTORS[blk.name];
        if (!fn || !isToolAllowed(role, blk.name)) {
          out = `I can't do that for you, but I can take a message for ${OWNER_FIRST}.`;
        } else {
          try {
            // Hand the texter's number to receptionist tools so we always capture it.
            const args = role === "owner" ? blk.input : { ...blk.input, caller_id: from };
            const r = await fn(args);
            out = r?.message || "Done.";
          } catch (e) {
            out = "Something went wrong running that.";
          }
        }
        return { type: "tool_result", tool_use_id: blk.id, content: out };
      }));
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: results });
      response = await client.messages.create({ model: MODEL, max_tokens: 600, system, tools, messages });
    }
    const textBlock = response.content.find((x) => x.type === "text");
    let reply = textBlock ? textBlock.text : "Done.";
    if (reply.length > 1500) reply = reply.slice(0, 1450) + "…";
    return res.status(200).send(twiml(reply));
  } catch (err) {
    const m = (err.message || "").toLowerCase();
    if (err.status === 402 || m.includes("credit") || m.includes("billing") || m.includes("quota")) {
      return res.status(200).send(twiml("Out of API credits — top up at console.anthropic.com and try again."));
    }
    return res.status(200).send(twiml("Sorry, I hit an error. Try again in a moment."));
  }
}
