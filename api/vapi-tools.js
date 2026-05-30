// ── Vapi Tools channel adapter ─────────────────────────────────────────────
// A thin CHANNEL adapter (per architecture-principles.md): translates Vapi's
// tool-call webhook format into AIOS connector calls and back. The voice agent
// (Vapi) is the channel + orchestrator; this exposes AIOS capabilities as tools.
//
// Add a capability = add one entry to TOOLS below. Each is a self-contained
// connector. Keep this file free of Vapi-specific business logic beyond parsing.

import { DAVClient } from "tsdav";

const TODOIST_TOKEN = process.env.TODOIST_API_TOKEN;
const TODOIST_BASE = "https://api.todoist.com/api/v1";

// Owner identity (caller number) — env, never hardcoded in a committed value.
// Used for the role layer; for now we capture it and default to owner-lite.
const OWNER_NUMBERS = (process.env.AIOS_OWNER_NUMBERS || "").split(",").map((s) => s.trim()).filter(Boolean);

// ── Connectors (reused AIOS logic) ─────────────────────────────────────────

async function todoistPost(path, body = {}) {
  const res = await fetch(`${TODOIST_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TODOIST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return res.json();
}

async function todoistGet(path, params = {}) {
  const url = new URL(`${TODOIST_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TODOIST_TOKEN}` } });
  if (!res.ok) return null;
  return res.json();
}

// Calendar (iCloud CalDAV) — reused from the web app's add_event connector.
async function caldavAddEvent(title, date, time, durationMins = 60) {
  const davClient = new DAVClient({
    serverUrl: "https://caldav.icloud.com",
    credentials: { username: process.env.APPLE_ID, password: process.env.APPLE_APP_PASSWORD },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await davClient.login();
  const calendars = await davClient.fetchCalendars();
  if (!calendars.length) return null;
  const PREFERRED = ["home", "personal", "calendar"];
  const cal = calendars.find((c) => PREFERRED.some((p) => (c.displayName || "").toLowerCase().includes(p)))
    || calendars.find((c) => !(c.displayName || "").toLowerCase().includes("ensemble")) || calendars[0];

  const timeStr = time || "12:00";
  const fmtLocal = (d, t) => { const [y, m, dy] = d.split("-"); const [h, mn] = t.split(":"); return `${y}${m}${dy}T${h}${mn}00`; };
  const [sh, sm] = timeStr.split(":").map(Number);
  const tot = sh * 60 + sm + durationMins;
  const endTime = `${String(Math.floor(tot / 60) % 24).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`;
  const uid = `aios-${Date.now()}@shawn`;
  const nowUtc = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const vcal = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AIOS//EN", "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${nowUtc}`,
    `DTSTART;TZID=America/New_York:${fmtLocal(date, timeStr)}`,
    `DTEND;TZID=America/New_York:${fmtLocal(date, endTime)}`,
    `SUMMARY:${title}`, "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  await davClient.createCalendarObject({ calendar: cal, filename: `${uid}.ics`, iCalString: vcal });
  return { date, timeStr, durationMins };
}

// ── Tool registry ──────────────────────────────────────────────────────────
// name → async (args, ctx) => string (a short, voice-friendly result line)

const TOOLS = {
  add_task: async (args) => {
    const content = (args.content || "").trim();
    if (!content) return "I didn't catch the task. What should it say?";
    const body = { content };
    if (args.due_string) body.due_string = args.due_string;
    if (args.priority) body.priority = args.priority;
    const task = await todoistPost("/tasks", body);
    if (!task) return "Sorry, I couldn't add that task — there was a problem reaching Todoist.";
    return `Done. Added "${task.content}"${task.due ? ` due ${task.due.string}` : ""}.`;
  },

  list_tasks: async (args) => {
    const data = await todoistGet("/tasks");
    if (!data) return "Sorry, I couldn't reach your task list right now.";
    let tasks = data.results ?? data;
    const scope = (args.scope || "today").toLowerCase();
    if (scope !== "all") {
      // today + overdue = anything due today or earlier (client-side, reliable)
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      tasks = tasks.filter((t) => t.due && t.due.date && t.due.date <= today);
    }
    if (!tasks.length) {
      return scope === "all"
        ? "You have no active tasks. You're clear."
        : "Nothing due today or overdue. You're all caught up.";
    }
    const top = tasks.slice(0, 8).map((t) => t.content + (t.due ? ` (due ${t.due.string})` : ""));
    const more = tasks.length > 8 ? ` Plus ${tasks.length - 8} more.` : "";
    const label = scope === "all" ? "active task" : "due or overdue";
    return `You have ${tasks.length} ${label}${tasks.length === 1 ? "" : "s"}: ${top.join("; ")}.${more}`;
  },

  add_event: async (args) => {
    const title = (args.title || "").trim();
    const date = (args.date || "").trim();
    if (!title || !date) return "I need both a title and a date for the event.";
    try {
      const r = await caldavAddEvent(title, date, args.time, args.duration_mins || 60);
      if (!r) return "Sorry, I couldn't reach your calendar.";
      return `Added "${title}" to your calendar on ${date}${args.time ? ` at ${args.time}` : ""}.`;
    } catch (e) {
      return "Sorry, something went wrong adding that to your calendar.";
    }
  },
};

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const msg = req.body?.message || {};
  // Vapi has used both keys across versions — handle both.
  const calls = msg.toolCallList || msg.toolCalls || msg.toolCallsList || [];

  // Capture caller identity for the role layer (charter: build it in from line one).
  const callerNumber = msg.call?.customer?.number || msg.customer?.number || null;
  const role = callerNumber && OWNER_NUMBERS.includes(callerNumber) ? "owner" : "owner"; // TODO: guest default once role layer lands
  const ctx = { callerNumber, role };

  const results = [];
  for (const call of calls) {
    const id = call.id || call.toolCallId;
    const fn = call.function || call;
    const name = fn.name;
    let args = fn.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }

    let result;
    if (TOOLS[name]) {
      try {
        result = await TOOLS[name](args, ctx);
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
