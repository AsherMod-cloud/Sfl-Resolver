import type { VercelRequest, VercelResponse } from "@vercel/node";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { url } = req.query as { url?: string };
  if (!url) return res.status(400).json({ error: "url param required" });

  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    const body = await response.text();

    return res.json({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      bodySnippet: body.slice(0, 2000), // first 2000 chars
      hasRayId: body.includes('name="ray_id"'),
      hasAlias: body.includes('name="alias"'),
      hasAction: body.includes('action="'),
      isCfChallenge: body.includes("cf-browser-verification") || body.includes("jschl_vc"),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
