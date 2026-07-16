/* SpotWin frontend glue: Webamp (Winamp2 skin engine) + Tauri MPRIS bridge.
   The widget is borderless + transparent (set in tauri.conf.json). The Winamp
   title bar drags the whole window; EQ/PL windows are real Webamp windows that
   auto-resize the Tauri window when toggled. All transport/volume/seek is
   mirrored to Spotify via the Rust MPRIS bridge. */
(function () {
  "use strict";

  const DEFAULT_SKIN = "vendor/base-2.91.wsz";

  // Bundled skins, populated at runtime from sp_list_skins()
  let bundledSkins = [];
  let skinIndex = -1;
  let dragging = false;

  function invoke(cmd, args) {
    if (window.__TAURI__ && window.__TAURI__.core) {
      return window.__TAURI__.core.invoke(cmd, args || {});
    }
    console.warn("TAURI invoke unavailable for", cmd);
    return Promise.resolve(null);
  }

  // Tauri window handle (v2 API namespace)
  function tauriWindow() {
    try {
      return window.__TAURI__.window.getCurrentWindow();
    } catch (e) {
      return null;
    }
  }

  // ---- Webamp bootstrap ----
  const Webamp = window.Webamp;
  let webamp = null;

  function loadSkinUrl(url) {
    return new Promise((resolve, reject) => {
      try {
        webamp.setSkinFromUrl(url);
        resolve(true);
      } catch (e) {
        reject(e);
      }
    });
  }

  function boot(skinUrl) {
    webamp = new Webamp({
      initialSkin: { url: skinUrl },
      enableHotkeys: false,
      __initialWindowLayout: {
        main: { position: { x: 0, y: 0 } },
        equalizer: { position: { x: 0, y: 116 }, hidden: false },
        playlist: { position: { x: 0, y: 232 }, hidden: false },
      },
    });
    webamp.renderWhenReady(document.getElementById("app")).then(() => {
      bindWebampButtons();
      wireTitlebarDrag();
      wireSeekBar();
      wireVolumeBalance();
      pollLoop();
      refreshAdsButton();
      // keep Tauri window sized to whatever Webamp laid out
      syncWindowSize();
      subscribeWindowResize();
    });
  }

  // ---- map Spotify status -> Webamp display ----
  let lastTitle = "";
  function pushTrack(t) {
    if (!webamp) return;
    const meta = {
      title: t.title || "—",
      artist: t.artist || "Spotify",
      album: t.album || "",
      duration: (t.length || 0) * 1000,
    };
    try {
      webamp.setTracksToPlay([]); // ensure nothing auto-plays
      webamp.store.dispatch({ type: "SET_MEDIA_TAGS", ...meta });
      webamp.store.dispatch({
        type: "SET_DURATION",
        duration: Math.max(1, meta.duration),
      });
    } catch (e) {
      console.warn("pushTrack failed", e);
    }
  }

  // ---- poll Spotify via Rust MPRIS bridge ----
  async function pollLoop() {
    try {
      const t = await invoke("sp_status");
      if (t) {
        const now = t.artist + " — " + t.title;
        if (now !== lastTitle) {
          lastTitle = now;
          pushTrack(t);
        }
        try {
          webamp.store.dispatch({
            type: t.status === "Playing" ? "PLAY" : "PAUSE",
          });
        } catch (e) {}
        updateSeek(t);
      }
    } catch (e) {}
    setTimeout(pollLoop, 1000);
  }

  // ---- seek bar: reflect position + click/drag to seek ----
  let seekBar = null;
  let seeking = false;
  function ensureSeekBar() {
    if (seekBar) return;
    seekBar =
      document.querySelector(".position") ||
      document.querySelector('[class*="position-bar"]') ||
      document.querySelector('[class*="position"]');
  }
  function updateSeek(t) {
    if (!seekBar || !t || !t.length) return;
    const pct = Math.min(100, (t.position / t.length) * 100);
    seekBar.style.setProperty("--position", pct + "%");
  }
  function wireSeekBar() {
    ensureSeekBar();
    if (!seekBar) return;
    const doSeek = (clientX) => {
      const rect = seekBar.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      invoke("sp_status").then((t) => {
        if (!t || !t.length) return;
        invoke("sp_seek", { posSeconds: Math.round(frac * t.length) });
      });
    };
    seekBar.addEventListener("mousedown", (e) => {
      seeking = true;
      doSeek(e.clientX);
    });
    window.addEventListener("mousemove", (e) => {
      if (seeking) doSeek(e.clientX);
    });
    window.addEventListener("mouseup", () => {
      seeking = false;
    });
  }

  // ---- drag the whole widget by Webamp's title bar ----
  function wireTitlebarDrag() {
    const app = document.getElementById("app");
    const bar = app.querySelector(".title-bar") ||
      app.querySelector('[class*="title-bar"]');
    if (!bar) {
      console.warn("[spotwin] title-bar not found for drag");
      return;
    }
    bar.addEventListener("mousedown", (e) => {
      // let double-click (shade) and right-click (menu) behave natively
      if (e.button !== 0 || e.detail > 1) return;
      const w = tauriWindow();
      if (w && w.startDragging) {
        // startDragging takes over the drag; don't preventDefault so
        // Webamp's own title interactions still get a chance on dblclick
        try { w.startDragging(); } catch (err) { console.warn("drag failed", err); }
      }
    });
  }

  // ---- volume + balance: mirror Webamp sliders -> Spotify ----
  function wireVolumeBalance() {
    // Webamp dispatches VOLUME_SET / BALANCE_SET to its store; subscribe and
    // push the value to Spotify via playerctl volume (0..1).
    let lastVol = -1;
    webamp.store.subscribe(() => {
      const s = webamp.store.getState();
      const vol = s.media && typeof s.media.volume === "number" ? s.media.volume : null;
      if (vol !== null && vol !== lastVol) {
        lastVol = vol;
        invoke("sp_volume", { volume: Math.max(0, Math.min(1, vol)) })
          .catch(() => {});
      }
      // balance is informational only (Spotify has no L/R balance); ignore.
    });
  }

  // ---- size the Tauri window to fit only OPEN Webamp windows ----
  // Webamp keeps window visibility in its Redux store:
  //   state.windows.{main,equalizer,playlist}.open  (boolean)
  function syncWindowSize() {
    const w = tauriWindow();
    if (!w) return;
    let h = 116; // main player is always open
    try {
      const wins = webamp.store.getState().windows;
      if (wins.equalizer && wins.equalizer.open) h += 116;
      if (wins.playlist && wins.playlist.open) h += 116 + 42; // PL header + rows
    } catch (e) { /* store not ready */ }
    const height = Math.max(116, Math.min(640, h));
    try {
      w.setSize(new window.__TAURI__.window.LogicalSize(275, height));
    } catch (e) {
      console.warn("setSize failed", e);
    }
  }

  function subscribeWindowResize() {
    if (!webamp.store) return;
    webamp.store.subscribe(() => {
      // EQ/PL open/close change layout -> re-fit window next tick
      requestAnimationFrame(syncWindowSize);
    });
  }

  // ---- wire transport buttons (our bar + webamp's own) ----
  function bindWebampButtons() {
    const g = (id) => document.getElementById(id);
    if (g("btn-play")) g("btn-play").onclick = () => invoke("sp_toggle");
    if (g("btn-next")) g("btn-next").onclick = () => invoke("sp_next");
    if (g("btn-prev")) g("btn-prev").onclick = () => invoke("sp_prev");
    if (g("btn-skin")) g("btn-skin").onclick = () => cycleSkin(1);
    const sb = g("btn-skin-prev");
    if (sb) sb.onclick = () => cycleSkin(-1);
    const sn = g("btn-skin-next");
    if (sn) sn.onclick = () => cycleSkin(1);
    if (g("btn-ads")) g("btn-ads").onclick = onAdsClick;

    // Intercept Webamp's own transport clicks
    const app = document.getElementById("app");
    app.addEventListener("click", (e) => {
      const t = e.target;
      const cls = (t.className || "").toString();
      if (cls.includes("play") || cls.includes("pause")) {
        invoke("sp_toggle");
      } else if (cls.includes("next")) {
        invoke("sp_next");
      } else if (cls.includes("previous") || cls.includes("prev")) {
        invoke("sp_prev");
      }
    });
  }

  // ---- skin picker: cycle bundled skins, or open file dialog for custom ----
  async function loadBundledSkin(name) {
    try {
      const url = await invoke("sp_load_skin", { path: name });
      if (url) await loadSkinUrl(url);
    } catch (e) {
      console.warn("load bundled skin failed", name, e);
    }
  }

  async function refreshSkinList() {
    try {
      bundledSkins = (await invoke("sp_list_skins")) || [];
    } catch (e) {
      bundledSkins = [];
    }
  }

  async function cycleSkin(dir) {
    if (!bundledSkins.length) await refreshSkinList();
    if (!bundledSkins.length) {
      openSkinDialog();
      return;
    }
    if (skinIndex < 0) skinIndex = 0;
    else skinIndex = (skinIndex + dir + bundledSkins.length) % bundledSkins.length;
    await loadBundledSkin(bundledSkins[skinIndex]);
    const lbl = document.getElementById("btn-skin");
    if (lbl) lbl.title = "Skin: " + bundledSkins[skinIndex] + "  (◀/▶ to change)";
  }

  async function openSkinDialog() {
    try {
      const selected = await window.__TAURI__.dialog.open({
        multiple: false,
        filters: [{ name: "Winamp Skin", extensions: ["wsz"] }],
      });
      if (selected && typeof selected === "string") {
        const url = await invoke("sp_load_skin", { path: selected });
        if (url) await loadSkinUrl(url);
      }
    } catch (e) {
      console.warn("skin dialog failed", e);
    }
  }

  // ---- ad-block (spicetify) status + apply ----
  async function refreshAdsButton() {
    const btn = document.getElementById("btn-ads");
    if (!btn) return;
    try {
      const active = await invoke("sp_adblock_status");
      btn.style.borderColor = active ? "#0f0" : "#f33";
      btn.title = active
        ? "Spotify ad-block active (spicetify). Click to re-apply after a Spotify update."
        : "Spotify ad-block NOT active. Click to apply (spicetify). Needs spicetify + adblock.js.";
    } catch (e) {
      btn.title = "ad-block status unknown";
    }
  }

  async function onAdsClick() {
    const btn = document.getElementById("btn-ads");
    btn.textContent = "...";
    try {
      const res = await invoke("sp_adblock_apply");
      btn.textContent = "ADS";
      refreshAdsButton();
      console.log("[spotwin] adblock apply:", res);
    } catch (e) {
      btn.textContent = "ERR";
      console.warn("adblock apply failed", e);
      setTimeout(() => (btn.textContent = "ADS"), 1500);
    }
  }

  // ---- start ----
  boot(DEFAULT_SKIN);
})();
