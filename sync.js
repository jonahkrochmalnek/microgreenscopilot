// /sync.js — V2.2: auth-aware + auto-migrate + server-newer-wins reconcile
(async () => {
  const NS = "SUPA_SYNC_V22"; if (window[NS]) return; window[NS] = true;

  const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
  const STORAGE_KEY = window.STORAGE_KEY || "yield_focus_v2";
  const getLocalObj = () => {
    try { return window.state ?? JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}"); }
    catch { return {}; }
  };
  const str = (o)=>JSON.stringify(o||{});
  const sig = (s)=> (s? s.length+":"+s.slice(0,64)+":"+s.slice(-64) : "0:");

  // Reuse page Supabase client if present; otherwise create one
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

  // Pick IDs
  let session = (await supabase.auth.getSession()).data?.session || null;
  const userId   = session?.user?.id || null;
  const deviceId = localStorage.getItem("mc_device_id") || (localStorage.setItem("mc_device_id", crypto.randomUUID()), localStorage.getItem("mc_device_id"));
  let rowId = userId || deviceId;

  // Push / Pull
  let lastSig = "";
  async function push(){
    try{
      const payload = getLocalObj();
      const { error } = await supabase.from("cloud_store").upsert(
        { id: rowId, owner: userId||null, data: payload, updated_at: new Date().toISOString() },
        { onConflict: "id" }
      );
      if (error) console.error("[cloud-sync] push error", error);
      else { lastSig = sig(str(payload)); localStorage.setItem("cloud_updated_at", new Date().toISOString()); console.log("[cloud-sync] pushed",{id:rowId,bytes:str(payload).length}); }
    }catch(e){ console.error("[cloud-sync] push fail", e); }
  }

  async function fetchServer(id){
    const { data, error } = await supabase.from("cloud_store").select("data,updated_at").eq("id", id).maybeSingle();
    return { data: data?.data, updated_at: data?.updated_at, error };
  }

  async function pull(id=rowId){
    try{
      const srv = await fetchServer(id);
      if (srv.error) { console.error("[cloud-sync] pull error", srv.error); return false; }
      if (!srv.data) { console.log("[cloud-sync] nothing to pull"); return false; }
      window.state = srv.data;
      const s = str(window.state);
      localStorage.setItem(STORAGE_KEY, s);
      localStorage.setItem("cloud_updated_at", srv.updated_at || new Date().toISOString());
      (window.save||(()=>{}))();
      location.reload();
      return true;
    }catch(e){ console.error("[cloud-sync] pull fail", e); return false; }
  }

  // Wrap save() and watch localStorage for STORAGE_KEY writes
  for (let i=0;i<100 && typeof window.save!=="function" && typeof window.state==="undefined"; i++) await wait(100);
  if (typeof window.save==="function" && !window.save.__wrapped_for_cloud__) {
    const _save = window.save;
    window.save = function(){ const r=_save.apply(this,arguments); clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,300); return r; };
    window.save.__wrapped_for_cloud__ = true;
  }
  if (!localStorage.__cloud_wrapped__) {
    const _set = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(k,v){ const r=_set(k,v); if (k===STORAGE_KEY) { clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,300); } return r; };
    localStorage.__cloud_wrapped__ = true;
  }
  // Audit loop catches silent changes
  setInterval(()=>{ const s = str(getLocalObj()); const sSig = sig(s); if (sSig!==lastSig){ clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,300); } }, 1500);
  addEventListener("visibilitychange", ()=>{ if (document.visibilityState==="hidden") push(); });

  // Reconcile on load: if signed-in, prefer server copy when it's newer/bigger
  (async ()=>{
    const localObj = getLocalObj();
    const localStr = str(localObj);
    const localBytes = localStr.length;
    if (userId){
      const srv = await fetchServer(userId);
      if (!srv.error && srv.data){
        const srvStr = str(srv.data);
        const newer = srv.updated_at && (!localStorage.getItem("cloud_updated_at") || new Date(srv.updated_at) > new Date(localStorage.getItem("cloud_updated_at")));
        const bigger = srvStr.length > localBytes + 50; // small buffer
        if (srvStr !== localStr && (newer || bigger)) {
          console.log("[cloud-sync] server newer/bigger → pulling");
          await pull(userId);
          return;
        }
      } else if (!localStorage.getItem(STORAGE_KEY)) {
        // Signed-in but no local or server value yet
        await pull(userId);
      }
    } else if (!localStorage.getItem(STORAGE_KEY)) {
      await pull(deviceId);
    }
  })();

  // Auto-migrate device → user on first sign-in, then reconcile
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
      // After sign-in always prefer server if different
      const srv = await fetchServer(newUserId);
      if (srv.data){
        const srvStr = str(srv.data); const locStr = str(getLocalObj());
        if (srvStr !== locStr) { console.log("[cloud-sync] reconciling after login"); await pull(newUserId); }
      }
    }
  });

  window.__cloud = { push, pull, id: rowId };
  console.log("[cloud-sync] ready", window.__cloud);
})();
