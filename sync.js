// /sync.js — V2.4R2: server-wins + safe autosave + reload-on-pull + guard handoff
(async () => {
  const NS = "SUPA_SYNC_V24R2";
  if (window[NS]) return; window[NS] = true;

  const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
  const STORAGE_KEY = window.STORAGE_KEY || "yield_focus_v2";
  const J = (o)=>JSON.stringify(o||{});
  const P = (s)=>{ try { return JSON.parse(s); } catch { return {}; } };
  const sig = (s)=> s ? (s.length+":"+s.slice(0,64)+":"+s.slice(-64)) : "0:";

  // If edge guard wrapped localStorage, restore the original setter now.
  if (localStorage.__guarded) {
    try { localStorage.setItem = localStorage.__guarded; delete localStorage.__guarded; } catch {}
  }

  // Push suppression during reconcile/restore
  let suppressPush = true;
  let lastSig = sig(localStorage.getItem(STORAGE_KEY)||"");

  // Reuse app client if present; else create one
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

  const getLocal = () => (typeof window.state !== "undefined") ? window.state : P(localStorage.getItem(STORAGE_KEY)||"{}");

  async function fetchServer(id){
    const { data, error } = await supabase
      .from("cloud_store")
      .select("data, updated_at")
      .eq("id", id)
      .maybeSingle();
    return { data: data?.data, updated_at: data?.updated_at, error };
  }

  function applyServer(data, updated_at){
    // Write server -> local and force reload so UI boots from server copy.
    suppressPush = true;
    sessionStorage.setItem("cloud_restoring","1"); // survive reload
    window.state = data;
    const s = J(data);
    localStorage.setItem(STORAGE_KEY, s);
    localStorage.setItem("cloud_updated_at", updated_at || new Date().toISOString());
    lastSig = sig(s);
    (window.save||(()=>{}))();
    location.reload();
  }

  async function push(){
    if (suppressPush) return;
    const payload = getLocal();
    const s = J(payload);
    const sSig = sig(s);
    if (sSig === lastSig) return;
    const { error } = await supabase
      .from("cloud_store")
      .upsert({ id: rowId, owner: userId||null, data: payload, updated_at: new Date().toISOString() }, { onConflict:"id" });
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

  // Wait for app globals a bit, then hook save & STORAGE_KEY writes
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

  // Reconcile on load: SERVER WINS (when signed in)
  (async ()=>{
    const localStr = J(getLocal());
    lastSig = sig(localStr);

    if (userId){
      const srv = await fetchServer(userId);
      if (!srv.error && srv.data){
        const srvStr = J(srv.data);
        const differ = srvStr !== localStr;
        const newer  = srv.updated_at && (!localStorage.getItem("cloud_updated_at") || new Date(srv.updated_at) > new Date(localStorage.getItem("cloud_updated_at")));
        const bigger = srvStr.length > localStr.length;
        if (differ && (newer || bigger)){
          console.log("[cloud-sync] reconcile: server>local → pulling");
          applyServer(srv.data, srv.updated_at);   // reloads; suppression remains during boot
          return;
        }
      }
      suppressPush = false;
    } else {
      if (!localStorage.getItem(STORAGE_KEY)) await pull(deviceId);
      suppressPush = false;
    }
  })();

  // Auto-migrate device → user on sign-in, then reconcile again
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
      const srv = await fetchServer(newUserId);
      if (srv.data){
        const srvStr = J(srv.data), locStr = J(getLocal());
        if (srvStr !== locStr) {
          console.log("[cloud-sync] reconcile after login → pulling");
          applyServer(srv.data, srv.updated_at);   // reloads
          return;
        }
      }
      suppressPush = false;
    }
  });

  // Expose debug handle
  window.__cloud = { push, pull, id: rowId };
  window.__cloud_ready = true;                     // <-- let the guard release
  console.log("[cloud-sync] ready", window.__cloud);
})();
