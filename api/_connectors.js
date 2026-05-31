// ── AIOS Connectors — the shared capability layer ──────────────────────────
//
// THE single source of truth for what the AIOS can DO. One real implementation
// of each capability, agnostic to how it's invoked. Every channel adapter
// (web chat → v2.js, voice → vapi-tools.js, SMS → sms.js) imports from here.
//
// Principle (references/architecture-principles.md): improve a capability once,
// and every access point gets it automatically. Channels translate format and
// formatting; the real work lives here.
//
// Each capability returns a structured result:
//   { ok: boolean, message: string, data?: any }
// - `message` is a clean, human/voice-friendly line a channel can speak or show.
// - `data` is the structured result for channels that want to format their own.

import { DAVClient } from "tsdav";
import * as chrono from "chrono-node";
import nodemailer from "nodemailer";

// ── Env / config ────────────────────────────────────────────────────────────
const TODOIST_TOKEN = process.env.TODOIST_API_TOKEN;
const TODOIST_BASE = "https://api.todoist.com/api/v1";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = "shawn-randall/AIS-OS";
const APPLE_ID = process.env.APPLE_ID;
const APPLE_APP_PASSWORD = process.env.APPLE_APP_PASSWORD;
const CALENDAR_TZ = "America/New_York";

// Email accounts — one config used by every channel.
export const EMAIL_ACCOUNTS = {
  icloud: {
    label: "iCloud (symphonics@mac.com)", address: "symphonics@mac.com",
    imap: { host: "imap.mail.me.com", port: 993, tls: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    user: APPLE_ID, pass: APPLE_APP_PASSWORD, sentFolder: "Sent Messages",
  },
  sar372: {
    label: "Gmail (sar372@gmail.com)", address: process.env.GMAIL_1_ADDRESS || "sar372@gmail.com",
    imap: { host: "imap.gmail.com", port: 993, tls: true },
    smtp: { host: "smtp.gmail.com", port: 587, secure: false },
    user: process.env.GMAIL_1_ADDRESS, pass: process.env.GMAIL_1_PASSWORD, sentFolder: "[Gmail]/Sent Mail",
  },
  shawnalfred: {
    label: "Gmail (shawnalfredrandall@gmail.com)", address: process.env.GMAIL_2_ADDRESS || "shawnalfredrandall@gmail.com",
    imap: { host: "imap.gmail.com", port: 993, tls: true },
    smtp: { host: "smtp.gmail.com", port: 587, secure: false },
    user: process.env.GMAIL_2_ADDRESS, pass: process.env.GMAIL_2_PASSWORD, sentFolder: "[Gmail]/Sent Mail",
  },
};

const pad = (n) => String(n).padStart(2, "0");

// ── Todoist primitives ──────────────────────────────────────────────────────
async function tdGet(path, params = {}) {
  const url = new URL(`${TODOIST_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TODOIST_TOKEN}` } });
  if (!res.ok) return null;
  return res.json();
}
async function tdPost(path, body = {}) {
  const res = await fetch(`${TODOIST_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TODOIST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return res.json();
}
// Close returns 204 No Content — check res.ok, don't parse JSON.
async function tdClose(id) {
  const res = await fetch(`${TODOIST_BASE}/tasks/${id}/close`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TODOIST_TOKEN}` },
  });
  return res.ok;
}

// ── Date resolution (shared) ────────────────────────────────────────────────
// Resolve a spoken/typed phrase ("next Friday at 4pm", "Wednesday the 3rd",
// "June 6th at noon") to { date: 'YYYY-MM-DD', time: 'HH:MM' | null } using the
// real current date in NY. chrono-node primary; never trust an LLM to do dates.
export function resolveWhen(phrase) {
  if (!phrase) return { date: null, time: null };
  try {
    const ref = new Date(new Date().toLocaleString("en-US", { timeZone: CALENDAR_TZ }));
    const results = chrono.parse(phrase, ref, { forwardDate: true });
    if (results && results.length) {
      const s = results[0].start;
      const y = s.get("year"), mo = s.get("month"), d = s.get("day");
      if (y && mo && d) {
        let time = null;
        if (s.isCertain("hour")) time = `${pad(s.get("hour"))}:${pad(s.get("minute") || 0)}`;
        return { date: `${y}-${pad(mo)}-${pad(d)}`, time };
      }
    }
  } catch (_) { /* ignore, treat as unresolved */ }
  return { date: null, time: null };
}

