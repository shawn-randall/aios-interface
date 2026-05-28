import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function fetchContext(path) {
  const url = `https://api.github.com/repos/shawn-randall/AIS-OS/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3.raw",
    },
  });
  if (!res.ok) return `[${path} not found]`;
  return await res.text();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "No message provided" });

  // Fetch all context files in parallel
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
Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: message },
  ];

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const reply = response.content[0].text;
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Claude API error:", err);
    return res.status(500).json({ error: "Failed to get response from Claude" });
  }
}
