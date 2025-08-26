// netlify/edge-functions/inject-sync.js
export default async (request, context) => {
  const res = await context.next();
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return res;

  let html = await res.text();

  // Inject sync.js as the FIRST script in <head> (parser-blocking).
  const loader = `
<!-- cloud-sync loader -->
<script src="/sync.js"></script>
<!-- /cloud-sync loader -->
`;

  html = html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>\n${loader}`);

  return new Response(html, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  });
}
