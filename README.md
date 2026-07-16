# SpotWin

Spotify in a Winamp2 skin. A tiny Tauri 2 desktop app that wraps the Spotify
desktop client in the classic Winamp2 look (via [Webamp](https://github.com/captbaritone/webamp))
and drives playback through MPRIS (`playerctl`). Also ships a one-click button to
check / re-apply free-user ad-blocking (spicetify).

## What it does

- Renders a Winamp2 skin (ships `base-2.91.wsz` + 4 bundled custom skins) as a
  **borderless, always-on-top, standalone floating widget** — no OS window
  chrome. The Winamp title bar is the drag handle: grab it to move the widget
  anywhere.
- Equalizer and Playlist windows are real Webamp windows; toggle them with the
  skin's own EQ/PL buttons. The widget auto-resizes to fit whatever is open.
- Reads the currently playing Spotify track (title / artist / album / position /
  length / status) once a second and reflects it in the skin.
- Play/pause/next/prev work from either the floating control bar or the skin's
  own buttons. The seek bar is click/drag to seek. Volume slider drives Spotify.
- `SKIN` (◀ / ▶) cycles the bundled skins; clicking it also opens a file dialog
  to load any `.wsz` skin from disk.
- `ADS` shows whether spicetify ad-blocking is active (green border = on, red =
  off) and re-applies it on click.

Spotify itself still does the actual playback and audio. SpotWin is a controller
+ skin shell.

## How ad-blocking actually works

SpotWin does NOT patch Spotify itself. The real, working method on modern Linux
Spotify (1.2.x) is `spicetify` + an ad-block extension injected into the xpui.
The old `spotify-adblock` LD_PRELOAD shim crashes current Spotify — do not use it.

The `ADS` button in SpotWin just shells out to `spicetify` (already installed here):

1. `spicetify backup`            # one-time: detect + patch the install (~1 min)
2. `spicetify config extensions adblock.js`
3. `spicetify apply -e`          # apply + refresh extensions
4. restart Spotify

Spotify auto-updates via `spotify-launcher`, which overwrites the patched files.
When ads come back, click `ADS` in SpotWin (or run `spicetify apply -e`) to
re-patch. `sp_adblock_status` checks `spicetify config` for the `adblock.js` line.

## Requirements

- Spotify desktop client running (Linux), with MPRIS exposed.
- `playerctl` (control channel).
- `spicetify` + `adblock.js` (for the ADS button; the rest works without it).
- Rust toolchain + Tauri 2 CLI: `cargo install tauri-cli`.
- WebKit2GTK 4.1, GTK3, libsoup3 (already present on this Arch box).

## Build / run

    cd spotwin
    cargo tauri dev            # dev with hot reload
    cargo tauri build          # release bundle (.deb + .AppImage)

Note: building the release bundle needs `dpkg-deb`/`appimagetool` for packaging.
To just verify it compiles without packaging:

    cargo tauri build --no-bundle

## Layout

    spotwin/
      frontend/                # Webamp shell + Tauri bridge (index.html, app.js, style.css)
        vendor/webamp.bundle.min.js
        vendor/skins/          # base-2.91.wsz + 4 bundled custom .wsz skins
      src-tauri/
        src/main.rs            # Tauri commands: playback + skin load + adblock + volume
        tauri.conf.json        # borderless / transparent / alwaysOnTop / non-resizable
        capabilities/default.json
        icons/

## Tauri commands

    sp_play, sp_pause, sp_toggle, sp_next, sp_prev, sp_seek
    sp_volume(volume)         -> set Spotify volume 0..1 (playerctl volume)
    sp_status   -> { title, artist, album, length, position, status }
    sp_is_running
    sp_load_skin(path)         -> base64 data: URL for Webamp
    sp_list_skins()            -> bundled .wsz paths
    sp_adblock_status()        -> bool  (spicetify adblock.js enabled?)
    sp_adblock_apply()         -> "applied" | error  (spicetify apply -e)
