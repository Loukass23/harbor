// Lets a TV on the LAN find this Harbor, pair with it and receive a settings
// payload. The TV cannot host anything, so it calls in over the 11471 web
// server: it asks to pair, the desktop user compares a code and approves, and
// the TV collects the approval by polling. Approval issues a token that gates
// the routes which act on this machine (starting the stream server). Imports
// never ride on the token: each one goes through the approval dialog, because
// the payload carries account keys.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

pub const PROTOCOL: u32 = 1;
const REQUEST_TTL: Duration = Duration::from_secs(120);
const MAX_PENDING: usize = 3;
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub device_id: String,
    pub name: String,
    pub token_hash: String,
    pub paired_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    instance_id: String,
    #[serde(default)]
    paired: Vec<PairedDevice>,
}

#[derive(Debug, Clone, PartialEq)]
enum Outcome {
    Pending,
    Approved {
        token: String,
        payload: serde_json::Value,
    },
    Denied,
}

#[derive(Debug, Clone)]
struct PendingRequest {
    device_id: String,
    device_name: String,
    created: Instant,
    outcome: Outcome,
}

/// What a poll sees. `Approved` carries the token and payload exactly once.
#[derive(Debug, PartialEq)]
pub enum PollState {
    Pending,
    Approved {
        token: String,
        payload: serde_json::Value,
    },
    Denied,
    Expired,
}

#[derive(Debug, PartialEq)]
pub enum RequestError {
    Invalid,
    Busy,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequestEvent {
    pub request_id: String,
    pub device_id: String,
    pub device_name: String,
    pub code: String,
    pub repeat: bool,
}

/// The pairing state, free of Tauri so it can be tested on its own.
#[derive(Default)]
pub struct Pairing {
    pending: HashMap<String, PendingRequest>,
    paired: Vec<PairedDevice>,
}

fn valid_device_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn valid_code(code: &str) -> bool {
    code.len() == 4 && code.chars().all(|c| c.is_ascii_digit())
}

fn clean_name(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn random_hex(uuids: usize) -> String {
    (0..uuids)
        .map(|_| uuid::Uuid::new_v4().simple().to_string())
        .collect()
}

pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Pairing {
    fn prune(&mut self, now: Instant) -> Vec<String> {
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, r)| now.duration_since(r.created) >= REQUEST_TTL)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            self.pending.remove(id);
        }
        expired
    }

    /// Opens a request. A device that asks again replaces its own open
    /// request, so a TV that restarted pairing is never locked out by itself.
    /// Returns the event for the desktop and the ids of requests it closed.
    pub fn request(
        &mut self,
        device_id: &str,
        device_name: &str,
        code: &str,
        now: Instant,
    ) -> Result<(PairRequestEvent, Vec<String>), RequestError> {
        let name = clean_name(device_name).ok_or(RequestError::Invalid)?;
        if !valid_device_id(device_id) || !valid_code(code) {
            return Err(RequestError::Invalid);
        }
        let mut closed = self.prune(now);
        let replaced: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, r)| r.device_id == device_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &replaced {
            self.pending.remove(id);
        }
        closed.extend(replaced);
        if self.pending.len() >= MAX_PENDING {
            return Err(RequestError::Busy);
        }
        let request_id = random_hex(1);
        self.pending.insert(
            request_id.clone(),
            PendingRequest {
                device_id: device_id.to_string(),
                device_name: name.clone(),
                created: now,
                outcome: Outcome::Pending,
            },
        );
        let repeat = self.paired.iter().any(|p| p.device_id == device_id);
        Ok((
            PairRequestEvent {
                request_id,
                device_id: device_id.to_string(),
                device_name: name,
                code: code.to_string(),
                repeat,
            },
            closed,
        ))
    }

    /// Records the desktop user's answer. Approval issues a fresh token; a
    /// device that pairs again (say after a reinstall) replaces its old one.
    /// Returns true when the paired list changed and needs saving.
    pub fn resolve(
        &mut self,
        request_id: &str,
        approved: bool,
        payload: serde_json::Value,
        now: Instant,
    ) -> Result<bool, String> {
        self.prune(now);
        let request = self
            .pending
            .get_mut(request_id)
            .ok_or_else(|| "request expired".to_string())?;
        if request.outcome != Outcome::Pending {
            return Err("request already answered".into());
        }
        if !approved {
            request.outcome = Outcome::Denied;
            return Ok(false);
        }
        let token = random_hex(2);
        self.paired.retain(|p| p.device_id != request.device_id);
        self.paired.push(PairedDevice {
            device_id: request.device_id.clone(),
            name: request.device_name.clone(),
            token_hash: hash_token(&token),
            paired_at: now_secs(),
        });
        request.outcome = Outcome::Approved { token, payload };
        Ok(true)
    }

    pub fn poll(&mut self, request_id: &str, now: Instant) -> PollState {
        self.prune(now);
        let Some(request) = self.pending.get(request_id) else {
            return PollState::Expired;
        };
        match request.outcome.clone() {
            Outcome::Pending => PollState::Pending,
            Outcome::Denied => {
                self.pending.remove(request_id);
                PollState::Denied
            }
            Outcome::Approved { token, payload } => {
                self.pending.remove(request_id);
                PollState::Approved { token, payload }
            }
        }
    }

    pub fn authorize(&self, token: &str) -> bool {
        let hash = hash_token(token);
        self.paired.iter().any(|p| p.token_hash == hash)
    }

    pub fn forget(&mut self, device_id: &str) -> bool {
        let before = self.paired.len();
        self.paired.retain(|p| p.device_id != device_id);
        before != self.paired.len()
    }
}

