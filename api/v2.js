import Anthropic from "@anthropic-ai/sdk";
// Shared capability layer — same connectors the voice + SMS channels use.
import { addTask as cAddTask, listTasks as cListTasks, completeTask as cCompleteTask, addEvent as cAddEvent, listEvents as cListEvents, saveNote as cSaveNote, readEmail as cReadEmail, sendEmail as cSendEmail } from "./_connectors.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REPO = "shawn-randall/AIS-OS";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TODOIST_TOKEN = process.env.TODOIST_API_TOKEN;
const TODOIST_BASE = "https://api.todoist.com/api/v1";


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
    description: "List Shawn's Todoist tasks. Use when he asks what's on his list, what's due, or what he needs to do.",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["today", "all"],
          description: "'today' = due today or overdue (default). 'all' = every active task.",
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
    description: "Mark a task complete / done. Use when Shawn says he finished or completed a task.",
    input_schema: {
      type: "object",
      properties: {
        task_name: { type: "string", description: "The task as Shawn refers to it, e.g. 'call Jules'. The system finds the best match." },
      },
      required: ["task_name"],
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
    description: "Add an event to Shawn's calendar. Use when he asks to schedule, book, or add something.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        when: { type: "string", description: "Date and time exactly as Shawn said it — 'next Friday at 4pm', 'Wednesday the 3rd', 'June 6th at noon'. Don't compute the date yourself; pass his words." },
        calendar_name: { type: "string", description: "Which calendar, if specified — e.g. 'Music', 'Acting', 'Work'. Omit for his default (Home) calendar." },
        duration_mins: { type: "integer", description: "Duration in minutes (default 60)." },
      },
      required: ["title", "when"],
    },
  },
  {
    name: "save_note",
    description: "Save a quick note or piece of info for Shawn. Use when he says 'remember that...', 'note that...', or wants to capture a thought or detail.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "The note text to save." },
      },
      required: ["note"],
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

  // ── Shared connectors (same logic as voice + SMS) ──
  if (name === "list_tasks")   return (await cListTasks({ scope: input.scope })).message;
  if (name === "add_task")     return (await cAddTask(input)).message;
  if (name === "complete_task") return (await cCompleteTask({ task_name: input.task_name })).message;
  if (name === "list_events")  return (await cListEvents({ days: input.days })).message;
  if (name === "add_event")    return (await cAddEvent(input)).message;
  if (name === "save_note")    return (await cSaveNote({ note: input.note })).message;

  if (name === "read_email")   return (await cReadEmail({ account: input.account, count: input.count })).message;
  if (name === "send_email")   return (await cSendEmail(input)).message;

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
    claudeMd, phoneInstructions, version, connections, priorities, aboutMe, aboutBusiness,
    decisionsLog, sessionLog, actorBio, pendingEmails,
    ghostNotes, gmailCleaner, sofiReferral,
    skoolCommunity, problemApp, aiosInterface, joshGroban,
    patreon, labIntensive,
  ] = await Promise.all([
    fetchContext("CLAUDE.md"),
    fetchContext("context/phone-instructions.md"),
    fetchContext("context/version.md"),
    fetchContext("connections.md"),
    fetchContext("context/priorities.md"),
    fetchContext("context/about-me.md"),
    fetchContext("context/about-business.md"),
    fetchContext("decisions/log.md"),
    fetchContext("context/session-log.md"),
    fetchContext("context/actor-bio.md"),
    fetchContext("drafts/pending-email-responses.md"),
    fetchContext("projects/ghost-notes.md"),
    fetchContext("projects/gmail-cleaner.md"),
    fetchContext("projects/sofi-referral.md"),
    fetchContext("projects/skool-community.md"),
    fetchContext("projects/problem-collection-app.md"),
    fetchContext("projects/aios-interface.md"),
    fetchContext("projects/josh-groban.md"),
    fetchContext("projects/patreon.md"),
    fetchContext("projects/lab-intensive.md"),
  ]);

  const staticPrompt = `## PHONE INTERFACE OPERATING INSTRUCTIONS

${phoneInstructions}

---

${version}

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

## Actor Bio
${actorBio}

---

## Pending Email Responses
${pendingEmails}

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

### Patreon (Revenue)
${patreon}

### LAB Intensive Ensemble Teaching Project 2026
${labIntensive}

---

You are Shawn's AIOS, running inside a Vercel serverless function. You cannot run scripts or terminal commands.`;

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
