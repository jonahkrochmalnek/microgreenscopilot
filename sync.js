// /sync.js — Supabase cloud-sync shim (V2: auth-aware + auto-migrate)
// Saves your entire app state (the same object your app writes to localStorage)
// into a single row in public.cloud_store, keyed by user id (if signed in) or
// a per-device id otherwise.

(async () => {
  const NS = "SUPA_SYNC_V2";
  if (window[NS]) return;
  window[NS] = true;

  // --- tiny helpers ---------------------------------------------------------
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const STORAGE_KEY = window.STORAGE_KEY || "yield_focus_v2";

  // Wait until app exposes either `save()` or `state` (max ~10s)
  async function waitForAppReady() {
    for (let i = 0; i < 100; i++) {
      if (typeof window.save === "function" || typeof window.state !== "undefined") return true;
      await wait(100);
    }
    return false;
  }

  // --- get supabase client (reuse page client if possible) ------------------
  let supabase = window.supabase;
  // Wait up to ~3s for the page's own client to appear to avoid duplicate clients
  for (let i = 0; i < 30 && !supabase; i++) { await wait(100); supabase = window.supabase; }
  if (!supabase) {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(
      "https://glxzjcqbvyimlwlyauws.supabase.co",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdseHpqY3FidnlpbWx3bHlhdXdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYxMzc1NjQsImV4cCI6MjA3MTcxMzU2NH0.L_Dfhz_ZxVIC2i7B55ZpZALSrgR7JffPwwRtJLn6Wbo"
    );
    // expose so your app/console can use it too
    window.supabase = supabase;
  }

  // --- pick IDs -------------------------------------------------------------
  let session = (await supabase.auth.getSession()).data?.session || null;
  const userId   = session?.user?.id || null;
  const deviceId = localStorage.getItem("mc_device_id") || (localStorage.setItem("mc_device_id", crypto.randomUUID()), localStorage.getItem("mc_device_id"));

  // Active row id prefers the user id when available
  let rowId = userId || deviceId;

  // --- push / pull ----------------------------------------------------------
  async function push() {
    try {
      const payload = window.state || JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const { error } = await supabase
        .from("cloud_store")
        .upsert(
          { id: rowId, owner: userId || null, data: payload, updated_at: new Date().toISOString() },
          { onConflict: "id" }
        );
      if (error) console.error("[cloud-sync] push error", error);
      else console.log("[cloud-sync] pushed");
    } catch (e) {
      console.error("[cloud-sync] push fail", e);
    }
  }

  async function pull(id = rowId) {
    try {
      const { data, error } = await supabase
        .from("cloud_store")
        .select("data, updated_at")
        .eq("id", id)
        .maybeSingle();
      if (error) { console.error("[cloud-sync] pull error", error); return false; }
      if (!data?.data) { console.log("[cloud-sync] nothing to pull"); return false; }
      window.state = data.data;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(window.state));
      (window.save || (() => {}))();      // keep any side-effects your app expects
      location.reload();                  // simple way to re-render consistently
      return true;
    } catch (e) {
      console.error("[cloud-sync] pull fail", e);
      return false;
    }
  }

  // --- wrap app save() so edits auto-push -----------------------------------
  async function wrapSaveWhenReady() {
    await waitForAppReady();
    if (typeof window.save === "function" && !window.save.__wrapped_for_cloud__) {
      const _save = window.save;
      window.save = function () {
        const r = _save.apply(this, arguments);
        clearTimeout(window.__supaPushT);
        window.__supaPushT = setTimeout(push, 300);
        return r;
      };
      window.save.__wrapped_for_cloud__ = true;
    }
  }
  wrapSaveWhenReady();

  // --- first run behavior ---------------------------------------------------
  // If this browser has no local data yet, try to restore from cloud:
  //   1) pull user row if signed in; else
  //   2) pull device row
  if (!localStorage.getItem(STORAGE_KEY)) {
    const triedUser = userId ? await pull(userId) : false;
    if (!triedUser) await pull(deviceId);
  }

  // --- auto-migrate device row → user row on first sign-in ------------------
  supabase.auth.onAuthStateChange(async (event, newSession) => {
    if (event === "SIGNED_IN" && newSession?.user?.id) {
      session = newSession;
      const newUserId = newSession.user.id;

      if (rowId !== newUserId) {
        // copy any existing device data into the user row
        const { data: devRow } = await supabase
          .from("cloud_store")
          .select("data")
          .eq("id", rowId)     // current active id (likely device)
          .maybeSingle();

        if (devRow?.data) {
          await supabase.from("cloud_store").upsert({
            id: newUserId,
            owner: newUserId,
            data: devRow.data,
            updated_at: new Date().toISOString()
          }, { onConflict: "id" });
        }

        rowId = newUserId;
        localStorage.setItem("mc_device_id", newUserId); // keep future sessions consistent
        console.log("[cloud-sync] switched to user id", newUserId);

        // If local still empty right after sign-in, try to pull user row
        if (!localStorage.getItem(STORAGE_KEY)) await pull(newUserId);
      }
    }
  });

  // --- expose manual controls ----------------------------------------------
  window.__cloud = { push, pull, id: rowId };
  console.log("[cloud-sync] ready", window.__cloud);
})();