// ── CalDAV (iCloud) primitives ──────────────────────────────────────────────
async function caldavClient() {
  const c = new DAVClient({
    serverUrl: "https://caldav.icloud.com",
    credentials: { username: APPLE_ID, password: APPLE_APP_PASSWORD },
    authMethod: "Basic", defaultAccountType: "caldav",
  });
  await c.login();
  return c;
}
function pickCalendar(calendars, calendarName) {
  if (calendarName) {
    const q = calendarName.toLowerCase().trim();
    const found = calendars.find((c) => (c.displayName || "").toLowerCase().includes(q));
    if (found) return found;
    return null; // signal not-found
  }
  const PREFERRED = ["home", "personal", "calendar"];
  return calendars.find((c) => PREFERRED.some((p) => (c.displayName || "").toLowerCase().includes(p)))
    || calendars.find((c) => !(c.displayName || "").toLowerCase().includes("ensemble"))
    || calendars[0];
}

// ── CAPABILITIES ────────────────────────────────────────────────────────────

export async function addTask({ content, due_string, priority, labels } = {}) {
  content = (content || "").trim();
  if (!content) return { ok: false, message: "What should the task say?" };
  const body = { content };
  if (due_string) body.due_string = due_string;
  if (priority) body.priority = priority;
  if (labels && labels.length) {
    // Apply REAL Todoist labels (strip a leading "@" if the model included it,
    // e.g. "@aios" → "aios"). This is the proper flag, not text in the title.
    const clean = labels.map((l) => String(l).replace(/^@+/, "").trim()).filter(Boolean);
    if (clean.length) body.labels = clean;
  }
  const task = await tdPost("/tasks", body);
  if (!task) return { ok: false, message: "I couldn't add that task — a problem reaching Todoist." };
  return { ok: true, data: task, message: `Added "${task.content}"${task.due ? ` due ${task.due.string}` : ""}.` };
}

export async function listTasks({ scope = "today" } = {}) {
  const data = await tdGet("/tasks");
  if (!data) return { ok: false, message: "I couldn't reach your task list." };
  let tasks = data.results ?? data;
  scope = (scope || "today").toLowerCase();
  if (scope !== "all") {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: CALENDAR_TZ });
    tasks = tasks.filter((t) => t.due && t.due.date && t.due.date <= today);
  }
  if (!tasks.length) {
    return { ok: true, data: [], message: scope === "all" ? "You have no active tasks. You're clear." : "Nothing due today or overdue. You're all caught up." };
  }
  const top = tasks.slice(0, 8).map((t) => t.content + (t.due ? ` (due ${t.due.string})` : ""));
  const more = tasks.length > 8 ? ` Plus ${tasks.length - 8} more.` : "";
  const noun = `task${tasks.length === 1 ? "" : "s"}`;
  const phrase = scope === "all" ? `${tasks.length} active ${noun}` : `${tasks.length} ${noun} due or overdue`;
  return { ok: true, data: tasks, message: `You have ${phrase}: ${top.join("; ")}.${more}` };
}

export async function completeTask({ task_name } = {}) {
  const q = (task_name || "").toLowerCase().trim();
  if (!q) return { ok: false, message: "Which task should I mark done?" };
  const data = await tdGet("/tasks");
  if (!data) return { ok: false, message: "I couldn't reach your task list." };
  const tasks = data.results ?? data;
  let matches = tasks.filter((t) => t.content.toLowerCase().includes(q));
  if (!matches.length) {
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    const m = tasks.find((t) => words.some((w) => t.content.toLowerCase().includes(w)));
    if (m) matches = [m];
  }
  if (!matches.length) return { ok: false, message: `I couldn't find a task matching "${task_name}".` };
  let done = 0;
  for (const m of matches) {
    if (await tdClose(m.id)) {
      done++;
      // Record AIOS-handled @aios items so the morning brief can report them.
      if ((m.labels || []).includes("aios")) await logAiosActivity(`Completed: ${m.content}`);
    }
  }
  if (done === 0) return { ok: false, message: "I couldn't mark that complete." };
  const message = matches.length > 1
    ? `There were ${matches.length} tasks matching that — I marked all ${done} complete.`
    : `Marked "${matches[0].content}" complete.`;
  return { ok: true, data: { completed: done }, message };
}