struct Store {
    instance_id: String,
    path: Option<PathBuf>,
    pairing: Pairing,
}

fn store_slot() -> &'static Mutex<Option<Store>> {
    static S: OnceLock<Mutex<Option<Store>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn changed() -> &'static Notify {
    static N: OnceLock<Notify> = OnceLock::new();
    N.get_or_init(Notify::new)
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("companion.json"))
}

fn save(store: &Store) {
    let Some(path) = &store.path else { return };
    let file = StoreFile {
        instance_id: store.instance_id.clone(),
        paired: store.pairing.paired.clone(),
    };
    let Ok(text) = serde_json::to_string_pretty(&file) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text.as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn with_store<T>(app: &AppHandle, f: impl FnOnce(&mut Store) -> T) -> T {
    let mut guard = store_slot().lock().unwrap();
    let store = guard.get_or_insert_with(|| {
        let path = store_path(app);
        let file: StoreFile = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let fresh = file.instance_id.is_empty();
        let store = Store {
            instance_id: if fresh { random_hex(1) } else { file.instance_id },
            path,
            pairing: Pairing {
                pending: HashMap::new(),
                paired: file.paired,
            },
        };
        if fresh {
            save(&store);
        }
        store
    });
    f(store)
}

fn device_name() -> String {
    #[cfg(desktop)]
    {
        crate::harbor_lan::identity().name
    }
    #[cfg(not(desktop))]
    {
        "Harbor".to_string()
    }
}

pub fn identity(app: &AppHandle) -> serde_json::Value {
    let instance_id = with_store(app, |s| s.instance_id.clone());
    let (running, port, _) = crate::torrent_engine::lan_status();
    serde_json::json!({
        "app": "harbor",
        "proto": PROTOCOL,
        "instanceId": instance_id,
        "name": device_name(),
        "platform": std::env::consts::OS,
        "version": env!("CARGO_PKG_VERSION"),
        "streamServer": { "running": running, "port": port },
    })
}

pub fn request(
    app: &AppHandle,
    device_id: &str,
    device_name: &str,
    code: &str,
) -> Result<String, RequestError> {
    let (event, closed) = with_store(app, |s| {
        s.pairing
            .request(device_id, device_name, code, Instant::now())
    })?;
    for request_id in closed {
        let _ = app.emit(
            "companion://pair-closed",
            serde_json::json!({ "requestId": request_id }),
        );
    }
    let request_id = event.request_id.clone();
    let _ = app.emit("companion://pair-request", &event);
    Ok(request_id)
}

pub fn poll(app: &AppHandle, request_id: &str) -> PollState {
    with_store(app, |s| s.pairing.poll(request_id, Instant::now()))
}

/// Waits until the request is answered or `wait` passes.
pub async fn poll_wait(app: &AppHandle, request_id: &str, wait: Duration) -> PollState {
    let deadline = Instant::now() + wait;
    loop {
        let notified = changed().notified();
        let state = poll(app, request_id);
        if state != PollState::Pending {
            if state == PollState::Expired {
                let _ = app.emit(
                    "companion://pair-closed",
                    serde_json::json!({ "requestId": request_id }),
                );
            }
            return state;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || tokio::time::timeout(left, notified).await.is_err() {
            return PollState::Pending;
        }
    }
}

pub fn authorize(app: &AppHandle, token: &str) -> bool {
    with_store(app, |s| s.pairing.authorize(token))
}

#[tauri::command]
pub async fn companion_pair_resolve(
    app: AppHandle,
    request_id: String,
    approved: bool,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    let payload = payload.unwrap_or(serde_json::Value::Null);
    if approved && serde_json::to_vec(&payload).map(|v| v.len()).unwrap_or(0) > MAX_PAYLOAD_BYTES
    {
        return Err("payload too large".into());
    }
    let saved = with_store(&app, |s| {
        let save_needed = s
            .pairing
            .resolve(&request_id, approved, payload, Instant::now())?;
        if save_needed {
            save(s);
        }
        Ok::<_, String>(save_needed)
    })?;
    changed().notify_waiters();
    if saved {
        let _ = app.emit("companion://paired-changed", ());
    }
    if approved {
        // A paired TV is there to play torrents; have the server ready.
        if !crate::torrent_engine::lan_status().0 {
            if let Err(e) = crate::torrent_engine::start_lan_server(&app).await {
                eprintln!("[companion] stream server did not start: {e}");
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn companion_paired_list(app: AppHandle) -> Vec<PairedDevice> {
    with_store(&app, |s| s.pairing.paired.clone())
}

#[tauri::command]
pub fn companion_forget(app: AppHandle, device_id: String) {
    let forgot = with_store(&app, |s| {
        let forgot = s.pairing.forget(&device_id);
        if forgot {
            save(s);
        }
        forgot
    });
    if forgot {
        let _ = app.emit("companion://paired-changed", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TV: &str = "tv-0123456789";

    fn open(p: &mut Pairing, device: &str, now: Instant) -> String {
        p.request(device, "Living room TV", "4821", now)
            .unwrap()
            .0
            .request_id
    }

    #[test]
    fn rejects_bad_input() {
        let mut p = Pairing::default();
        let now = Instant::now();
        assert_eq!(
            p.request("short", "TV", "4821", now).unwrap_err(),
            RequestError::Invalid
        );
        assert_eq!(
            p.request(TV, "TV", "48a1", now).unwrap_err(),
            RequestError::Invalid
        );
        assert_eq!(
            p.request(TV, "  \n", "4821", now).unwrap_err(),
            RequestError::Invalid
        );
    }

    #[test]
    fn approval_is_delivered_once_with_a_token() {
        let mut p = Pairing::default();
        let now = Instant::now();
        let id = open(&mut p, TV, now);
        assert_eq!(p.poll(&id, now), PollState::Pending);
        let payload = serde_json::json!({ "tmdbKey": "k" });
        assert!(p.resolve(&id, true, payload.clone(), now).unwrap());
        let PollState::Approved {
            token,
            payload: got,
        } = p.poll(&id, now)
        else {
            panic!("expected an approval with a token");
        };
        assert_eq!(got, payload);
        assert!(p.authorize(&token));
        assert!(!p.authorize("nope"));
        assert_eq!(p.poll(&id, now), PollState::Expired);
    }

    #[test]
    fn pairing_again_replaces_the_token() {
        let mut p = Pairing::default();
        let now = Instant::now();
        let first = open(&mut p, TV, now);
        p.resolve(&first, true, serde_json::Value::Null, now).unwrap();
        let PollState::Approved { token: old, .. } = p.poll(&first, now) else {
            panic!("expected a token");
        };
        let again = p.request(TV, "Living room TV", "1111", now).unwrap().0;
        assert!(again.repeat);
        p.resolve(&again.request_id, true, serde_json::Value::Null, now)
            .unwrap();
        let PollState::Approved { token: new, .. } = p.poll(&again.request_id, now) else {
            panic!("expected a token");
        };
        assert!(!p.authorize(&old));
        assert!(p.authorize(&new));
        assert_eq!(p.paired.len(), 1);
    }

    #[test]
    fn denial_and_expiry() {
        let mut p = Pairing::default();
        let now = Instant::now();
        let id = open(&mut p, TV, now);
        p.resolve(&id, false, serde_json::Value::Null, now).unwrap();
        assert_eq!(p.poll(&id, now), PollState::Denied);
        assert!(p.paired.is_empty());

        let id = open(&mut p, TV, now);
        let later = now + REQUEST_TTL;
        assert_eq!(p.poll(&id, later), PollState::Expired);
        assert!(p
            .resolve(&id, true, serde_json::Value::Null, later)
            .is_err());
    }

    #[test]
    fn caps_pending_and_lets_a_device_replace_its_own() {
        let mut p = Pairing::default();
        let now = Instant::now();
        let first = open(&mut p, "tv-aaaaaaaa", now);
        open(&mut p, "tv-bbbbbbbb", now);
        open(&mut p, "tv-cccccccc", now);
        assert_eq!(
            p.request("tv-dddddddd", "TV", "1234", now).unwrap_err(),
            RequestError::Busy
        );
        let (_, closed) = p.request("tv-aaaaaaaa", "TV", "1234", now).unwrap();
        assert_eq!(closed, vec![first]);
    }

    #[test]
    fn forget_revokes_the_token() {
        let mut p = Pairing::default();
        let now = Instant::now();
        let id = open(&mut p, TV, now);
        p.resolve(&id, true, serde_json::Value::Null, now).unwrap();
        let PollState::Approved { token, .. } = p.poll(&id, now)
        else {
            panic!("expected a token");
        };
        assert!(p.forget(TV));
        assert!(!p.authorize(&token));
    }
}
