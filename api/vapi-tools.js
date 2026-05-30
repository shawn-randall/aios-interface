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

// Resolve a spoken date/time phrase ("next Friday at 4pm", "tomorrow", "June 6 at noon")
// to { date: 'YYYY-MM-DD', time: 'HH:MM' | null } using the SERVER's current date
// (America/New_York). Keeps date math out of the LLM — no hallucinated dates.
function resolveWhen(phrase) {
  if (!phrase) return { date: null, time: null };
  const p = phrase.toLowerCase().trim();
  const TZ = "America/New_York";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const today = new Date(Date.UTC(ty, tm - 1, td));
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];

  const iso = (d) => d.toISOString().slice(0, 10);

  // ── time ──
  let time = null;
  let tm2 = p.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (tm2) {
    let h = parseInt(tm2[1], 10); const mn = tm2[2] ? parseInt(tm2[2], 10) : 0;
    if (tm2[3] === "pm" && h < 12) h += 12;
    if (tm2[3] === "am" && h === 12) h = 0;
    time = `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
  } else if (/\bnoon\b/.test(p)) time = "12:00";
  else if (/\bmidnight\b/.test(p)) time = "00:00";
  else { // bare "at 4" → assume pm-ish daytime
    const bare = p.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
    if (bare) { let h = parseInt(bare[1], 10); if (h <= 7) h += 12; time = `${String(h).padStart(2,"0")}:${String(bare[2]?parseInt(bare[2],10):0).padStart(2,"0")}`; }
  }

  // ── date ──
  let date = null;
  const addDays = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

  if (/\btoday\b/.test(p)) date = iso(today);
  else if (/\btomorrow\b/.test(p)) date = addDays(1);
  else {
    // explicit "June 6", "june 6th"
    const md = p.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/);
    if (md) {
      const mi = months.findIndex((m) => m.startsWith(md[1]));
      let yr = ty;
      let cand = new Date(Date.UTC(yr, mi, parseInt(md[2], 10)));
      if (cand < today) cand = new Date(Date.UTC(yr + 1, mi, parseInt(md[2], 10)));
      date = iso(cand);
    } else {
      // weekday: "friday", "next friday", "this friday"
      const wd = days.findIndex((d) => p.includes(d));
      if (wd >= 0) {
        const todayDow = today.getUTCDay();
        let delta = (wd - todayDow + 7) % 7;
        if (delta === 0) delta = 7;            // same weekday name → next week
        if (/\bnext\b/.test(p) && delta <= 7) {} // "next friday" = the coming friday (already handled)
        date = addDays(delta);
      }
    }
  }
  return { date, time };
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
    const n = tasks.length;
    const noun = `task${n === 1 ? "" : "s"}`;
    const phrase = scope === "all" ? `${n} active ${noun}` : `${n} ${noun} due or overdue`;
    return `You have ${phrase}: ${top.join("; ")}.${more}`;
  },

  add_event: async (args) => {
    const title = (args.title || "").trim();
    if (!title) return "What should I call the event?";
    // Resolve the spoken date/time server-side (no LLM date guessing).
    const { date, time } = resolveWhen(args.when || args.date || "");
    if (!date) return "I couldn't pin down the date. Try saying it like 'next Friday at 4pm' or 'June 6th at noon'.";
    try {
      const r = await caldavAddEvent(title, date, time, args.duration_mins || 60);
      if (!r) return "Sorry, I couldn't reach your calendar.";
      // Speak the resolved date back so Shawn can confirm it's right.
      // Parse as UTC + display in UTC so the YYYY-MM-DD never shifts a day.
      const spoken = new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
      return `Added "${title}" on ${spoken}${time ? ` at ${time}` : ""}.`;
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
