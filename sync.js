// /sync.js — Supabase cloud-sync shim (V2.1: auth-aware + auto-migrate + robust autosave)
(async () => {
  const NS = "SUPA_SYNC_V21"; if (window[NS]) return; window[NS] = true;

  const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
  const STORAGE_KEY = window.STORAGE_KEY || "yield_focus_v2";

  // Reuse page client if present; otherwise create one
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

  // Session & ids
  let session = (await supabase.auth.getSession()).data?.session || null;
  const userId   = session?.user?.id || null;
  const deviceId = localStorage.getItem("mc_device_id") || (localStorage.setItem("mc_device_id", crypto.randomUUID()), localStorage.getItem("mc_device_id"));
  let rowId = userId || deviceId;

  const getLocal = () => {
    try { return window.state ?? JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  };

  // Push / pull
  let lastSig = "";
  const signature = () => {
    const s = localStorage.getItem(STORAGE_KEY) || JSON.stringify(window.state||{});
    return s ? s.length + ":" + s.slice(0,64) + ":" + s.slice(-64) : "0:";
  };

  let pushTimer=null;
  const schedulePush = ()=>{ clearTimeout(pushTimer); pushTimer = setTimeout(push, 300); };

  async function push(){
    try{
      const payload = getLocal();
      const { error } = await supabase
        .from("cloud_store")
        .upsert({ id: rowId, owner: userId||null, data: payload, updated_at: new Date().toISOString() }, { onConflict:"id" });
      if (error) console.error("[cloud-sync] push error", error);
      else { lastSig = signature(); console.log("[cloud-sync] pushed", { id: rowId, bytes: JSON.stringify(payload).length }); }
    }catch(e){ console.error("[cloud-sync] push fail", e); }
  }

  async function pull(id=rowId){
    try{
      const { data, error } = await supabase.from("cloud_store").select("data,updated_at").eq("id", id).maybeSingle();
      if (error) { console.error("[cloud-sync] pull error", error); return false; }
      if (!data?.data) { console.log("[cloud-sync] nothing to pull"); return false; }
      window.state = data.data;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(window.state));
      (window.save||(()=>{}))();
      location.reload();
      return true;
    }catch(e){ console.error("[cloud-sync] pull fail", e); return false; }
  }

  // Hook save()
  for (let i=0;i<100 && typeof window.save!=="function" && typeof window.state==="undefined"; i++) await wait(100);
  if (typeof window.save==="function" && !window.save.__wrapped_for_cloud__) {
    const _save = window.save;
    window.save = function(){ const r=_save.apply(this, arguments); schedulePush(); return r; };
    window.save.__wrapped_for_cloud__ = true;
  }

  // Hook localStorage.setItem for STORAGE_KEY writes
  if (!localStorage.__cloud_wrapped__) {
    const _set = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(k,v){ const r=_set(k,v); if (k===STORAGE_KEY) schedulePush(); return r; };
    localStorage.__cloud_wrapped__ = true;
  }

  // Audit loop: catch any silent changes
  setInterval(()=>{ const sig = signature(); if (sig!==lastSig) schedulePush(); }, 1500);

  // Best-effort push on leave
  addEventListener("visibilitychange", ()=>{ if (document.visibilityState==="hidden") push(); });
  addEventListener("pagehide", ()=>{ try { navigator.sendBeacon && navigator.sendBeacon("/.noop","1"); } catch {} });

  // First-time restore
  if (!localStorage.getItem(STORAGE_KEY)) {
    const triedUser = userId ? await pull(userId) : false;
    if (!triedUser) await pull(deviceId);
  }

  // Auto-migrate device → user on first sign-in
  supabase.auth.onAuthStateChange(async (event, newSession) => {
    if (event === "SIGNED_IN" && newSession?.user?.id) {
      session = newSession;
      const newUserId = newSession.user.id;
      if (rowId !== newUserId) {
        const { data: devRow } = await supabase.from("cloud_store").select("data").eq("id", rowId).maybeSingle();
        if (devRow?.data) {
          await supabase.from("cloud_store").upsert({
            id:newUserId, owner:newUserId, data:devRow.data, updated_at:new Date().toISOString()
          }, { onConflict:"id" });
        }
        rowId = newUserId;
        localStorage.setItem("mc_device_id", newUserId);
        console.log("[cloud-sync] switched to user id", newUserId);
        if (!localStorage.getItem(STORAGE_KEY)) await pull(newUserId);
      }
    }
  });

  // Debug handle
  window.__cloud = { push, pull, id: rowId };
  console.log("[cloud-sync] ready", window.__cloud);
})();
