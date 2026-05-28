import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REPO = "shawn-randall/AIS-OS";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

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

const SAVE_TOOL = {
  name: "save_context",
  description: "Persist an update to the AIOS repo on GitHub. Use this when Shawn asks to save, update, or log anything that should persist across sessions — priorities, decisions, project notes.",
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
        ],
        description: "Repo-relative path of the file to update",
      },
      content: {
        type: "string",
        description: "Complete new content for the file (not a diff — the full file)",
      },
      commit_message: {
        type: "string",
        description: "Brief description of the change, e.g. 'Add Ghost Notes presale to priorities'",
      },
    },
    required: ["file", "content", "commit_message"],
  },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "No message provided" });

  const [
    claudeMd,
    connections,
    priorities,
    aboutMe,
    aboutBusiness,
    decisionsLog,
    ghostNotes,
    gmailCleaner,
    sofiReferral,
    skoolCommunity,
    problemApp,
    aiosInterface,
  ] = await Promise.all([
    fetchContext("CLAUDE.md"),
    fetchContext("connections.md"),
    fetchContext("context/priorities.md"),
    fetchContext("context/about-me.md"),
    fetchContext("context/about-business.md"),
    fetchContext("decisions/log.md"),
    fetchContext("projects/ghost-notes.md"),
    fetchContext("projects/gmail-cleaner.md"),
    fetchContext("projects/sofi-referral.md"),
    fetchContext("projects/skool-community.md"),
    fetchContext("projects/problem-collection-app.md"),
    fetchContext("projects/aios-interface.md"),
  ]);

  const systemPrompt = `${claudeMd}

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

---

You are Shawn's AIOS, accessible via his Notion interface on mobile.
Keep responses concise — he's on his phone. Lead with action. No fluff.
When Shawn asks to save, update, or log anything — use save_context to write it to GitHub. Always confirm what you saved.
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
      tools: [SAVE_TOOL],
      messages,
    });

    const savedFiles = [];

    while (response.stop_reason === "tool_use") {
      const toolBlocks = response.content.filter((b) => b.type === "tool_use");

      const toolResults = await Promise.all(
        toolBlocks.map(async (block) => {
          const { file, content, commit_message } = block.input;
          const ok = await writeContext(file, content, `Phone: ${commit_message}`);
          if (ok) savedFiles.push(file);
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: ok ? `Saved ${file} to GitHub.` : `Failed to save ${file}.`,
          };
        })
      );

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        tools: [SAVE_TOOL],
        messages,
      });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    const reply = textBlock ? textBlock.text : "Done.";

    return res.status(200).json({ reply, saved: savedFiles });
  } catch (err) {
    console.error("Claude API error:", err);
    return res.status(500).json({ error: "Failed to get response from Claude" });
  }
}
