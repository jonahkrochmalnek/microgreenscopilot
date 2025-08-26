// Netlify Edge: inject <script src="/sync.js" defer></script> into every HTML page
export default async (request, context) => {
  const res = await context.next();

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return res; // don't touch JS, JSON, images, etc

  // 1) Try HTMLRewriter (fast & streaming)
  try {
    if (typeof HTMLRewriter !== "undefined") {
      return new HTMLRewriter()
        .on("head", {
          element(el) {
            el.append('<script src="/sync.js" defer></script>', { html: true });
          }
        })
        .transform(res);
    }
  } catch (err) {
    // fall through to string injection
    console.error("HTMLRewriter failed:", err);
  }

  // 2) Fallback: read body and inject via string replace
  const html = await res.text();
  const alreadyInjected = html.includes('/sync.js');
  const injected = alreadyInjected
    ? html
    : html.replace(/<\/head>/i, '<script src="/sync.js" defer></script></head>');

  const headers = new Headers(res.headers);
  headers.delete("content-length"); // body length changed
  return new Response(injected, {
    status: res.status,
    statusText: res.statusText,
    headers
  });
};

export const config = { path: "/*" };