// ── Calendar helpers (shared by add / move / delete) ─────────────────────────
// Single source for building an event, so add and move produce identical events.
function buildVEvent({ title, date, time, durationMins = 60, allDay = false }) {
  const uid = `aios-${Date.now()}-${Math.floor(Math.random() * 1e4)}@shawn`;
  const nowUtc = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const head = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AIOS//EN", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${nowUtc}`];
  let body;
  if (allDay) {
    const [y, m, dy] = date.split("-");
    const nd = new Date(date + "T00:00:00Z"); nd.setUTCDate(nd.getUTCDate() + 1);
    const dend = `${nd.getUTCFullYear()}${pad(nd.getUTCMonth() + 1)}${pad(nd.getUTCDate())}`;
    body = [`DTSTART;VALUE=DATE:${y}${m}${dy}`, `DTEND;VALUE=DATE:${dend}`];
  } else {
    const timeStr = time || "12:00";
    const fmtLocal = (d, t) => { const [y, m, dy] = d.split("-"); const [h, mn] = t.split(":"); return `${y}${m}${dy}T${h}${mn}00`; };
    const [sh, sm] = timeStr.split(":").map(Number);
    const tot = sh * 60 + sm + durationMins;
    const endTime = `${pad(Math.floor(tot / 60) % 24)}:${pad(tot % 60)}`;
    body = [`DTSTART;TZID=America/New_York:${fmtLocal(date, timeStr)}`, `DTEND;TZID=America/New_York:${fmtLocal(date, endTime)}`];
  }
  const iCalString = [...head, ...body, `SUMMARY:${title}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  return { uid, iCalString };
}

// Parse a spoken date/time phrase, reporting whether a DATE and/or TIME were
// actually specified — so a move keeps the original date when only the time
// changes (and vice-versa).
function parseWhenParts(phrase) {
  try {
    const ref = new Date(new Date().toLocaleString("en-US", { timeZone: CALENDAR_TZ }));
    const r = chrono.parse(phrase || "", ref, { forwardDate: true });
    if (!r || !r.length) return { date: null, time: null, hasDate: false, hasTime: false };
    const s = r[0].start;
    const hasDate = s.isCertain("day") || s.isCertain("month") || s.isCertain("weekday");
    const hasTime = s.isCertain("hour");
    const y = s.get("year"), mo = s.get("month"), d = s.get("day");
    const date = (y && mo && d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
    const time = hasTime ? `${pad(s.get("hour"))}:${pad(s.get("minute") || 0)}` : null;
    return { date, time, hasDate, hasTime };
  } catch (_) {
    return { date: null, time: null, hasDate: false, hasTime: false };
  }
}

// Extract start/end + duration from an event's iCal data.
function eventTimes(data) {
  data = (data || "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const parse = (s) => {
    const m = (s || "").replace(/\s/g, "").match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
    if (!m) return null;
    const [, y, mo, d, h, mi] = m;
    return { date: `${y}-${mo}-${d}`, time: h ? `${h}:${mi}` : null };
  };
  const s = parse((data.match(/DTSTART[^:]*:(.*)/) || [])[1]);
  const e = parse((data.match(/DTEND[^:]*:(.*)/) || [])[1]);
  let durMins = 60;
  if (s && e && s.time && e.time) {
    const [sh, sm] = s.time.split(":").map(Number);
    const [eh, em] = e.time.split(":").map(Number);
    durMins = eh * 60 + em - (sh * 60 + sm);
    if (durMins <= 0) durMins = 60;
  }
  return { start: s, end: e, durMins, allDay: !(s && s.time) };
}

// Find events matching a title across all event calendars. Optional dayPhrase
// narrows to a specific day. Carries the CalDAV object so callers can delete/move.
async function findEvents(c, title, dayPhrase) {
  const calendars = await c.fetchCalendars();
  const eventCals = calendars.filter((cal) => {
    const comps = (cal.components || []).map((x) => String(x).toUpperCase());
    return comps.length === 0 || comps.includes("VEVENT");
  });
  const start = new Date(Date.now() - 7 * 864e5);
  const end = new Date(Date.now() + 120 * 864e5);
  const q = (title || "").toLowerCase();
  const wantDate = dayPhrase ? resolveWhen(dayPhrase).date : null;
  const matches = [];
  for (const cal of eventCals) {
    try {
      const objs = await c.fetchCalendarObjects({ calendar: cal, timeRange: { start: start.toISOString(), end: end.toISOString() } });
      for (const o of objs) {
        const data = (o.data || "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
        let summary = (data.match(/SUMMARY:(.*)/) || [])[1]?.trim() || "";
        summary = summary.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").replace(/\\\\/g, "\\");
        if (!summary.toLowerCase().includes(q)) continue;
        const dt = (data.match(/DTSTART[^:]*:(.*)/) || [])[1]?.trim() || "";
        const m = dt.replace(/\s/g, "").match(/(\d{4})(\d{2})(\d{2})/);
        const isoDate = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
        const label = isoDate ? new Date(isoDate + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }) : "";
        matches.push({ obj: o, data, summary, isoDate, label, cal: cal.displayName });
      }
    } catch (_) {}
  }
  let scoped = wantDate ? matches.filter((x) => x.isoDate === wantDate) : matches;
  if (!scoped.length) scoped = matches;
  return scoped;
}

export async function addEvent({ title, when, calendar_name, duration_mins = 60 } = {}) {
  title = (title || "").trim();
  if (!title) return { ok: false, message: "What should I call the event?" };
  const { date, time } = resolveWhen(when || "");
  if (!date) return { ok: false, message: "I couldn't pin down the date. Try 'next Friday at 4pm' or 'June 6th at noon'." };

  const c = await caldavClient();
  const calendars = await c.fetchCalendars();
  if (!calendars.length) return { ok: false, message: "I couldn't reach your calendar." };
  const cal = pickCalendar(calendars, calendar_name);
  if (!cal) {
    const names = calendars.map((x) => x.displayName).filter(Boolean).join(", ");
    return { ok: false, message: `I couldn't find a calendar called "${calendar_name}". Your calendars: ${names}. Which one?` };
  }

  const { uid, iCalString } = buildVEvent({ title, date, time, durationMins: duration_mins });
  await c.createCalendarObject({ calendar: cal, filename: `${uid}.ics`, iCalString });

  const spoken = new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  return { ok: true, data: { date, time, calendar: cal.displayName }, message: `Added "${title}" on ${spoken}${time ? ` at ${time}` : ""}, to your ${cal.displayName || "default"} calendar.` };
}

