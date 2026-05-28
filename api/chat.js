import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Fetch a file from the private AIS-OS GitHub repo
async function fetchContext(path) {
  const url = `https://api.github.com/repos/shawn-randall/AIS-OS/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3.raw",
    },
  });
  if (!res.ok) return "";
  return await res.text();
}

export default async function handler(req, res) {
  // CORS — allow the GitHub Pages interface to call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "No message provided" });

  // Pull core context from private AIS-OS repo
  const [claudeMd, connections, priorities] = await Promise.all([
    fetchContext("CLAUDE.md"),
    fetchContext("connections.md"),
    fetchContext("context/priorities.md"),
  ]);

  const systemPrompt = `${claudeMd}

---

## Current Connections
${connections}

---

## Current Priorities
${priorities}

---

You are Shawn's AIOS, accessible via his Notion interface on mobile.
Keep responses concise — he's on his phone. Lead with action. No fluff.
Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;

  // Build conversation history for multi-turn chat
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
