// /sync.js — V2.3: auth-aware + auto-migrate + reconcile + push-suppression
(async () => {
  const NS = "SUPA_SYNC_V23"; if (window[NS]) return; window[NS] = true;

  const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
  const STORAGE_KEY = window.STORAGE_KEY || "yield_focus_v2";
  const str = (o)=>JSON.stringify(o||{});
  const getLocalObj = () => { try { return window.state ?? JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}"); } catch { return {}; } };

  // If we just restored on the previous page, suppress pushes briefly
  let suppressPush = sessionStorage.getItem("cloud_restoring")==="1";
  if (suppressPush) setTimeout(()=>{ suppressPush=false; sessionStorage.removeItem("cloud_restoring"); }, 1500);

  // Reuse app client; otherwise create one
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

  let session = (await supabase.auth.getSession()).data?.session || null;
  const userId   = session?.user?.id || null;
  const deviceId = localStorage.getItem("mc_device_id") || (localStorage.setItem("mc_device_id", crypto.randomUUID()), localStorage.getItem("mc_device_id"));
  let rowId = userId || deviceId;

  async function fetchServer(id){
    const { data, error } = await supabase.from("cloud_store").select("data,updated_at").eq("id", id).maybeSingle();
    return { data: data?.data, updated_at: data?.updated_at, error };
  }

  function applyServer(data, updated_at){
    // Write server state locally and reload, while preventing pushes
    suppressPush = true;
    sessionStorage.setItem("cloud_restoring","1");
    window.state = data;
    localStorage.setItem(STORAGE_KEY, str(data));
    localStorage.setItem("cloud_updated_at", updated_at || new Date().toISOString());
    (window.save||(()=>{}))();
    location.reload();
  }

  async function push(){
    if (suppressPush) return;                 // <-- guard
    try{
      const payload = getLocalObj();
      const { error } = await supabase.from("cloud_store").upsert(
        { id: rowId, owner: userId||null, data: payload, updated_at: new Date().toISOString() },
        { onConflict:"id" }
      );
      if (error) console.error("[cloud-sync] push error", error);
      else console.log("[cloud-sync] pushed", { id: rowId, bytes: str(payload).length });
    }catch(e){ console.error("[cloud-sync] push fail", e); }
  }

  async function pull(id=rowId){
    const srv = await fetchServer(id);
    if (srv.error) { console.error("[cloud-sync] pull error", srv.error); return false; }
    if (!srv.data){ console.log("[cloud-sync] nothing to pull"); return false; }
    applyServer(srv.data, srv.updated_at);
    return true;
  }

  // Wait for app to expose save/state a bit, then hook autosave
  for (let i=0;i<100 && typeof window.save!=="function" && typeof window.state==="undefined"; i++) await wait(100);
  if (typeof window.save==="function" && !window.save.__wrapped_for_cloud__) {
    const _save = window.save;
    window.save = function(){ const r=_save.apply(this,arguments); if (!suppressPush) { clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,300); } return r; };
    window.save.__wrapped_for_cloud__ = true;
  }
  if (!localStorage.__cloud_wrapped__) {
    const _set = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(k,v){ const r=_set(k,v); if (k===STORAGE_KEY && !suppressPush){ clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,300); } return r; };
    localStorage.__cloud_wrapped__ = true;
  }
  // Safety: small audit loop
  setInterval(()=>{ if (!suppressPush) { clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,500); } }, 4000);
  addEventListener("visibilitychange", ()=>{ if (document.visibilityState==="hidden") push(); });

  // Reconcile on load: if signed-in, prefer newer/bigger server copy BEFORE enabling pushes
  (async ()=>{
    const localObj = getLocalObj();
    const localStr = str(localObj);
    if (userId){
      const srv = await fetchServer(userId);
      if (!srv.error && srv.data){
        const srvStr = str(srv.data);
        const newer = srv.updated_at && (!localStorage.getItem("cloud_updated_at") || new Date(srv.updated_at) > new Date(localStorage.getItem("cloud_updated_at")));
        const bigger = srvStr.length > localStr.length + 50;
        if (srvStr !== localStr && (newer || bigger)) {
          console.log("[cloud-sync] server newer/bigger → pulling");
          return applyServer(srv.data, srv.updated_at);  // reloads
        }
      } else if (!localStorage.getItem(STORAGE_KEY)) {
        return pull(userId);
      }
    } else if (!localStorage.getItem(STORAGE_KEY)) {
      return pull(deviceId);
    }
    // No reconcile needed → allow pushes after short delay
    setTimeout(()=>{ suppressPush=false; }, 800);
  })();

  // Auto-migrate device → user on sign-in, then reconcile
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
      // After login, always prefer server if different
      const srv = await fetchServer(newUserId);
      if (srv.data){
        const srvStr = str(srv.data), locStr = str(getLocalObj());
        if (srvStr !== locStr) applyServer(srv.data, srv.updated_at);
        else suppressPush=false;
      }
    }
  });

  window.__cloud = { push, pull, id: rowId };
  console.log("[cloud-sync] ready", window.__cloud);
})();
