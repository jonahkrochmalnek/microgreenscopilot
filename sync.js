// /sync.js — V2.4: auth-aware + auto-migrate + reconcile (server-wins) + safe autosave
(async () => {
  const NS = "SUPA_SYNC_V24"; if (window[NS]) return; window[NS] = true;

  const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
  const STORAGE_KEY = window.STORAGE_KEY || "yield_focus_v2";
  const j = (o)=>JSON.stringify(o||{});
  const parse = (s)=>{ try { return JSON.parse(s); } catch { return {}; } };
  const getLocal = () => typeof window.state !== "undefined"
    ? window.state
    : parse(localStorage.getItem(STORAGE_KEY) || "{}");

  // Block pushes while we’re restoring/reconciling
  let suppressPush = true;
  let lastSig = ""; // signature of last-pushed local JSON
  const signature = (s) => s ? (s.length+":"+s.slice(0,64)+":"+s.slice(-64)) : "0:";

  // Reuse page client if present; else create one
  let supabase = window.supabase;
  for (let i=0;i<30 && !supabase;i++){ await wait(100); supabase = window.supabase; }
  if (!supabase) {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(
      "https://glxzjcqbvyimlwlyauws.supabase.co",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdseHpqY3FidnlpbWx3bHlhdXdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYxMzc1NjQsImV4cCI6MjA3MTcxMzU2NH0.L_Dfhz_ZxVIC2i7B55ZpZALSrgR7JffPwwRtJLn6Wbo"
    );
    window.supabase = supabase;
  }

  // IDs
  let session = (await supabase.auth.getSession()).data?.session || null;
  const userId   = session?.user?.id || null;
  const deviceId = localStorage.getItem("mc_device_id") || (localStorage.setItem("mc_device_id", crypto.randomUUID()), localStorage.getItem("mc_device_id"));
  let rowId = userId || deviceId;

  // Supabase helpers
  async function fetchServer(id){
    const { data, error } = await supabase
      .from("cloud_store").select("data, updated_at").eq("id", id).maybeSingle();
    return { data: data?.data, updated_at: data?.updated_at, error };
  }

  function applyServer(data, updated_at){
    // write server -> local; keep pushes blocked for a moment while app settles
    suppressPush = true;
    window.state = data;
    const s = j(data);
    localStorage.setItem(STORAGE_KEY, s);
    localStorage.setItem("cloud_updated_at", updated_at || new Date().toISOString());
    lastSig = signature(s);
    (window.save||(()=>{}))();
    // Allow app to boot fully before enabling pushes (prevents immediate overwrite)
    setTimeout(()=>{ suppressPush = false; }, 1500);
  }

  async function push(){
    if (suppressPush) return;
    const payload = getLocal();
    const s = j(payload);
    const sig = signature(s);
    if (sig === lastSig) return; // nothing changed -> don't spam pushes
    const { error } = await supabase
      .from("cloud_store")
      .upsert({ id: rowId, owner: userId||null, data: payload, updated_at: new Date().toISOString() }, { onConflict:"id" });
    if (error) { console.error("[cloud-sync] push error", error); return; }
    lastSig = sig;
    console.log("[cloud-sync] pushed", { id: rowId, bytes: s.length });
  }

  async function pull(id=rowId){
    const srv = await fetchServer(id);
    if (srv.error) { console.error("[cloud-sync] pull error", srv.error); return false; }
    if (!srv.data) { console.log("[cloud-sync] nothing to pull"); return false; }
    console.log("[cloud-sync] pulling server copy");
    applyServer(srv.data, srv.updated_at);
    return true;
  }

  // --- Hook app saves and localStorage writes (but respect suppression) -----
  for (let i=0;i<100 && typeof window.save!=="function" && typeof window.state==="undefined"; i++) await wait(100);
  if (typeof window.save==="function" && !window.save.__wrapped_for_cloud__) {
    const _save = window.save;
    window.save = function(){ const r=_save.apply(this,arguments); if (!suppressPush){ clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,300); } return r; };
    window.save.__wrapped_for_cloud__ = true;
  }
  if (!localStorage.__cloud_wrapped__) {
    const _set = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(k,v){
      const before = localStorage.getItem(k);
      const r = _set(k,v);
      if (k===STORAGE_KEY && !suppressPush && before !== v){
        clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,300);
      }
      return r;
    };
    localStorage.__cloud_wrapped__ = true;
  }

  // --- Reconcile on load: if signed in and server != local, SERVER WINS -----
  (async ()=>{
    const localStr = j(getLocal());
    lastSig = signature(localStr);

    if (userId){
      const srv = await fetchServer(userId);
      if (!srv.error && srv.data){
        const srvStr = j(srv.data);
        const differ = srvStr !== localStr;
        const newer  = srv.updated_at && (!localStorage.getItem("cloud_updated_at") || new Date(srv.updated_at) > new Date(localStorage.getItem("cloud_updated_at")));
        const bigger = srvStr.length > localStr.length; // any bigger at all
        if (differ && (newer || bigger)){
          console.log("[cloud-sync] reconcile: server>local (", { newer, bigger }, ") → pulling");
          applyServer(srv.data, srv.updated_at);
          return; // keep suppression true for a moment; no immediate push
        }
      }
      // Signed-in but no server data yet: keep local if present; else nothing to pull
      suppressPush = false;
    } else {
      // Not signed in: if local empty, try device row
      if (!localStorage.getItem(STORAGE_KEY)) await pull(deviceId);
      suppressPush = false;
    }
  })();

  // --- Auto-migrate device → user on sign-in, then reconcile again ----------
  supabase.auth.onAuthStateChange(async (event, newSession) => {
    if (event === "SIGNED_IN" && newSession?.user?.id) {
      session = newSession;
      const newUserId = newSession.user.id;
      if (rowId !== newUserId) {
        const dev = await fetchServer(rowId);
        if (dev.data) {
          await supabase.from("cloud_store").upsert({
            id:newUserId, owner:newUserId, data:dev.data, updated_at:new Date().toISOString()
          }, { onConflict:"id" });
        }
        rowId = newUserId;
        localStorage.setItem("mc_device_id", newUserId);
        console.log("[cloud-sync] switched to user id", newUserId);
      }
      // After login, if server != local, SERVER WINS
      const srv = await fetchServer(newUserId);
      if (srv.data){
        const srvStr = j(srv.data), locStr = j(getLocal());
        if (srvStr !== locStr) {
          console.log("[cloud-sync] reconcile after login → pulling");
          applyServer(srv.data, srv.updated_at);
          return;
        }
      }
      suppressPush = false;
    }
  });

  // Debug / manual
  window.__cloud = { push, pull, id: rowId };
  console.log("[cloud-sync] ready", window.__cloud);
})();
