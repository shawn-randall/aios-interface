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
  if (labels && labels.length) body.labels = labels;
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
  for (const m of matches) { if (await tdClose(m.id)) done++; }
  if (done === 0) return { ok: false, message: "I couldn't mark that complete." };
  const message = matches.length > 1
    ? `There were ${matches.length} tasks matching that — I marked all ${done} complete.`
    : `Marked "${matches[0].content}" complete.`;
  return { ok: true, data: { completed: done }, message };
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

  const timeStr = time || "12:00";
  const fmtLocal = (d, t) => { const [y, m, dy] = d.split("-"); const [h, mn] = t.split(":"); return `${y}${m}${dy}T${h}${mn}00`; };
  const [sh, sm] = timeStr.split(":").map(Number);
  const tot = sh * 60 + sm + duration_mins;
  const endTime = `${pad(Math.floor(tot / 60) % 24)}:${pad(tot % 60)}`;
  const uid = `aios-${Date.now()}@shawn`;
  const nowUtc = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const vcal = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AIOS//EN", "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${nowUtc}`,
    `DTSTART;TZID=America/New_York:${fmtLocal(date, timeStr)}`,
    `DTEND;TZID=America/New_York:${fmtLocal(date, endTime)}`,
    `SUMMARY:${title}`, "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  await c.createCalendarObject({ calendar: cal, filename: `${uid}.ics`, iCalString: vcal });

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

export async function leaveMessage({ name, number, topic } = {}) {
  const who = (name || "").trim() || "Someone";
  const re = (topic || "").trim();
  const back = (number || "").trim();
  const content = `📞 Message from ${who}${back ? ` (${back})` : ""}${re ? `: ${re}` : ""}`;
  const r = await addTask({ content, labels: ["aios"] });
  return r.ok
    ? { ok: true, data: r.data, message: `Got it — I'll let Shawn know${re ? ` about ${re}` : ""}. Anything else?` }
    : { ok: false, message: "I had trouble saving that message. Could you try again in a moment?" };
}

export async function requestCallback({ name, number } = {}) {
  const who = (name || "").trim() || "a caller";
  const back = (number || "").trim();
  if (!back) return { ok: false, message: "What's the best number for Shawn to call you back on?" };
  const r = await addTask({ content: `📞 Call ${who} back at ${back}`, labels: ["aios"] });
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
