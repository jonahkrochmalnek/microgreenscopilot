// /sync.js — Supabase cloud-sync shim (table: public.cloud_store)
(async () => {
  const NS = "SUPA_SYNC_V1";
  if (window[NS]) return; window[NS] = true;

  function appReady(){ return typeof window.save === "function" || typeof window.state !== "undefined"; }
  function onReady(fn){
    if (appReady()) return fn();
    const t0=Date.now(), i=setInterval(()=>{ if(appReady()||Date.now()-t0>10000){ clearInterval(i); if(appReady()) fn(); } },100);
  }

  onReady(async () => {
    let supabase = window.supabase;
    if (!supabase) {
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
      supabase = createClient(
        "https://glxzjcqbvyimlwlyauws.supabase.co",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdseHpqY3FidnlpbWx3bHlhdXdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYxMzc1NjQsImV4cCI6MjA3MTcxMzU2NH0.L_Dfhz_ZxVIC2i7B55ZpZALSrgR7JffPwwRtJLn6Wbo"
      );
      window.supabase = supabase;
    }

    const STORAGE_KEY = window.STORAGE_KEY || "yield_focus_v2";
    const session = (await supabase.auth.getSession()).data?.session || null;

    let rowId = window.CLOUD_ID || session?.user?.id || localStorage.getItem("mc_device_id");
    if (!rowId) { rowId = crypto.randomUUID(); }
    localStorage.setItem("mc_device_id", rowId);

    async function push(){
      try{
        const payload = window.state || JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        const { error } = await supabase.from("cloud_store").upsert(
          { id: rowId, owner: session?.user?.id || null, data: payload, updated_at: new Date().toISOString() },
          { onConflict: "id" }
        );
        if (error) console.error("[cloud-sync] push error", error); else console.log("[cloud-sync] pushed");
      }catch(e){ console.error("[cloud-sync] push fail", e); }
    }

    async function pull(){
      try{
        const { data, error } = await supabase.from("cloud_store").select("data,updated_at").eq("id",rowId).maybeSingle();
        if (error) return console.error("[cloud-sync] pull error", error);
        if (!data?.data) return console.log("[cloud-sync] nothing to pull");
        window.state = data.data;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(window.state));
        (window.save||(()=>{}))(); location.reload();
      }catch(e){ console.error("[cloud-sync] pull fail", e); }
    }

    if (typeof window.save === "function" && !window.save.__wrapped_for_cloud__){
      const _save = window.save;
      window.save = function(){ const r=_save.apply(this,arguments); clearTimeout(window.__supaPushT); window.__supaPushT=setTimeout(push,200); return r; };
      window.save.__wrapped_for_cloud__ = true;
    }

    if (!localStorage.getItem(STORAGE_KEY)) await pull();

    window.__cloud = { push, pull, id: rowId };
    console.log("[cloud-sync] ready", window.__cloud);
  });
})();
