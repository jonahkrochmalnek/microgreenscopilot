// /sync.js — V2.9 (loop-proof): kill-switch, single pull, server/local echo to avoid repeat pulls.
;(async () => {
  const STORAGE_KEY = "yield_focus_v2";
  const SYNC_MARK   = "cloud_updated_at";       // local echo of server updated_at
  const DISABLE_KEY = "__sync_disabled";        // local kill-switch

  // 0) Kill-switch (query or local flag)
  const qs = new URLSearchParams(location.search);
  if (qs.get("nosync")==="1" || localStorage.getItem(DISABLE_KEY)==="1") {
    window.__cloud = {
      push: async ()=>console.warn("[cloud-sync] disabled"),
      pull: async ()=>console.warn("[cloud-sync] disabled"),
      getIds: async ()=>({}),
      disable(){ localStorage.setItem(DISABLE_KEY,"1"); },
      enable(){ localStorage.removeItem(DISABLE_KEY); }
    };
    console.warn("[cloud-sync] disabled by flag (?nosync=1 or __sync_disabled=1)");
    return;
  }

  // 1) Ensure Supabase client is available
  function loadUMD(){
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
      s.async = false;
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  if (!window.supabase?.createClient) { try { await loadUMD(); } catch(e){ console.error("[cloud-sync] failed to load supabase-js", e); return; } }

  const SUPABASE_URL  = "https://glxzjcqbvyimlwlyauws.supabase.co";
  const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdseHpqY3FidnlpbWx3bHlhdXdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYxMzc1NjQsImV4cCI6MjA3MTcxMzU2NH0.L_Dfhz_ZxVIC2i7B55ZpZALSrgR7JffPwwRtJLn6Wbo";
  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  window.supabase = supabase;

  // 2) Helpers
  const readLocal  = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}"); } catch { return {}; } };
  const writeLocal = (obj) => localStorage.setItem(STORAGE_KEY, JSON.stringify(obj||{}));
  const localBytes = ()   => (localStorage.getItem(STORAGE_KEY)||"").length;

  async function getIds(){
    const { data } = await supabase.auth.getUser();
    const userId = data?.user?.id || null;
    let deviceId = localStorage.getItem("mc_device_id");
    if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem("mc_device_id", deviceId); }
    return { id: userId || deviceId, owner: userId || null, userId, deviceId };
  }

  async function fetchServer(id){
    const { data, error } = await supabase.from("cloud_store")
      .select("id, data, updated_at").eq("id", id).maybeSingle();
    if (error) return { error };
    return { row: data || null };
  }

  async function push(){
    const { id, owner } = await getIds();
    const nowISO = new Date().toISOString();
    const obj = readLocal();
    const { error } = await supabase.from("cloud_store")
      .upsert({ id, owner, data: obj, updated_at: nowISO }, { onConflict: "id" });
    if (error) { console.error("[cloud-sync] push error", error); throw error; }
    localStorage.setItem(SYNC_MARK, nowISO);
    console.log("[cloud-sync] pushed", { id, bytes: localBytes() });
  }

  async function pull(){
    const { id } = await getIds();
    const { row, error } = await fetchServer(id);
    if (error) { console.error("[cloud-sync] pull error", error); throw error; }
    if (!row || !row.data) { console.log("[cloud-sync] nothing to pull"); return; }

    // Prevent the app from overwriting restored data during first boot
    sessionStorage.setItem("cloud_restoring","1");
    writeLocal(row.data);
    localStorage.setItem(SYNC_MARK, row.updated_at || "");

    // Mark which version we just restored to avoid re-pulling
    sessionStorage.setItem("cloud_restored", row.updated_at || "");

    // Reload once (replace avoids history back-loop)
    location.replace(location.pathname + location.search + location.hash);
  }

  // 3) Expose API early
  window.__cloud = { push, pull, getIds,
    disable(){ localStorage.setItem(DISABLE_KEY,"1"); },
    enable(){ localStorage.removeItem(DISABLE_KEY); }
  };

  // 4) One-time reconcile (loop-proof)
  try {
    const { id } = await getIds();
    const localEcho   = localStorage.getItem(SYNC_MARK) || "";
    const localEmpty  = localBytes() < 3;
    const { row }     = await fetchServer(id);
    const serverTS    = row?.updated_at || "";

    // If we just restored this server version in this session, skip doing it again
    if (sessionStorage.getItem("cloud_restored") === serverTS) {
      setTimeout(()=>sessionStorage.removeItem("cloud_restored"), 1200);
      console.log("[cloud-sync] already restored this version; skipping");
    } else if (serverTS && serverTS !== localEcho) {
      console.log("[cloud-sync] reconcile: server>local → pull once");
      await pull(); return;
    } else if (!serverTS && !localEmpty) {
      console.log("[cloud-sync] reconcile: local>server → push");
      await push();
    } else {
      console.log("[cloud-sync] ready (in sync)", { id, serverTS, localEcho, bytes: localBytes() });
    }
  } catch (e) {
    console.error("[cloud-sync] init error", e);
  }

  // 5) Shield for ~1.2s after restore so app defaults don't clobber local
  if (sessionStorage.getItem("cloud_restoring")==="1") {
    const origSet = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (k,v)=>{ if (k!==STORAGE_KEY) origSet(k,v); };
    setTimeout(()=>{ localStorage.setItem = origSet; sessionStorage.removeItem("cloud_restoring"); }, 1200);
  }
})();
