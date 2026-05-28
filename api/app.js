import { readFileSync } from "fs";
import { join } from "path";

export default function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
  res.status(200).send(html);
}
