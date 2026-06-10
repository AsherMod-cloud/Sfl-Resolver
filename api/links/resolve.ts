import type { VercelRequest, VercelResponse } from "@vercel/node";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface CookieJar {
  [domain: string]: { [name: string]: string };
}

function parseCookiesFromHeaders(
  headers: Headers,
  domain: string,
  jar: CookieJar,
): void {
  const setCookieValues = headers.getSetCookie
    ? headers.getSetCookie()
    : (headers.get("set-cookie") || "").split(",").filter(Boolean);

  for (const raw of setCookieValues) {
    const [nameValue] = raw.split(";");
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx === -1) continue;
    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();
    if (!jar[domain]) jar[domain] = {};
    jar[domain][name] = value;
  }
}

function cookieHeader(jar: CookieJar, domain: string): string {
  const cookies: string[] = [];
  for (const [d, pairs] of Object.entries(jar)) {
    if (domain.includes(d) || d.includes(domain)) {
      for (const [name, value] of Object.entries(pairs)) {
        cookies.push(`${name}=${value}`);
      }
    }
  }
  return cookies.join("; ");
}

async function fetchUrl(
  url: string,
  jar: CookieJar,
  options: RequestInit & { extraHeaders?: Record<string, string> } = {},
): Promise<Response> {
  const parsedUrl = new URL(url);
  const domain = parsedUrl.hostname;
  const cookieStr = cookieHeader(jar, domain);

  const headers = new Headers(options.headers);
  headers.set("User-Agent", UA);
  if (cookieStr) headers.set("Cookie", cookieStr);
  if (options.extraHeaders) {
    for (const [k, v] of Object.entries(options.extraHeaders)) {
      headers.set(k, v);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    parseCookiesFromHeaders(response.headers, domain, jar);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

function randomAlnum(len: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < len; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

async function resolveSflGl(
  url: string,
): Promise<{ finalUrl: string; steps: number; title: string | null }> {
  const jar: CookieJar = {};

  const sflRes = await fetchUrl(url, jar);
  const sflHtml = await sflRes.text();

  const rayIdMatch = sflHtml.match(/name="ray_id"\s+value="([^"]+)"/);
  const aliasMatch = sflHtml.match(/name="alias"\s+value="([^"]+)"/);
  const actionMatch = sflHtml.match(/action="([^"]+)"/);

  if (!rayIdMatch || !aliasMatch || !actionMatch) {
    throw new Error("Could not parse sfl.gl page — format may have changed");
  }

  const rayId = rayIdMatch[1];
  const alias = aliasMatch[1];
  const action = actionMatch[1];

  const formUrl = `${action}?ray_id=${encodeURIComponent(rayId)}&alias=${encodeURIComponent(alias)}`;
  const formRes = await fetchUrl(formUrl, jar);

  const loc1 = formRes.headers.get("location");
  if (!loc1) throw new Error("No redirect from sfl.gl form");
  const blog1 = new URL(loc1, action).href;

  await fetchUrl(blog1, jar);

  await fetchUrl("https://app.khaddavi.net/api/session", jar, {
    method: "POST",
    extraHeaders: {
      "Content-Type": "application/json",
      Referer: blog1,
      Origin: "https://app.khaddavi.net",
    },
    body: "{}",
  });

  const verifyRes = await fetchUrl("https://app.khaddavi.net/api/verify", jar, {
    method: "POST",
    extraHeaders: {
      "Content-Type": "application/json",
      Referer: blog1,
      Origin: "https://app.khaddavi.net",
    },
    body: JSON.stringify({ _a: 0, captcha: null, passcode: null }),
  });

  const verifyData = (await verifyRes.json()) as { target?: string };
  if (!verifyData.target) throw new Error("No target from /api/verify");

  const redirectRes = await fetchUrl(verifyData.target, jar);
  const loc2 = redirectRes.headers.get("location");
  if (!loc2) throw new Error("No redirect to step-2 blog");
  const blog2 = new URL(loc2, verifyData.target).href;

  await fetchUrl(blog2, jar);

  await fetchUrl("https://app.khaddavi.net/api/session", jar, {
    method: "POST",
    extraHeaders: {
      "Content-Type": "application/json",
      Referer: blog2,
      Origin: "https://app.khaddavi.net",
    },
    body: "{}",
  });

  const key = Math.floor(Math.random() * 1000);
  const w = 1280;
  const h = 720;
  const size = `${(w + key) * 2}.${(h + key) * 2}`;
  const idempotencyKey = randomAlnum(32);

  const goRes = await fetchUrl("https://app.khaddavi.net/api/go", jar, {
    method: "POST",
    extraHeaders: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      Referer: blog2,
      Origin: "https://app.khaddavi.net",
    },
    body: JSON.stringify({ key, size, _dvc: "canvas_fp_server_v1" }),
  });

  const goData = (await goRes.json()) as { url?: string };
  if (!goData.url) throw new Error("No URL from /api/go");

  const readyRes = await fetchUrl(goData.url, jar, {
    extraHeaders: { Referer: blog2 },
  });
  const readyHtml = await readyRes.text();
  const finalTitle = extractTitle(readyHtml);

  const hrefMatch = readyHtml.match(
    /window\.location\.href\s*=\s*["']([^"']+)["']/,
  );
  if (!hrefMatch) {
    const loc3 = readyRes.headers.get("location");
    if (loc3) {
      return { finalUrl: new URL(loc3, goData.url).href, steps: 5, title: finalTitle };
    }
    throw new Error("Could not find destination URL on final sfl.gl page");
  }

  return { finalUrl: hrefMatch[1].replace(/\\\//g, "/"), steps: 5, title: finalTitle };
}

async function resolveGeneric(
  startUrl: string,
): Promise<{ finalUrl: string; steps: number; title: string | null }> {
  const jar: CookieJar = {};
  let currentUrl = startUrl;
  let steps = 0;
  const MAX_STEPS = 15;
  const visited = new Set<string>();

  while (steps < MAX_STEPS && !visited.has(currentUrl)) {
    visited.add(currentUrl);
    const response = await fetchUrl(currentUrl, jar);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).href;
      steps++;
      continue;
    }

    if (response.status >= 200 && response.status < 300) {
      const ct = response.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        const html = await response.text();
        const title = extractTitle(html);
        const metaRefresh = html.match(
          /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]*;\s*url=([^"'\s>]+)/i,
        );
        if (metaRefresh) {
          const nextUrl = new URL(metaRefresh[1].trim(), currentUrl).href;
          if (nextUrl !== currentUrl) {
            currentUrl = nextUrl;
            steps++;
            continue;
          }
        }
        return { finalUrl: currentUrl, steps, title };
      }
      break;
    }
    break;
  }

  return { finalUrl: currentUrl, steps, title: null };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body as { url?: string };

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: "Only HTTP and HTTPS URLs are supported" });
    }
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  try {
    const isSflGl =
      parsedUrl.hostname === "sfl.gl" || parsedUrl.hostname.endsWith(".sfl.gl");

    const result = isSflGl
      ? await resolveSflGl(url)
      : await resolveGeneric(url);

    return res.json({
      originalUrl: url,
      finalUrl: result.finalUrl,
      steps: result.steps,
      title: result.title,
    });
  } catch (err) {
    return res.status(422).json({
      error:
        err instanceof Error
          ? err.message
          : "Failed to resolve link. It may be inaccessible or protected.",
    });
  }
}