export async function listEvents({ days = 7 } = {}) {
  const c = await caldavClient();
  const calendars = await c.fetchCalendars();
  const now = new Date();
  const end = new Date(now.getTime() + days * 864e5);
  const events = [];
  // Read EVERY iCloud calendar that holds events (Home, Music, Acting, etc.) —
  // not just the first few. Skip task-only calendars (VTODO/Reminders). The
  // CalDAV connection is iCloud-only, so Gmail calendars are excluded already.
  const eventCals = calendars.filter((cal) => {
    const comps = (cal.components || []).map((x) => String(x).toUpperCase());
    return comps.length === 0 || comps.includes("VEVENT");
  });
  for (const cal of eventCals) {
    try {
      const objs = await c.fetchCalendarObjects({ calendar: cal, timeRange: { start: now.toISOString(), end: end.toISOString() } });
      for (const o of objs) {
        const data = (o.data || "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
        let summary = (data.match(/SUMMARY:(.*)/) || [])[1]?.trim() || "Event";
        summary = summary.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").replace(/\\\\/g, "\\");
        const dt = (data.match(/DTSTART[^:]*:(.*)/) || [])[1]?.trim() || "";
        const m = dt.replace(/\s/g, "").match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
        if (!m) continue;
        const [, y, mo, d, h, mi] = m;
        const ts = new Date(`${y}-${mo}-${d}T${h || "00"}:${mi || "00"}:00`).getTime();
        const dayName = new Date(`${y}-${mo}-${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
        const timeLabel = h ? ` at ${((+h % 12) || 12)}${mi && mi !== "00" ? ":" + mi : ""}${+h >= 12 ? "pm" : "am"}` : "";
        events.push({ ts, summary, label: dayName + timeLabel });
      }
    } catch (_) {}
  }
  events.sort((a, b) => a.ts - b.ts);
  if (!events.length) return { ok: true, data: [], message: `Nothing on your calendar in the next ${days} days.` };
  const top = events.slice(0, 8).map((e) => `${e.summary} on ${e.label}`);
  const more = events.length > 8 ? ` Plus ${events.length - 8} more.` : "";
  return { ok: true, data: events, message: `You have ${events.length} event${events.length === 1 ? "" : "s"} coming up: ${top.join("; ")}.${more}` };
}

export async function deleteEvent({ title, when } = {}) {
  title = (title || "").trim();
  if (!title) return { ok: false, message: "Which event should I remove?" };
  const c = await caldavClient();
  const scoped = await findEvents(c, title, when);
  if (!scoped.length) return { ok: false, message: `I couldn't find an event matching "${title}".` };
  if (scoped.length > 1) {
    const list = scoped.slice(0, 5).map((x) => `${x.summary} on ${x.label}`).join("; ");
    return { ok: false, message: `I found ${scoped.length} events matching that: ${list}. Which day's should I remove?`, data: scoped.map((x) => ({ summary: x.summary, label: x.label })) };
  }
  const t = scoped[0];
  await c.deleteCalendarObject({ calendarObject: t.obj });
  return { ok: true, data: { summary: t.summary, date: t.isoDate, calendar: t.cal }, message: `Removed "${t.summary}"${t.label ? ` on ${t.label}` : ""} from your ${t.cal} calendar.` };
}

// Move/reschedule an event. CRITICAL: preserves the event's original calendar,
// time, and duration — only what Shawn names changes. Say a new time → keeps the
// date; say a new day → keeps the time; say a calendar → moves it (otherwise it
// stays put). The delete-old/create-new is an implementation detail, never
// surfaced to the user.
export async function moveEvent({ title, when, from_when, calendar_name } = {}) {
  title = (title || "").trim();
  if (!title) return { ok: false, message: "Which event should I move?" };
  if (!when || !when.trim()) return { ok: false, message: "When should I move it to?" };
  const c = await caldavClient();
  const scoped = await findEvents(c, title, from_when);
  if (!scoped.length) return { ok: false, message: `I couldn't find an event matching "${title}".` };
  if (scoped.length > 1) {
    const list = scoped.slice(0, 5).map((x) => `${x.summary} on ${x.label}`).join("; ");
    return { ok: false, message: `I found ${scoped.length} events matching that: ${list}. Which day's should I move?` };
  }
  const ev = scoped[0];
  const orig = eventTimes(ev.data);
  const parts = parseWhenParts(when);
  if (!parts.hasDate && !parts.hasTime) return { ok: false, message: "What day or time should I move it to?" };

  // Keep what wasn't named: original date if only a time was given, and vice-versa.
  const newDate = parts.hasDate && parts.date ? parts.date : (orig.start && orig.start.date);
  if (!newDate) return { ok: false, message: "I couldn't work out the new date for that event." };
  const newTime = parts.hasTime && parts.time ? parts.time : (orig.start && orig.start.time);
  const keepAllDay = orig.allDay && !parts.hasTime;

  // Preserve the original calendar unless explicitly asked to change it.
  const calendars = await c.fetchCalendars();
  let targetCal = calendars.find((x) => x.displayName === ev.cal);
  if (calendar_name) {
    const picked = pickCalendar(calendars, calendar_name);
    if (!picked) {
      const names = calendars.map((x) => x.displayName).filter(Boolean).join(", ");
      return { ok: false, message: `I couldn't find a calendar called "${calendar_name}". Your calendars: ${names}.` };
    }
    targetCal = picked;
  }
  if (!targetCal) targetCal = pickCalendar(calendars, ev.cal) || calendars[0];

  // Create the moved event FIRST, then remove the original — so a failure can
  // never lose the event (worst case is a duplicate, which is recoverable).
  const { uid, iCalString } = buildVEvent({ title: ev.summary, date: newDate, time: newTime, durationMins: orig.durMins || 60, allDay: keepAllDay });
  await c.createCalendarObject({ calendar: targetCal, filename: `${uid}.ics`, iCalString });
  await c.deleteCalendarObject({ calendarObject: ev.obj });

  const spoken = new Date(newDate + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  let pretty = "";
  if (!keepAllDay && newTime) {
    const [h, mn] = newTime.split(":");
    pretty = ` at ${((+h % 12) || 12)}${mn !== "00" ? ":" + mn : ""}${+h >= 12 ? "pm" : "am"}`;
  }
  return { ok: true, data: { date: newDate, time: newTime, calendar: targetCal.displayName }, message: `Moved "${ev.summary}" to ${spoken}${pretty}, on your ${targetCal.displayName} calendar.` };
}

export async function listCalendars() {
  const c = await caldavClient();
  const calendars = await c.fetchCalendars();
  // Only event calendars (skip VTODO/Reminders). iCloud-only, so no Gmail cals.
  const names = calendars
    .filter((cal) => {
      const comps = (cal.components || []).map((x) => String(x).toUpperCase());
      return comps.length === 0 || comps.includes("VEVENT");
    })
    .map((cal) => cal.displayName)
    .filter(Boolean);
  if (!names.length) return { ok: true, data: [], message: "I couldn't find any calendars." };
  return { ok: true, data: names, message: `You have ${names.length} calendars: ${names.join(", ")}.` };
}

export async function saveNote({ note } = {}) {
  note = (note || "").trim();
  if (!note) return { ok: false, message: "What should I note down?" };
  const path = "context/voice-notes.md";
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const headers = { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" };
  let existing = "# Voice Notes\n\nQuick notes captured by voice.\n", sha;
  const meta = await fetch(url, { headers });
  if (meta.ok) { const j = await meta.json(); sha = j.sha; existing = Buffer.from(j.content, "base64").toString("utf8"); }
  const stamp = new Date().toLocaleString("en-US", { timeZone: CALENDAR_TZ });
  const updated = existing.replace(/\s*$/, "") + `\n- [${stamp}] ${note}\n`;
  const body = { message: "Note (via AIOS)", content: Buffer.from(updated).toString("base64") };
  if (sha) body.sha = sha;
  const res = await fetch(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.ok ? { ok: true, message: "Saved to your AIOS notes." } : { ok: false, message: "I couldn't save that note." };
}

// ── AIOS activity log ────────────────────────────────────────────────────────
// Records what the AIOS handled (e.g. closing an @aios task) to a GitHub file so
// the morning brief can report "here's what I took care of." Exported so any
// channel/session can log a handled item. Never throws — logging must not break
// the action it records.
export async function logAiosActivity(text) {
  try {
    if (!GITHUB_TOKEN || !text) return;
    const path = "context/aios-activity.md";
    const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
    const headers = { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" };
    let existing = "# AIOS Activity Log\n\nWhat the AIOS has handled. The morning brief reads recent entries.\n", sha;
    const meta = await fetch(url, { headers });
    if (meta.ok) { const j = await meta.json(); sha = j.sha; existing = Buffer.from(j.content, "base64").toString("utf8"); }
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: CALENDAR_TZ }));
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const updated = existing.replace(/\s*$/, "") + `\n- [${stamp}] ${text}\n`;
    const body = { message: "AIOS activity", content: Buffer.from(updated).toString("base64") };
    if (sha) body.sha = sha;
    await fetch(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (_) { /* never break the action */ }
}

// ── Email ───────────────────────────────────────────────────────────────────

export async function readEmail({ account, count = 5 } = {}) {
  const config = EMAIL_ACCOUNTS[account];
  if (!config) return { ok: false, message: `Unknown account: ${account}. Options: icloud, sar372, shawnalfred.` };
  if (!config.user || !config.pass) return { ok: false, message: `Credentials not set for ${account}.` };
  const imapMod = await import("imap-simple");
  const imapSimple = imapMod.default || imapMod;
  const n = Math.min(count, 10);
  let connection;
  try {
    connection = await imapSimple.connect({
      imap: {
        host: config.imap.host, port: config.imap.port, tls: config.imap.tls,
        tlsOptions: { rejectUnauthorized: false },
        user: config.user, password: config.pass, authTimeout: 8000, connTimeout: 8000,
      },
    });
    await connection.openBox("INBOX");
    const results = await connection.search(["ALL"], { bodies: ["HEADER.FIELDS (FROM SUBJECT DATE)"], struct: false });
    const recent = results.slice(-n).reverse();
    const items = recent.map((item) => {
      const p = item.parts[0];
      return { from: p?.body?.from?.[0] || "?", subject: p?.body?.subject?.[0] || "(no subject)", date: p?.body?.date?.[0] || "?" };
    });
    connection.end();
    if (!items.length) return { ok: true, data: [], message: "Inbox empty." };
    const lines = items.map((e) => `Subject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}`);
    return { ok: true, data: items, message: `${config.label} — ${items.length} recent:\n\n${lines.join("\n\n---\n\n")}` };
  } catch (err) {
    if (connection) try { connection.end(); } catch (_) {}
    return { ok: false, message: `Email read failed (${account}): ${err.message}` };
  }
}

// Send guardrail (enforced at the connector — applies to EVERY channel):
// all of to/subject/body must be present. Channels/prompts still draft-and-confirm first.
export async function sendEmail({ to, subject, body, from_account } = {}) {
  if (!to || !to.trim()) return { ok: false, message: "SEND_BLOCKED: No recipient. Ask Shawn who to send to." };
  if (!subject || !subject.trim()) return { ok: false, message: "SEND_BLOCKED: No subject line. Ask Shawn for a subject." };
  if (!body || !body.trim()) return { ok: false, message: "SEND_BLOCKED: No body. Draft the email content first." };
  const config = EMAIL_ACCOUNTS[from_account || "shawnalfred"];
  if (!config || !config.user || !config.pass) return { ok: false, message: "Email credentials not set." };
  try {
    const transporter = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: { user: config.user, pass: config.pass },
    });
    await transporter.sendMail({ from: `Shawn Randall <${config.address}>`, to, subject, text: body });
    return { ok: true, message: `Sent to ${to} from ${config.address}.` };
  } catch (err) {
    return { ok: false, message: `Send failed: ${err.message}` };
  }
}

// ── Guest / receptionist capabilities ───────────────────────────────────────
// What an UNKNOWN caller is allowed to do. None of these direct the AIOS — they
// only deposit something for Shawn to see/approve later. Each lands in Todoist
// tagged `@aios` so it surfaces in the morning brief. Gating lives in _roles.js;
// these just do the deposit. Reuses addTask so improvements propagate everywhere.

// Pre-approved info a guest may hear. PUBLIC only — never private data. Override
// via env (PUBLIC_BOOKING_INFO) without a redeploy.
const PUBLIC_INFO = process.env.PUBLIC_BOOKING_INFO
  || "For booking and inquiries, email shawnalfredrandall@gmail.com and Shawn will get back to you.";

// `caller_id` is the real caller's number (from caller ID), injected by the
// channel — so we always record a number, even if the caller never says one.
export async function leaveMessage({ name, number, topic, caller_id } = {}) {
  const who = (name || "").trim() || "Someone";
  const re = (topic || "").trim();
  const stated = (number || "").trim();
  const cid = (caller_id || "").trim();
  const back = stated || cid;
  const tag = back ? ` (${back}${!stated && cid ? ", caller ID" : ""})` : "";
  const content = `📞 Message from ${who}${tag}${re ? `: ${re}` : ""}`;
  const r = await addTask({ content, labels: ["aios"] });
  return r.ok
    ? { ok: true, data: r.data, message: `Got it — I'll let Shawn know${re ? ` about ${re}` : ""}. Anything else?` }
    : { ok: false, message: "I had trouble saving that message. Could you try again in a moment?" };
}

export async function requestCallback({ name, number, caller_id } = {}) {
  const who = (name || "").trim() || "a caller";
  const stated = (number || "").trim();
  const cid = (caller_id || "").trim();
  const back = stated || cid;
  if (!back) return { ok: false, message: "What's the best number for Shawn to call you back on?" };
  const tag = !stated && cid ? " (caller ID)" : "";
  const r = await addTask({ content: `📞 Call ${who} back at ${back}${tag}`, labels: ["aios"] });
  return r.ok
    ? { ok: true, data: r.data, message: `Done — I've asked Shawn to call ${who} back at ${back}.` }
    : { ok: false, message: "I couldn't log that callback. Mind trying again?" };
}

// Creates a PENDING request, NOT a real calendar event. Shawn approves later.
export async function requestCalendarHold({ name, when, topic } = {}) {
  const who = (name || "").trim() || "Someone";
  const re = (topic || "").trim();
  const { date } = resolveWhen(when || "");
  const whenLabel = date
    ? new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })
    : (when || "").trim() || "a time to be confirmed";
  const content = `🗓️ PENDING: ${who} requests ${whenLabel}${re ? ` — ${re}` : ""}`;
  const r = await addTask({ content, labels: ["aios"] });
  return r.ok
    ? { ok: true, data: r.data, message: `I've put in a request for ${whenLabel} and flagged it for Shawn to confirm. He'll reach out if it works.` }
    : { ok: false, message: "I couldn't log that request. Could you try again?" };
}

export async function publicInfo() {
  return { ok: true, data: { info: PUBLIC_INFO }, message: PUBLIC_INFO };
}
