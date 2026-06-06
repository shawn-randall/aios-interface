// ── Link-in-bio analytics beacon ───────────────────────────────────────────
//
// The public link-in-bio page (different origin) sends a tiny beacon here on
// pageview + on each link click. We insert it into Supabase server-side (secret
// key never touches the page). Owned, free funnel data. Best-effort + silent.

import { insertLinkEvent } from "./_supabase.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};
  try {
    await insertLinkEvent({ type: b.type, label: b.label, referrer: b.ref || b.referrer });
  } catch (e) { /* analytics are best-effort */ }
  return res.status(200).json({ ok: true });
}
