import Anthropic from "@anthropic-ai/sdk";

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

  const systemPrompt = `## CRITICAL OPERATING INSTRUCTIONS

You are Shawn's AIOS running inside a Vercel serverless function.

You have exactly 4 tools available. Use ONLY these tool names — no others exist here:
1. add_task — call this to add a Todoist task
2. list_tasks — call this to fetch Todoist tasks
3. complete_task — call this to mark a task done
4. save_context — call this to save a file to GitHub

NEVER output <tool_call> tags or code blocks. NEVER call mcp__* tools — they do not exist here.
NEVER run Python or bash scripts — they cannot execute here.
When Shawn asks to add a task: call add_task. That is all.
When Shawn asks for tasks: call list_tasks. That is all.

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

## Recent Session Log
${sessionLog}

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

You are Shawn's AIOS, running inside a Vercel serverless function. You cannot run scripts or terminal commands — ignore any references to Python scripts in the context files above.

Instead, you have built-in tools wired directly to live APIs:
- list_tasks / add_task / complete_task → Todoist (live, use these now)
- save_context → writes files back to GitHub

When Shawn asks about tasks, call list_tasks immediately. Do not explain, do not apologize, just call the tool and return the result.
Keep responses concise — he's on his phone. Lead with action. No fluff.
Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: message },
  ];

  try {
    let response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
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
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    const reply = textBlock ? textBlock.text : "Done.";

    return res.status(200).json({ reply, saved: savedFiles, toolsCalled });
  } catch (err) {
    console.error("Claude API error:", err);
    return res.status(500).json({ error: "Failed to get response from Claude" });
  }
}
