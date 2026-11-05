//! USB sharing (mobd docs/usb-redirection.md): the user picks a device here, mobd on the office
//! computer imports it, and its OS uses it like a locally plugged device. The webview creates and
//! releases the session over mobd's API; this side opens the device and carries its traffic over
//! the session's tunnel, with the machine's credential read from the keychain.

pub mod backend;
pub mod exporter;
pub mod usbip;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use nusb::MaybeFuture;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use backend::{Backend, Hardware, Loopback};
use exporter::End;

const EMULATED: &str = "emulated-1";

/// A device on this computer, as the share picker lists it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalDevice {
    pub bus_id: String,
    pub name: String,
    pub manufacturer: Option<String>,
    pub vendor_id: u16,
    pub product_id: u16,
    pub serial_number: Option<String>,
    /// Why it cannot be shared from this computer, if so.
    pub unavailable: Option<String>,
    /// Shared now, by this app.
    pub shared: bool,
}

struct Share {
    bus_id: String,
    machine_id: String,
    stop: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct Shares(Mutex<HashMap<String, Share>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub session_id: String,
    pub bus_id: String,
    pub machine_id: String,
}

/// What the UI hears about a share: mobd's session state, or why the share ended here.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShareEvent {
    pub session_id: String,
    pub state: String,
    pub reason: Option<String>,
    pub local_bus_id: Option<String>,
}

fn bus_id_of(d: &nusb::DeviceInfo) -> String {
    let chain: Vec<String> = d.port_chain().iter().map(|p| p.to_string()).collect();
    let mut id = format!("{}-{}", d.bus_id(), chain.join("."));
    id.truncate(31);
    id
}

/// Interfaces macOS's own drivers keep: they cannot be claimed for sharing from a Mac.
fn held_on_macos(classes: &[u8]) -> Option<&'static str> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let names = [
        (8, "drives"),
        (3, "keyboards, mice and other input devices"),
        (1, "audio devices"),
        (14, "cameras"),
        (2, "serial and network adapters"),
        (10, "serial adapters"),
    ];
    classes
        .iter()
        .find_map(|c| names.iter().find(|(k, _)| k == c).map(|(_, n)| *n))
}

