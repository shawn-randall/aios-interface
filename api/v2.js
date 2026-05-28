import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import { DAVClient } from "tsdav";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REPO = "shawn-randall/AIS-OS";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TODOIST_TOKEN = process.env.TODOIST_API_TOKEN;
const TODOIST_BASE = "https://api.todoist.com/api/v1";

// --- Email account configs ---

const EMAIL_ACCOUNTS = {
  icloud: {
    label: "iCloud (symphonics@mac.com)",
    address: "symphonics@mac.com",
    imap: { host: "imap.mail.me.com", port: 993, tls: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    user: process.env.APPLE_ID,
    pass: process.env.APPLE_APP_PASSWORD,
    sentFolder: "Sent Messages",
  },
  sar372: {
    label: "Gmail (sar372@gmail.com)",
    address: process.env.GMAIL_1_ADDRESS || "sar372@gmail.com",
    imap: { host: "imap.gmail.com", port: 993, tls: true },
    smtp: { host: "smtp.gmail.com", port: 587, secure: false },
    user: process.env.GMAIL_1_ADDRESS,
    pass: process.env.GMAIL_1_PASSWORD,
    sentFolder: "[Gmail]/Sent Mail",
  },
  shawnalfred: {
    label: "Gmail (shawnalfredrandall@gmail.com)",
    address: process.env.GMAIL_2_ADDRESS || "shawnalfredrandall@gmail.com",
    imap: { host: "imap.gmail.com", port: 993, tls: true },
    smtp: { host: "smtp.gmail.com", port: 587, secure: false },
    user: process.env.GMAIL_2_ADDRESS,
    pass: process.env.GMAIL_2_PASSWORD,
    sentFolder: "[Gmail]/Sent Mail",
  },
};

// --- GitHub helpers ---

async function fetchContext(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3.raw",
    },
  });
  if (!res.ok) return `[${path} not found]`;
  return await res.text();
}

