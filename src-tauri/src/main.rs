// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::fs;

/// Run a playerctl command scoped to the Spotify MPRIS player.
/// Returns stdout, or an error string.
fn playerctl(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("playerctl");
    cmd.arg("--player=Spotify");
    cmd.args(args);
    let out = cmd
        .output()
        .map_err(|e| format!("playerctl spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "playerctl error: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(serde::Serialize)]
struct Track {
    title: String,
    artist: String,
    album: String,
    length: u64, // seconds
    position: u64,
    status: String,
}

#[tauri::command]
fn sp_play() -> Result<(), String> {
    playerctl(&["play"]).map(|_| ())
}

#[tauri::command]
fn sp_pause() -> Result<(), String> {
    playerctl(&["pause"]).map(|_| ())
}

#[tauri::command]
fn sp_toggle() -> Result<(), String> {
    playerctl(&["play-pause"]).map(|_| ())
}

#[tauri::command]
fn sp_next() -> Result<(), String> {
    playerctl(&["next"]).map(|_| ())
}

#[tauri::command]
fn sp_prev() -> Result<(), String> {
    playerctl(&["previous"]).map(|_| ())
}

#[tauri::command]
fn sp_seek(pos_seconds: u64) -> Result<(), String> {
    playerctl(&["position", &format!("{pos_seconds}")]).map(|_| ())
}

#[tauri::command]
fn sp_status() -> Result<Track, String> {
    let title = playerctl(&["metadata", "title"]).unwrap_or_default();
    let artist = playerctl(&["metadata", "artist"]).unwrap_or_default();
    let album = playerctl(&["metadata", "album"]).unwrap_or_default();
    let status = playerctl(&["status"]).unwrap_or_else(|_| "Stopped".into());
    let length = playerctl(&["metadata", "mpris:length"])
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(|micros| micros / 1_000_000)
        .unwrap_or(0);
    let position = playerctl(&["position"])
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|secs| secs as u64)
        .unwrap_or(0);
    Ok(Track {
        title,
        artist,
        album,
        length,
        position,
        status,
    })
}

#[tauri::command]
fn sp_volume(volume: f64) -> Result<(), String> {
    // playerctl volume expects 0..1
    playerctl(&["volume", &format!("{:.3}", volume)]).map(|_| ())
}

#[tauri::command]
fn sp_is_running() -> bool {
    Command::new("playerctl")
        .args(["--player=Spotify", "status"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// List the bundled .wsz skins shipped under frontend/vendor/skins.
#[tauri::command]
fn sp_list_skins() -> Vec<String> {
    let mut skins = Vec::new();
    if let Ok(entries) = fs::read_dir(web_resource_dir().join("vendor/skins")) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "wsz").unwrap_or(false) {
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    skins.push(name.to_string());
                }
            }
        }
    }
    skins.sort();
    skins
}

/// Resolve the app's bundled frontend (web resource) directory at runtime.
fn web_resource_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("SPOTWIN_FRONTEND") {
        return std::path::PathBuf::from(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("../frontend");
            if candidate.exists() {
                return candidate.canonicalize().unwrap_or(candidate);
            }
        }
    }
    std::path::PathBuf::from("frontend")
}

/// Load a bundled skin (by filename inside vendor/skins) or an absolute path,
/// returning a Webamp-compatible base64 data URL.
#[tauri::command]
fn sp_load_skin(path: String) -> Result<String, String> {
    let resolved = if path.contains('/') || path.contains('\\') {
        std::path::PathBuf::from(&path)
    } else {
        web_resource_dir().join("vendor/skins").join(&path)
    };
    let bytes = fs::read(&resolved)
        .map_err(|e| format!("read skin {} failed: {e}", resolved.display()))?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:application/octet-stream;base64,{b64}"))
}

#[tauri::command]
fn sp_adblock_status() -> bool {
    // True when the spicetify adblock extension is enabled in the config.
    let out = Command::new("spicetify")
        .args(["config"])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout);
            text.lines()
                .any(|l| l.contains("adblock.js") && !l.trim().starts_with('#'))
        }
        _ => false,
    }
}

#[tauri::command]
fn sp_adblock_apply() -> Result<String, String> {
    // Re-apply the spicetify patch + extensions (re-runs after a Spotify update).
    // `apply -e` refreshes extensions too.
    let out = Command::new("spicetify")
        .args(["apply", "-e"])
        .output()
        .map_err(|e| format!("spicetify spawn failed: {e}"))?;
    if out.status.success() {
        Ok("applied".into())
    } else {
        Err(format!(
            "spicetify apply failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            sp_play,
            sp_pause,
            sp_toggle,
            sp_next,
            sp_prev,
            sp_seek,
            sp_status,
            sp_volume,
            sp_is_running,
            sp_load_skin,
            sp_list_skins,
            sp_adblock_status,
            sp_adblock_apply
        ])
        .run(tauri::generate_context!())
        .expect("error while running spotwin");
}