#[tauri::command]
pub async fn usb_devices(shares: State<'_, Shares>) -> Result<Vec<LocalDevice>, String> {
    let shared: Vec<String> = shares
        .0
        .lock()
        .unwrap()
        .values()
        .map(|s| s.bus_id.clone())
        .collect();
    let list = tauri::async_runtime::spawn_blocking(|| {
        nusb::list_devices().wait().map(|it| it.collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Could not list USB devices: {e}"))?;
    let mut out = Vec::new();
    for d in list {
        let mut classes: Vec<u8> = d.interfaces().map(|i| i.class()).collect();
        classes.push(d.class());
        if d.class() == 9 {
            continue; // hubs are not shared
        }
        let bus_id = bus_id_of(&d);
        let unavailable = held_on_macos(&classes).map(|what| {
            format!("macOS's own driver holds {what}, so it can't be shared from a Mac yet.")
        });
        out.push(LocalDevice {
            name: d.product_string().map(str::to_owned).unwrap_or_else(|| {
                format!("USB device {:04x}:{:04x}", d.vendor_id(), d.product_id())
            }),
            manufacturer: d.manufacturer_string().map(str::to_owned),
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            serial_number: d.serial_number().map(str::to_owned),
            shared: shared.contains(&bus_id),
            bus_id,
            unavailable,
        });
    }
    // For trying the whole flow without hardware (docs/usb-redirection.md).
    if std::env::var("MOB_USB_EMULATED").as_deref() == Ok("1") {
        out.push(LocalDevice {
            bus_id: EMULATED.into(),
            name: "Mob USB/IP loopback (emulated)".into(),
            manufacturer: Some("Mob".into()),
            vendor_id: 0x1209,
            product_id: 0x0001,
            serial_number: Some("0001".into()),
            unavailable: None,
            shared: shared.iter().any(|b| b == EMULATED),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn usb_shares(shares: State<'_, Shares>) -> Vec<ShareInfo> {
    shares
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| ShareInfo {
            session_id: id.clone(),
            bus_id: s.bus_id.clone(),
            machine_id: s.machine_id.clone(),
        })
        .collect()
}

/// Opens `bus_id` and serves it on session `session_id`'s tunnel at `base_url`, until mobd releases
/// it, `usb_stop`, or the device goes away. Progress arrives as "usb-share" events.
#[tauri::command]
pub async fn usb_share(
    app: AppHandle,
    shares: State<'_, Shares>,
    machine_id: String,
    base_url: String,
    session_id: String,
    bus_id: String,
) -> Result<(), String> {
    {
        let s = shares.0.lock().unwrap();
        if s.values().any(|x| x.bus_id == bus_id) {
            return Err("This device is already shared.".into());
        }
    }
    let token = crate::secrets::get(&format!("{machine_id}.token"))?
        .ok_or("This machine needs pairing again.")?;
    let backend: Arc<dyn Backend> = if bus_id == EMULATED {
        Arc::new(Loopback::new(EMULATED))
    } else {
        let id = bus_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let devices = nusb::list_devices().wait().map_err(|e| e.to_string())?;
            let info = devices
                .into_iter()
                .find(|d| bus_id_of(d) == id)
                .ok_or("The device was unplugged.")?;
            Hardware::open(&info, &id).map(|h| Arc::new(h) as Arc<dyn Backend>)
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let url = tunnel_url(&base_url, &session_id)?;
    let (stop_tx, stop_rx) = oneshot::channel();
    shares.0.lock().unwrap().insert(
        session_id.clone(),
        Share {
            bus_id: bus_id.clone(),
            machine_id,
            stop: Some(stop_tx),
        },
    );
    let app2 = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let emit = |e: ShareEvent| {
            let _ = app2.emit("usb-share", e);
        };
        let end = tunnel(url, token, backend, bus_id, stop_rx, |st| {
            emit(st.with_session(&sid))
        })
        .await;
        let (state, reason) = match end {
            Ok(End::Closed) => ("disconnected", None),
            Ok(End::Unplugged) => ("failed", Some("The device was unplugged.".to_string())),
            Ok(End::Error(e)) | Err(e) => ("failed", Some(e)),
        };
        if let Some(r) = &reason {
            eprintln!("usb {sid}: {r}");
        }
        app2.state::<Shares>().0.lock().unwrap().remove(&sid);
        emit(ShareEvent {
            session_id: sid.clone(),
            state: state.into(),
            reason,
            local_bus_id: None,
        });
    });
    Ok(())
}

/// Ends a share here: the tunnel closes and mobd detaches the device. Prefer releasing the session
/// through mobd first, which detaches in order.
#[tauri::command]
pub fn usb_stop(shares: State<'_, Shares>, session_id: String) {
    if let Some(s) = shares.0.lock().unwrap().get_mut(&session_id) {
        if let Some(stop) = s.stop.take() {
            let _ = stop.send(());
        }
    }
}

fn tunnel_url(base: &str, session: &str) -> Result<String, String> {
    let base = base.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err(format!("Unexpected machine address {base}"));
    };
    if !session.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Unexpected session ID".into());
    }
    Ok(format!("{ws}/usb/sessions/{session}/tunnel"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateMessage {
    t: String,
    state: String,
    reason: Option<String>,
    local_bus_id: Option<String>,
}

pub struct TunnelState {
    state: String,
    reason: Option<String>,
    local_bus_id: Option<String>,
}

impl TunnelState {
    fn with_session(self, id: &str) -> ShareEvent {
        ShareEvent {
            session_id: id.into(),
            state: self.state,
            reason: self.reason,
            local_bus_id: self.local_bus_id,
        }
    }
}

/// Carries the export over the session's WebSocket. Binary messages are USB/IP; mobd's text
/// messages report the session's state.
pub async fn tunnel(
    url: String,
    token: String,
    backend: Arc<dyn Backend>,
    bus_id: String,
    mut stop: oneshot::Receiver<()>,
    on_state: impl Fn(TunnelState),
) -> Result<End, String> {
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|e| e.to_string())?,
    );
    let (ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| format!("Could not open the USB tunnel: {e}"))?;
    let (mut write, mut read) = ws.split();
    let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>(256);
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(256);
    let mut export = tokio::spawn(exporter::export(backend, bus_id, in_rx, out_tx));
    let mut in_tx = Some(in_tx);
    loop {
        tokio::select! {
            m = read.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    if let Some(tx) = &in_tx {
                        if tx.send(b.to_vec()).await.is_err() { in_tx = None; }
                    }
                }
                Some(Ok(Message::Text(t))) => {
                    if let Ok(s) = serde_json::from_str::<StateMessage>(t.as_str()) {
                        if s.t == "state" {
                            on_state(TunnelState { state: s.state, reason: s.reason, local_bus_id: s.local_bus_id });
                        }
                    }
                }
                Some(Ok(Message::Ping(p))) => { let _ = write.send(Message::Pong(p)).await; }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => { in_tx = None; break; }
            },
            out = out_rx.recv() => match out {
                Some(b) => if write.send(Message::binary(b)).await.is_err() { in_tx = None; break; },
                None => break,
            },
            _ = &mut stop => { let _ = write.send(Message::Close(None)).await; in_tx = None; break; }
            r = &mut export => {
                let _ = write.send(Message::Close(None)).await;
                return r.map_err(|e| e.to_string());
            }
        }
    }
    drop(in_tx);
    let _ = write.close().await;
    match tokio::time::timeout(std::time::Duration::from_secs(5), export).await {
        Ok(Ok(e)) => Ok(e),
        _ => Ok(End::Closed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_urls() {
        assert_eq!(
            tunnel_url("https://m.ts.net/", "ab12").unwrap(),
            "wss://m.ts.net/usb/sessions/ab12/tunnel"
        );
        assert_eq!(
            tunnel_url("http://10.0.0.2:8080", "ab12").unwrap(),
            "ws://10.0.0.2:8080/usb/sessions/ab12/tunnel"
        );
        assert!(tunnel_url("ftp://x", "ab").is_err());
        assert!(tunnel_url("http://x", "../etc").is_err());
    }

    #[test]
    fn macos_drivers() {
        let held = held_on_macos(&[8]);
        assert_eq!(held.is_some(), cfg!(target_os = "macos"));
        assert_eq!(held_on_macos(&[0xff, 0]), None);
    }

    /// Against a real mobd: MOB_USB_E2E_URL (tunnel URL of a session created for bus ID
    /// emulated-1) and MOB_USB_E2E_TOKEN. Exports the loopback until mobd closes the tunnel.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn exports_to_a_real_mobd() {
        let url = std::env::var("MOB_USB_E2E_URL").expect("MOB_USB_E2E_URL");
        let token = std::env::var("MOB_USB_E2E_TOKEN").expect("MOB_USB_E2E_TOKEN");
        let (_stop, rx) = oneshot::channel();
        let end = tunnel(
            url,
            token,
            Arc::new(Loopback::new(EMULATED)),
            EMULATED.into(),
            rx,
            |s| eprintln!("state {} {:?} {:?}", s.state, s.reason, s.local_bus_id),
        )
        .await;
        eprintln!("ended: {end:?}");
        assert_eq!(end.unwrap(), End::Closed);
    }
}
