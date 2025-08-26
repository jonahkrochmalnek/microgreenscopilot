// netlify/edge-functions/inject-sync.js
export default async (request, context) => {
  const res = await context.next();
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return res;

  let html = await res.text();

  // Guard (inline, synchronous) + load sync.js WITHOUT defer/type=module.
  const guardAndLoader = `
<!-- cloud-sync guard + loader -->
<script>
(function(){
  // Block early writes to the main blob until the shim is ready.
  const K = "yield_focus_v2";
  const _set = localStorage.setItem.bind(localStorage);
  localStorage.__guarded = _set;
  localStorage.setItem = function(k,v){
    if (k === K && !window.__cloud_ready) {
      // Stash the attempted value (debug only) and do NOT overwrite.
      try { sessionStorage.setItem("__blocked_"+K, v); } catch {}
      return;
    }
    return _set(k, v);
  };
  // Auto-release guard once the shim sets __cloud_ready, or after 5s fallback.
  let tries = 0;
  (function waitReady(){
    if (window.__cloud_ready) {
      localStorage.setItem = _set;
    } else if (tries++ < 100) {
      setTimeout(waitReady, 50);
    } else {
      // Safety: never block forever.
      localStorage.setItem = _set;
    }
  })();
})();
</script>
<script src="/sync.js"></script>
<!-- /cloud-sync guard + loader -->
`;

  // Insert immediately after <head ...>
  html = html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>\n${guardAndLoader}`);

  return new Response(html, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  });
}
