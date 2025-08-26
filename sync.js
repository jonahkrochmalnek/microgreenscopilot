// /sync.js — V2.7 (stable + auto-detect): server-wins, single reload on pull,
// periodic change detection (every 2s), save hooks, and manual __cloud API.
(async () => {
  const NS = "SUPA_SYNC_V27";
  if (window[NS]) return; window[NS] = true;

  // --- utils ---------------------------------------------------------------
  const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
  const STORAGE_KEY = window.STORAGE_KEY || "yield_focus_v2";
  const toJSON = (o)=>JSON.stringify(o||{});
  const fromJSON = (s)=>{ try { return JSON.parse(s); } catch { return {}; } };
  const getLocal = () => (typeof window.state !== "undefined")
    ? window.state
    : fromJSON(localStorage.getItem(STORAGE_KEY)||"{}");
  const sig = (s)=> s ? (s.length+":"+s.slice(0,64)+":"+s.slice(-64)) : "0:";

  // After a restore we briefly block pushes so the app boots cleanly
  let suppressPush = sessionStorage.getItem("cloud_restoring")==="1";
  if (suppressPush) setTimeout(()=>{ suppressPush=false; sessionStorage.removeItem("cloud_restoring"); }, 1200);
  let lastSig = sig(localStorage.getItem(STORAGE_KEY)||"");

  // --- Supabase client -----------------------------------------------------
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

  // --- IDs -----------------------------------------------------------------
  let session = (await supabase.auth.getSession()).data?.session || null;
  const userId   = session?.user?.id || null;
  const deviceId = localStorage.getItem("mc_device_id") || (localStorage.setItem("mc_device_id", crypto.randomUUID()), localStorage.getItem("mc_device_id"));
  let rowId = userId || deviceId;

  // --- DB helpers ----------------------------------------------------------
  async function fetchServer(id){
    const { data, error } = await supabase.from("cloud_store").select("data,updated_at").eq("id", id).maybeSingle();
    return { data: data?.data, updated_at: data?.updated_at, error };
  }
  async function upsert(id, payload){
    return await supabase.from("cloud_store").upsert(
      { id, owner: userId||null, data: payload, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
  }

  function applyServer(data, updated_at){
    // Reload at most once every 3s to avoid loops
    const now = Date.now();
    const last = +sessionStorage.getItem("cloud_last_reload_ts") || 0;
    if (now - last < 3000) {
      // No reload: just write locally
      window.state = data;
      const s = toJSON(data);
      localStorage.setItem(STORAGE_KEY, s);
      localStorage.setItem("cloud_updated_at", updated_at || new Date().toISOString());
      lastSig = sig(s);
      (window.save||(()=>{}))();
      return;
    }
    suppressPush = true;
    sessionStorage.setItem("cloud_restoring","1");
    sessionStorage.setItem("cloud_last_reload_ts", String(now));
    window.state = data;
    const s = toJSON(data);
    localStorage.setItem(STORAGE_KEY, s);
    localStorage.setItem("cloud_updated_at", updated_at || new Date().toISOString());
    lastSig = sig(s);
    (window.save||(()=>{}))();
    location.reload();
  }

  // --- push / pull ---------------------------------------------------------
  async function push(){
    if (suppressPush) return;
    const payload = getLocal();
    const s = toJSON(payload);
    const sSig = sig(s);
    if (sSig === lastSig) return; // unchanged
    const { error } = await upsert(rowId, payload);
    if (error) { console.error("[cloud-sync] push error", error); return; }
    lastSig = sSig;
    console.log("[cloud-sync] pushed", { id: rowId, bytes: s.length });
  }
  async function pull(id=rowId){
    const srv = await fetchServer(id);
    if (srv.error) { console.error("[cloud-sync] pull error", srv.error); return false; }
    if (!srv.data)  { console.log("[cloud-sync] nothing to pull"); return false; }
    console.log("[cloud-sync] pulling server copy");
    applyServer(srv.data, srv.updated_at);
    return true;
  }

  // --- hook app saves & local writes --------------------------------------
  for (let i=0;i<150 && typeof window.save!=="function" && typeof window.state==="undefined"; i++) await wait(100);
  if (typeof window.save==="function" && !window.save.__wrapped_for_cloud__) {
    const _save = window.save;
    window.save = function(){ const r=_save.apply(this,arguments); if (!suppressPush){ clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,400);} return r; };
    window.save.__wrapped_for_cloud__ = true;
  }
  if (!localStorage.__cloud_wrapped__) {
    const _set = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(k,v){
      const before = localStorage.getItem(k);
      const r = _set(k,v);
      if (k===STORAGE_KEY && !suppressPush && before !== v){
        clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,400);
      }
      return r;
    };
    localStorage.__cloud_wrapped__ = true;
  }

  // NEW: periodic change detection (catches silent state updates)
  setInterval(() => {
    if (suppressPush) return;
    try {
      const s = toJSON(getLocal());
      const sSig = sig(s);
      if (sSig !== lastSig) {
        clearTimeout(window.__supaPushT); 
        window.__supaPushT = setTimeout(push, 200);
      }
    } catch {}
  }, 2000);

  addEventListener("visibilitychange", ()=>{ if (document.visibilityState==="hidden") push(); });
  addEventListener("beforeunload", ()=>{ navigator.sendBeacon && navigator.sendBeacon("/", new Blob()); /* nudge */ });

  // --- reconcile on load (SERVER WINS when signed in) ----------------------
  (async ()=>{
    const localObj = getLocal();
    const localStr = toJSON(localObj);
    lastSig = sig(localStr);

    if (userId){
      const srv = await fetchServer(userId);
      if (srv.data){
        const srvStr = toJSON(srv.data);
        const differ = srvStr !== localStr;
        const newer  = srv.updated_at && (!localStorage.getItem("cloud_updated_at") || new Date(srv.updated_at) > new Date(localStorage.getItem("cloud_updated_at")));
        const bigger = srvStr.length > localStr.length + 50;
        if (differ && (newer || bigger)){
          console.log("[cloud-sync] reconcile: server>local → pulling");
          applyServer(srv.data, srv.updated_at);
          return;
        }
      } else if (localStr && localStr !== "{}") {
        console.log("[cloud-sync] create user row from local");
        await upsert(userId, localObj);
      }
      suppressPush = false;
    } else {
      if (!localStorage.getItem(STORAGE_KEY)) await pull(deviceId);
      suppressPush = false;
    }
  })();

  // --- migrate device → user on SIGNED_IN, then reconcile again ------------
  supabase.auth.onAuthStateChange(async (event, newSession) => {
    if (event === "SIGNED_IN" && newSession?.user?.id) {
      const newUserId = newSession.user.id;
      if (rowId !== newUserId) {
        const dev = await fetchServer(rowId);
        const user = await fetchServer(newUserId);
        if (!user.data && dev.data) await upsert(newUserId, dev.data);
        rowId = newUserId;
        localStorage.setItem("mc_device_id", newUserId);
        console.log("[cloud-sync] switched to user id", newUserId);
      }
      const srv = await fetchServer(newUserId);
      if (srv.data){
        const srvStr = toJSON(srv.data), locStr = toJSON(getLocal());
        if (srvStr !== locStr) {
          console.log("[cloud-sync] reconcile after login → pulling");
          applyServer(srv.data, srv.updated_at);
          return;
        }
      }
      suppressPush = false;
    }
  });

  // --- debug handle --------------------------------------------------------
  window.__cloud = { push, pull, id: rowId };
  console.log("[cloud-sync] ready", window.__cloud);
})();