async function writeContext(path, content, commitMessage) {
  const metaRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  const body = {
    message: commitMessage,
    content: Buffer.from(content).toString("base64"),
  };
  if (metaRes.ok) {
    const meta = await metaRes.json();
    body.sha = meta.sha;
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}

// --- Todoist helpers ---

async function todoistGet(path, params = {}) {
  const url = new URL(`${TODOIST_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TODOIST_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
}

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

// --- Email helpers ---

async function readEmail(account, count = 5) {
  const config = EMAIL_ACCOUNTS[account];
  if (!config) return `Unknown account: ${account}. Valid options: icloud, sar372, shawnalfred`;
  if (!config.user || !config.pass) return `Credentials not set for ${account}. Add env vars to Vercel: ${account === "icloud" ? "APPLE_ID, APPLE_APP_PASSWORD" : account === "sar372" ? "GMAIL_1_ADDRESS, GMAIL_1_PASSWORD" : "GMAIL_2_ADDRESS, GMAIL_2_PASSWORD"}`;

  const imapMod = await import("imap-simple");
  const imapSimple = imapMod.default || imapMod;

  const n = Math.min(count, 10);
  let connection;
  try {
    connection = await imapSimple.connect({
      imap: {
        host: config.imap.host,
        port: config.imap.port,
        tls: config.imap.tls,
        tlsOptions: { rejectUnauthorized: false },
        user: config.user,
        password: config.pass,
        authTimeout: 8000,
        connTimeout: 8000,
      },
    });

    await connection.openBox("INBOX");
    const results = await connection.search(["ALL"], {
      bodies: ["HEADER.FIELDS (FROM SUBJECT DATE)"],
      struct: false,
    });

    const recent = results.slice(-n).reverse();
    const lines = recent.map((item) => {
      const part = item.parts[0];
      const from = part?.body?.from?.[0] || "?";
      const subject = part?.body?.subject?.[0] || "(no subject)";
      const date = part?.body?.date?.[0] || "?";
      return `Subject: ${subject}\nFrom: ${from}\nDate: ${date}`;
    });

    connection.end();
    return lines.length
      ? `${config.label} — ${lines.length} recent:\n\n${lines.join("\n\n---\n\n")}`
      : "Inbox empty.";
  } catch (err) {
    if (connection) try { connection.end(); } catch (_) {}
    return `Email read failed (${account}): ${err.message}`;
  }
}

async function sendEmail(to, subject, body, fromAccount) {
  const config = EMAIL_ACCOUNTS[fromAccount || "shawnalfred"];
  if (!config.user || !config.pass) return `Credentials not set. Add email env vars to Vercel.`;

  try {
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.user, pass: config.pass },
    });

    await transporter.sendMail({
      from: `Shawn Randall <${config.address}>`,
      to,
      subject,
      text: body,
    });

    return `Sent to ${to} from ${config.address}.`;
  } catch (err) {
    return `Send failed: ${err.message}`;
  }
}

// --- Calendar helpers ---

function parseICalDate(dtstart) {
  const clean = dtstart.replace(/\s/g, "");
  const m = clean.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!m) return dtstart;
  const [, yr, mo, dy, hr, mn] = m;
  if (hr !== undefined) return `${mo}/${dy}/${yr} ${hr}:${mn}`;
  return `${mo}/${dy}/${yr}`;
}

function iCalDateToTs(dtstart) {
  const clean = dtstart.replace(/\s/g, "");
  const m = clean.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return 0;
  const [, yr, mo, dy, hr = "00", mn = "00", sc = "00"] = m;
  return new Date(`${yr}-${mo}-${dy}T${hr}:${mn}:${sc}Z`).getTime();
}

async function listEvents(days = 7) {
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_PASSWORD) {
    return "Calendar credentials not configured. Add APPLE_ID and APPLE_APP_PASSWORD to Vercel.";
  }

  try {
    const davClient = new DAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: {
        username: process.env.APPLE_ID,
        password: process.env.APPLE_APP_PASSWORD,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });

    await davClient.login();
    const calendars = await davClient.fetchCalendars();

    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const events = [];

    for (const cal of calendars.slice(0, 6)) {
      try {
        const objects = await davClient.fetchCalendarObjects({
          calendar: cal,
          timeRange: { start: now.toISOString(), end: end.toISOString() },
        });
        for (const obj of objects) {
          const data = obj.data || "";
          const summary = data.match(/SUMMARY:(.*)/)?.[1]?.trim() || "Event";
          const dtstart = data.match(/DTSTART[^:]*:(.*)/)?.[1]?.trim() || "";
          if (dtstart) {
            events.push({ summary, display: parseICalDate(dtstart), ts: iCalDateToTs(dtstart) });
          }
        }
      } catch (_) {}
    }

    events.sort((a, b) => a.ts - b.ts);

    if (!events.length) return `No events in the next ${days} days.`;
    return events.map((e) => `${e.display}  ${e.summary}`).join("\n");
  } catch (err) {
    return `Calendar fetch failed: ${err.message}`;
  }
}

async function addEvent(title, date, time, durationMins = 60) {
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_PASSWORD) {
    return "Calendar credentials not configured. Add APPLE_ID and APPLE_APP_PASSWORD to Vercel.";
  }

  try {
    const davClient = new DAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: {
        username: process.env.APPLE_ID,
        password: process.env.APPLE_APP_PASSWORD,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });

    await davClient.login();
    const calendars = await davClient.fetchCalendars();
    if (!calendars.length) return "No calendars found on iCloud account.";

    // Prefer a personal calendar over project/group calendars
    const PREFERRED = ["home", "personal", "calendar", "shawn"];
    const defaultCal = calendars.find((c) => {
      const name = (c.displayName || "").toLowerCase();
      return PREFERRED.some((p) => name.includes(p));
    }) || calendars.find((c) => !(c.displayName || "").toLowerCase().includes("ensemble")) || calendars[0];

    const timeStr = time || "12:00";
    // Use floating datetime (no Z) so iCloud displays in local time, not UTC
    const fmtLocal = (dateStr, timeStr) => {
      const [yr, mo, dy] = dateStr.split("-");
      const [hr, mn] = timeStr.split(":");
      return `${yr}${mo}${dy}T${hr}${mn}00`;
    };
    const [startHr, startMn] = timeStr.split(":").map(Number);
    const totalMins = startHr * 60 + startMn + durationMins;
    const endHr = String(Math.floor(totalMins / 60) % 24).padStart(2, "0");
    const endMn = String(totalMins % 60).padStart(2, "0");
    const endTimeStr = `${endHr}:${endMn}`;

    const uid = `aios-${Date.now()}@shawn`;
    const nowUtc = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";

    const vcal = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//AIOS//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${nowUtc}`,
      `DTSTART;TZID=America/New_York:${fmtLocal(date, timeStr)}`,
      `DTEND;TZID=America/New_York:${fmtLocal(date, endTimeStr)}`,
      `SUMMARY:${title}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    await davClient.createCalendarObject({
      calendar: defaultCal,
      filename: `${uid}.ics`,
      iCalString: vcal,
    });

    return `Added "${title}" on ${date} at ${timeStr} (${durationMins} min).`;
  } catch (err) {
    return `Calendar add failed: ${err.message}`;
  }
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "save_context",
    description: "Persist an update to the AIOS repo on GitHub. Use when Shawn asks to save, update, or log anything that should persist across sessions.",
    input_schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          enum: [
            "context/priorities.md",
            "decisions/log.md",
            "projects/ghost-notes.md",
            "projects/gmail-cleaner.md",
            "projects/sofi-referral.md",
            "projects/skool-community.md",
            "projects/problem-collection-app.md",
            "projects/aios-interface.md",
            "projects/josh-groban.md",
          ],
        },
        content: { type: "string", description: "Complete new file content" },
        commit_message: { type: "string" },
      },
      required: ["file", "content", "commit_message"],
    },
  },
  {
    name: "list_tasks",
    description: "List Shawn's active Todoist tasks. Optionally filter by a keyword or project name.",
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Todoist filter string, e.g. 'today', 'p1', 'Ghost Notes'. Leave empty for all active tasks.",
        },
      },
      required: [],
    },
  },
  {
    name: "add_task",
    description: "Add a new task to Todoist.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Task name" },
        due_string: {
          type: "string",
          description: "Due date in natural language, e.g. 'today', 'tomorrow', 'next Monday', 'June 10'. Omit if no due date.",
        },
        priority: {
          type: "integer",
          enum: [1, 2, 3, 4],
          description: "1 = normal, 2 = medium, 3 = high, 4 = urgent",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a Todoist task as complete by its ID.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID from list_tasks" },
        task_name: { type: "string", description: "Task name for confirmation message" },
      },
      required: ["task_id", "task_name"],
    },
  },
  {
    name: "read_email",
    description: "Read recent emails from one of Shawn's inboxes. Call this when he asks to check email, see what's new, or read messages.",
    input_schema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          enum: ["icloud", "sar372", "shawnalfred"],
          description: "icloud=symphonics@mac.com, sar372=sar372@gmail.com, shawnalfred=shawnalfredrandall@gmail.com. Default to shawnalfred if unspecified.",
        },
        count: {
          type: "integer",
          description: "How many recent emails to fetch (default 5, max 10).",
        },
      },
      required: ["account"],
    },
  },
  {
    name: "send_email",
    description: "Send an email from one of Shawn's accounts. Always confirm recipient and subject before sending unless Shawn explicitly provides both.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Full email body text" },
        from_account: {
          type: "string",
          enum: ["icloud", "sar372", "shawnalfred"],
          description: "Which account to send from. Default: shawnalfred.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "list_events",
    description: "List upcoming events from Shawn's iCloud calendar. Call this when he asks about his schedule, what's coming up, or what's on his calendar.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "How many days ahead to look (default 7).",
        },
      },
      required: [],
    },
  },
  {
    name: "add_event",
    description: "Add a new event to Shawn's iCloud calendar.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        time: { type: "string", description: "Start time in HH:MM (24-hour), e.g. '14:30'. Omit for all-day." },
        duration_mins: { type: "integer", description: "Duration in minutes (default 60)." },
      },
      required: ["title", "date"],
    },
  },
];

// --- Tool executor ---

async function executeTool(name, input, savedFiles) {
  if (name === "save_context") {
    const { file, content, commit_message } = input;
    const ok = await writeContext(file, content, `Phone: ${commit_message}`);
    if (ok) savedFiles.push(file);
    return ok ? `Saved ${file} to GitHub.` : `Failed to save ${file}.`;
  }

  if (name === "list_tasks") {
    const data = await todoistGet("/tasks", input.filter ? { filter: input.filter } : {});
    if (!data) return "Failed to fetch tasks.";
    const tasks = data.results ?? data;
    if (!tasks.length) return "No active tasks found.";
    return tasks
      .map((t) => `[${t.id}] ${t.content}${t.due ? ` (due ${t.due.string})` : ""}`)
      .join("\n");
  }

  if (name === "add_task") {
    const body = { content: input.content };
    if (input.due_string) body.due_string = input.due_string;
    if (input.priority) body.priority = input.priority;
    const task = await todoistPost("/tasks", body);
    if (!task) return "TODOIST_ERROR: Task was NOT added. The API call failed — token may be missing in Vercel. Tell the user: task was not added, there is a configuration issue.";
    return `TODOIST_SUCCESS: Task added with ID ${task.id}. Content: "${task.content}"${task.due ? ` due ${task.due.string}` : ""}.`;
  }

  if (name === "complete_task") {
    const res = await todoistPost(`/tasks/${input.task_id}/close`);
    return res !== null ? `Completed: "${input.task_name}"` : `Failed to complete task.`;
  }

  if (name === "read_email") {
    return await readEmail(input.account, input.count || 5);
  }

  if (name === "send_email") {
    return await sendEmail(input.to, input.subject, input.body, input.from_account);
  }

  if (name === "list_events") {
    return await listEvents(input.days || 7);
  }

  if (name === "add_event") {
    return await addEvent(input.title, input.date, input.time, input.duration_mins || 60);
  }

  return "Unknown tool.";
}

// --- Main handler ---

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "No message provided" });

  const [
    claudeMd, connections, priorities, aboutMe, aboutBusiness,
    decisionsLog, sessionLog, ghostNotes, gmailCleaner, sofiReferral,
    skoolCommunity, problemApp, aiosInterface, joshGroban,
  ] = await Promise.all([
    fetchContext("CLAUDE.md"),
    fetchContext("connections.md"),
    fetchContext("context/priorities.md"),
    fetchContext("context/about-me.md"),
    fetchContext("context/about-business.md"),
    fetchContext("decisions/log.md"),
    fetchContext("context/session-log.md"),
    fetchContext("projects/ghost-notes.md"),
    fetchContext("projects/gmail-cleaner.md"),
    fetchContext("projects/sofi-referral.md"),
    fetchContext("projects/skool-community.md"),
    fetchContext("projects/problem-collection-app.md"),
    fetchContext("projects/aios-interface.md"),
    fetchContext("projects/josh-groban.md"),
  ]);

  const staticPrompt = `## CRITICAL OPERATING INSTRUCTIONS

You are Shawn's AIOS running inside a Vercel serverless function.

You have exactly 8 tools available. Use ONLY these tool names — no others exist here:
1. add_task — add a Todoist task
2. list_tasks — fetch Todoist tasks
3. complete_task — mark a task done
4. save_context — save a file to GitHub
5. read_email — read recent emails from an inbox
6. send_email — send an email from Shawn's account
7. list_events — list upcoming calendar events
8. add_event — add an event to the calendar

NEVER output <tool_call> tags or code blocks. NEVER call mcp__* tools — they do not exist here.
NEVER run Python or bash scripts — they cannot execute here.
When Shawn asks to check email: call read_email immediately.
When Shawn asks about his schedule/calendar: call list_events immediately.
When Shawn asks to add a task: call add_task immediately.
When Shawn asks to send an email: call send_email (confirm recipient + subject first if not given).

---

${claudeMd}

---

## Connections (what you can reach)
${connections}

---

## About Shawn
${aboutMe}

---

## About the Business
${aboutBusiness}

---

## Current Priorities
${priorities}

---

## Decisions Log
${decisionsLog}

---

## Active Projects

### Ghost Notes From Brooklyn
${ghostNotes}

### Gmail Cleaner
${gmailCleaner}

### SoFi Referral
${sofiReferral}

### Skool Community
${skoolCommunity}

### Problem Collection App
${problemApp}

### AIOS Interface
${aiosInterface}

### Josh Groban Performances
${joshGroban}

---

You are Shawn's AIOS, running inside a Vercel serverless function. You cannot run scripts or terminal commands.

Email accounts: icloud=symphonics@mac.com, sar372=sar372@gmail.com, shawnalfred=shawnalfredrandall@gmail.com.
Calendar: iCloud (syncs with iPhone).

Keep responses concise — he's on his phone. Lead with action. No fluff.`;

  const dynamicPrompt = `Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.

## Recent Session Log
${sessionLog}`;

  const cachedSystem = [
    { type: "text", text: staticPrompt, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamicPrompt },
  ];

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: message },
  ];

  try {
    let response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: cachedSystem,
      tools: TOOLS,
      messages,
    });

    const savedFiles = [];
    const toolsCalled = [];

    while (response.stop_reason === "tool_use") {
      const toolBlocks = response.content.filter((b) => b.type === "tool_use");

      const toolResults = await Promise.all(
        toolBlocks.map(async (block) => {
          toolsCalled.push(block.name);
          const content = await executeTool(block.name, block.input, savedFiles);
          return { type: "tool_result", tool_use_id: block.id, content };
        })
      );

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: cachedSystem,
        tools: TOOLS,
        messages,
      });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    const reply = textBlock ? textBlock.text : "Done.";

    return res.status(200).json({ reply, saved: savedFiles, toolsCalled });
  } catch (err) {
    console.error("Claude API error:", err);
    const msg = err.message?.toLowerCase() || "";
    const isCredits = err.status === 402 || msg.includes("credit") || msg.includes("billing") || msg.includes("quota") || msg.includes("balance");
    if (isCredits) {
      return res.status(200).json({
        reply: "⚠️ Out of API credits. Go to console.anthropic.com → Billing to add more. Everything else (tasks, email send) still works once credits are topped up.",
        saved: [],
        toolsCalled: [],
      });
    }
    return res.status(500).json({ error: "Failed to get response from Claude" });
  }
}
