//! Serves one device to mobd over the tunnel: the import for exactly the shared bus ID, then URBs.
//! Endpoint 0 runs on a blocking task per request; every other endpoint has a worker thread, so its
//! URBs stay in order and an unlink cancels only the one it names.

use std::collections::HashMap;
use std::sync::{mpsc as std_mpsc, Arc, Mutex};

use tokio::sync::mpsc;

use super::backend::{Backend, Cancel, Done};
use super::usbip::{self, Request, Submit, DIR_IN, INVALID, NO_DEVICE, OK, UNLINKED};

type Pending = Arc<Mutex<HashMap<u32, Cancel>>>;

struct Job {
    submit: Submit,
    cancel: Cancel,
}

/// Why an export ended.
#[derive(Debug, PartialEq)]
pub enum End {
    /// mobd closed the tunnel (released, or detached).
    Closed,
    /// The device stopped answering: unplugged or reset away.
    Unplugged,
    Error(String),
}

/// Answers `incoming` (bytes from mobd) on `outgoing` until mobd closes or the device goes away.
pub async fn export(
    backend: Arc<dyn Backend>,
    bus_id: String,
    mut incoming: mpsc::Receiver<Vec<u8>>,
    outgoing: mpsc::Sender<Vec<u8>>,
) -> End {
    let pending: Pending = Arc::default();
    let mut workers: HashMap<u8, std_mpsc::Sender<Job>> = HashMap::new();
    let (gone_tx, mut gone) = mpsc::channel::<()>(1);
    let mut buf: Vec<u8> = Vec::new();
    let mut imported = false;

    // Sends RET_SUBMIT unless the URB was unlinked first (then RET_UNLINK answered it).
    let complete = {
        let pending = pending.clone();
        let outgoing = outgoing.clone();
        let gone_tx = gone_tx.clone();
        Arc::new(move |s: &Submit, d: Done| {
            if d.status == NO_DEVICE {
                let _ = gone_tx.try_send(());
            }
            if pending.lock().unwrap().remove(&s.seq).is_some() {
                let _ = outgoing.blocking_send(usbip::ret_submit(s, d.status, &d.data, d.actual));
            }
        })
    };

    loop {
        let chunk = tokio::select! {
            c = incoming.recv() => match c { Some(c) => c, None => return End::Closed },
            _ = gone.recv() => return End::Unplugged,
        };
        buf.extend_from_slice(&chunk);
        loop {
            let parsed = match usbip::parse(&buf, imported) {
                Ok(p) => p,
                Err(e) => return End::Error(e.to_string()),
            };
            let Some((req, used)) = parsed else { break };
            buf.drain(..used);
            match req {
                Request::Import(id) => {
                    if id != bus_id {
                        let _ = outgoing.send(usbip::import_reply(None)).await;
                        return End::Error(format!("mobd asked for {id}, not the shared device"));
                    }
                    let _ = outgoing
                        .send(usbip::import_reply(Some(&backend.device())))
                        .await;
                    imported = true;
                }
                Request::DevList => {
                    // The tunnel shares one device on request, never a list.
                    let _ = outgoing.send(usbip::devlist_reply()).await;
                }
                Request::Unlink { seq, target } => {
                    let found = pending.lock().unwrap().remove(&target);
                    let status = match found {
                        Some(c) => {
                            c.set();
                            UNLINKED
                        }
                        None => OK, // already completed
                    };
                    let _ = outgoing.send(usbip::ret_unlink(seq, 0, status)).await;
                }
                Request::Submit(s) => {
                    let cancel = Cancel::default();
                    pending.lock().unwrap().insert(s.seq, cancel.clone());
                    if s.packets > 0 {
                        // Isochronous (audio, cameras) is not supported.
                        complete(&s, Done::status(INVALID));
                        continue;
                    }
                    if s.ep == 0 {
                        let (b, done) = (backend.clone(), complete.clone());
                        tokio::task::spawn_blocking(move || {
                            let d = b.control(s.setup, &s.data, s.length, &cancel);
                            done(&s, d);
                        });
                        continue;
                    }
                    let addr = s.ep | if s.dir == DIR_IN { 0x80 } else { 0 };
                    let worker = workers.entry(addr).or_insert_with(|| {
                        let (tx, rx) = std_mpsc::channel::<Job>();
                        let (b, done) = (backend.clone(), complete.clone());
                        std::thread::Builder::new()
                            .name(format!("usb-ep-{addr:02x}"))
                            .spawn(move || {
                                for job in rx {
                                    if job.cancel.is_set() {
                                        continue; // unlinked while queued
                                    }
                                    let d = b.transfer(
                                        addr,
                                        &job.submit.data,
                                        job.submit.length,
                                        &job.cancel,
                                    );
                                    done(&job.submit, d);
                                }
                            })
                            .expect("endpoint thread");
                        tx
                    });
                    let _ = worker.send(Job { submit: s, cancel });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::backend::Loopback;
    use super::*;
    use std::time::Duration;

    fn import(id: &str) -> Vec<u8> {
        let mut b = vec![0x01, 0x11, 0x80, 0x03, 0, 0, 0, 0];
        let mut bid = id.as_bytes().to_vec();
        bid.resize(32, 0);
        b.extend_from_slice(&bid);
        b
    }

    fn submit(seq: u32, dir: u32, ep: u32, setup: [u8; 8], data: &[u8], len: u32) -> Vec<u8> {
        let mut b = Vec::new();
        for v in [1u32, seq, 0x10002, dir, ep, 0, len, 0, u32::MAX, 0] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        b.extend_from_slice(&setup);
        b.extend_from_slice(data);
        b
    }

    fn u32_at(b: &[u8], i: usize) -> u32 {
        u32::from_be_bytes(b[i..i + 4].try_into().unwrap())
    }

    async fn next(rx: &mut mpsc::Receiver<Vec<u8>>) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("reply")
            .expect("open")
    }

    fn start() -> (
        mpsc::Sender<Vec<u8>>,
        mpsc::Receiver<Vec<u8>>,
        tokio::task::JoinHandle<End>,
    ) {
        let (in_tx, in_rx) = mpsc::channel(64);
        let (out_tx, out_rx) = mpsc::channel(64);
        let h = tokio::spawn(export(
            Arc::new(Loopback::new("1-1")),
            "1-1".into(),
            in_rx,
            out_tx,
        ));
        (in_tx, out_rx, h)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn imports_only_the_shared_device_and_echoes() {
        let (tx, mut rx, h) = start();
        // Split the import across two messages, as a tunnel may.
        let req = import("1-1");
        tx.send(req[..5].to_vec()).await.unwrap();
        tx.send(req[5..].to_vec()).await.unwrap();
        let rep = next(&mut rx).await;
        assert_eq!(
            (rep.len(), &rep[..4]),
            (8 + 312, &[0x01, 0x11, 0x00, 0x03][..])
        );
        assert_eq!(u32_at(&rep, 4), 0);

        tx.send(submit(1, 1, 0, [0x80, 6, 0, 1, 0, 0, 18, 0], &[], 18))
            .await
            .unwrap();
        let r = next(&mut rx).await;
        assert_eq!((u32_at(&r, 0), u32_at(&r, 4), u32_at(&r, 24)), (3, 1, 18));
        assert_eq!(&r[48 + 8..48 + 10], &[0x09, 0x12]);

        tx.send(submit(2, 0, 1, [0; 8], b"ping", 4)).await.unwrap();
        assert_eq!(u32_at(&next(&mut rx).await, 24), 4);
        tx.send(submit(3, 1, 1, [0; 8], &[], 512)).await.unwrap();
        let r = next(&mut rx).await;
        assert_eq!(&r[48..], b"ping");

        drop(tx);
        assert_eq!(h.await.unwrap(), End::Closed);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refuses_another_bus_id() {
        let (tx, mut rx, h) = start();
        tx.send(import("1-2")).await.unwrap();
        assert_eq!(u32_at(&next(&mut rx).await, 4), 1);
        assert!(matches!(h.await.unwrap(), End::Error(_)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unlink_cancels_a_pending_in_once() {
        let (tx, mut rx, _h) = start();
        tx.send(import("1-1")).await.unwrap();
        next(&mut rx).await;
        tx.send(submit(10, 1, 1, [0; 8], &[], 512)).await.unwrap(); // waits: nothing to read
        let mut unlink = Vec::new();
        for v in [2u32, 11, 0x10002, 0, 0, 10] {
            unlink.extend_from_slice(&v.to_be_bytes());
        }
        unlink.resize(48, 0);
        tx.send(unlink).await.unwrap();
        let r = next(&mut rx).await;
        assert_eq!(
            (u32_at(&r, 0), u32_at(&r, 4), u32_at(&r, 20) as i32),
            (4, 11, UNLINKED)
        );
        // The next reply answers the next submit, not the unlinked one.
        tx.send(submit(12, 0, 1, [0; 8], b"x", 1)).await.unwrap();
        let r = next(&mut rx).await;
        assert_eq!((u32_at(&r, 0), u32_at(&r, 4)), (3, 12));
    }
}
