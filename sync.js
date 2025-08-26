// /sync.js — V2.8 (simple & robust): ensures Supabase, defines window.__cloud,
// auto-reconciles, and logs errors instead of exiting early.
;(async () => {
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

  const STORAGE_KEY = "yield_focus_v2";
  const SUPABASE_URL = "https://glxzjcqbvyimlwlyauws.supabase.co";
  const SUPABASE_ANON= "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdseHpqY3FidnlpbWx3bHlhdXdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYxMzc1NjQsImV4cCI6MjA3MTcxMzU2NH0.L_Dfhz_ZxVIC2i7B55ZpZALSrgR7JffPwwRtJLn6Wbo";

  // 0) Reuse if already initialized
  if (window.__cloud && typeof window.__cloud === "object") {
    console.log("[cloud-sync] already ready", window.__cloud);
    return;
  }

  // 1) Ensure Supabase global exists (load UMD if needed)
  if (!window.supabase?.createClient) {
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
        s.async = false;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    } catch (e) {
      console.error("[cloud-sync] failed to load supabase-js UMD", e);
      return;
    }
  }
  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  window.supabase = supabase; // make sure it’s globally available for your app

  // 2) Helpers
  function readLocal(){
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }
  function writeLocal(obj){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj || {}));
  }
  function localBytes(){ return (localStorage.getItem(STORAGE_KEY) || "").length; }

  async function getIds(){
    const { data } = await supabase.auth.getUser();
    const userId = data?.user?.id || null;
    let deviceId = localStorage.getItem("mc_device_id");
    if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem("mc_device_id", deviceId); }
    const id = userId || deviceId;
    const owner = userId || null;
    return { id, owner, userId, deviceId };
  }

  async function fetchServer(id){
    const { data, error } = await supabase
      .from("cloud_store")
      .select("id, data, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) return { error };
    return { row: data || null };
  }

  async function push(){
    const { id, owner } = await getIds();
    const obj = readLocal();
    // keep a simple local timestamp to compare if needed
    const nowISO = new Date().toISOString();
    try {
      const { error } = await supabase
        .from("cloud_store")
        .upsert({ id, owner, data: obj, updated_at: nowISO }, { onConflict: "id" });
      if (error) throw error;
      console.log("[cloud-sync] pushed", { id, bytes: localBytes() });
    } catch (e) {
      console.error("[cloud-sync] push error", e);
      throw e;
    }
  }

  async function pull(){
    const { id } = await getIds();
    const { row, error } = await fetchServer(id);
    if (error) { console.error("[cloud-sync] pull error", error); throw error; }
    if (!row || !row.data) { console.log("[cloud-sync] nothing to pull"); return; }
    // Shield app’s first-boot defaults from overwriting restored data
    sessionStorage.setItem("cloud_restoring","1");
    writeLocal(row.data);
    console.log("[cloud-sync] pulled", { id, bytes: localBytes() });
    // Give the page a clean boot from restored state
    location.reload();
  }

  // 3) Expose API
  window.__cloud = { push, pull, getIds };

  // 4) Auto reconcile once on load
  try {
    const { id } = await getIds();
    const local = readLocal();
    const localUpdated = 0; // not persisted in object; we rely on server updated_at
    const { row } = await fetchServer(id);
    const serverUpdated = row?.updated_at ? Date.parse(row.updated_at) : 0;
    console.log("[cloud-sync] ready", { id, localBytes: localBytes(), serverUpdated });
    if (serverUpdated > 0) {
      console.log("[cloud-sync] reconcile: server>local → pulling");
      await pull();
    } else if (localBytes() > 2) {
      console.log("[cloud-sync] reconcile: local>server → pushing");
      await push();
    }
  } catch (e) {
    console.error("[cloud-sync] init error", e);
  }
})();
