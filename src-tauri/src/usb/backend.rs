//! The device behind an export: real hardware through nusb, or an emulated loopback for tests.
//! Calls block; the exporter runs them off the async runtime, one at a time per endpoint.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::usbip::{self, Device, INVALID, IO, NO_DEVICE, OK, PROTOCOL, STALL, UNLINKED};

/// Set when the importer unlinks a URB; a transfer in flight is then cancelled.
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn set(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// A finished transfer: its status, IN data, and the OUT bytes sent.
pub struct Done {
    pub status: i32,
    pub data: Vec<u8>,
    pub actual: usize,
}

impl Done {
    pub fn status(status: i32) -> Done {
        Done {
            status,
            data: Vec::new(),
            actual: 0,
        }
    }
    fn data(data: Vec<u8>) -> Done {
        let actual = data.len();
        Done {
            status: OK,
            data,
            actual,
        }
    }
}

pub trait Backend: Send + Sync + 'static {
    fn device(&self) -> Device;
    /// A control request on endpoint 0; `len` is the IN length requested.
    fn control(&self, setup: [u8; 8], out: &[u8], len: usize, cancel: &Cancel) -> Done;
    /// A bulk or interrupt transfer; `ep` includes the direction bit (0x81 is IN 1).
    fn transfer(&self, ep: u8, out: &[u8], len: usize, cancel: &Cancel) -> Done;
}

pub struct Setup {
    pub request_type: u8,
    pub request: u8,
    pub value: u16,
    pub index: u16,
    pub length: u16,
}

pub fn setup(b: [u8; 8]) -> Setup {
    Setup {
        request_type: b[0],
        request: b[1],
        value: u16::from_le_bytes([b[2], b[3]]),
        index: u16::from_le_bytes([b[4], b[5]]),
        length: u16::from_le_bytes([b[6], b[7]]),
    }
}

const GET_STATUS: u8 = 0;
const CLEAR_FEATURE: u8 = 1;
const SET_ADDRESS: u8 = 5;
const GET_DESCRIPTOR: u8 = 6;
const SET_CONFIGURATION: u8 = 9;
const SET_INTERFACE: u8 = 11;

// ---------------------------------------------------------------------------------------------
// Loopback: mobd's emulated device (internal/usbip/emul.go), byte for byte.

/// A high-speed vendor-class device returning on bulk IN 0x81 what it got on bulk OUT 0x01.
pub struct Loopback {
    pub bus_id: String,
    buf: Mutex<Vec<u8>>,
    ready: Condvar,
}

impl Loopback {
    pub fn new(bus_id: &str) -> Loopback {
        Loopback {
            bus_id: bus_id.into(),
            buf: Mutex::new(Vec::new()),
            ready: Condvar::new(),
        }
    }
}

const LOOPBACK_DEVICE: [u8; 18] = [
    18, 1, 0x00, 0x02, 0, 0, 0, 64, 0x09, 0x12, 0x01, 0x00, 0x00, 0x01, 1, 2, 3, 1,
];
const LOOPBACK_CONFIG: [u8; 32] = [
    9, 2, 32, 0, 1, 1, 0, 0x80, 50, 9, 4, 0, 0, 2, 0xff, 0, 0, 0, 7, 5, 0x01, 0x02, 0x00, 0x02, 0,
    7, 5, 0x81, 0x02, 0x00, 0x02, 0,
];
const LOOPBACK_QUALIFIER: [u8; 10] = [10, 6, 0x00, 0x02, 0, 0, 0, 64, 1, 0];
const LOOPBACK_STRINGS: [&str; 4] = ["", "Mob", "Mob USB/IP loopback", "0001"];

impl Backend for Loopback {
    fn device(&self) -> Device {
        Device {
            path: "/mob/emulated/loopback".into(),
            bus_id: self.bus_id.clone(),
            bus_num: 1,
            dev_num: 2,
            speed: usbip::SPEED_HIGH,
            vendor_id: 0x1209,
            product_id: 0x0001,
            bcd_device: 0x0100,
            configuration_value: 1,
            num_configurations: 1,
            num_interfaces: 1,
            ..Default::default()
        }
    }

    fn control(&self, raw: [u8; 8], _out: &[u8], len: usize, _: &Cancel) -> Done {
        let s = setup(raw);
        if s.request_type & 0x60 != 0 {
            return Done::status(STALL);
        }
        let mut reply = match s.request {
            GET_DESCRIPTOR => match (s.value >> 8, (s.value & 0xff) as usize) {
                (1, _) => LOOPBACK_DEVICE.to_vec(),
                (2, _) => LOOPBACK_CONFIG.to_vec(),
                (3, 0) => vec![4, 3, 0x09, 0x04],
                (3, i) if i < LOOPBACK_STRINGS.len() => {
                    let u: Vec<u16> = LOOPBACK_STRINGS[i].encode_utf16().collect();
                    let mut b = vec![(2 + 2 * u.len()) as u8, 3];
                    u.iter().for_each(|c| b.extend_from_slice(&c.to_le_bytes()));
                    b
                }
                (6, _) => LOOPBACK_QUALIFIER.to_vec(),
                _ => return Done::status(STALL),
            },
            GET_STATUS => vec![0, 0],
            SET_ADDRESS | SET_CONFIGURATION | SET_INTERFACE | CLEAR_FEATURE => Vec::new(),
            _ => return Done::status(STALL),
        };
        reply.truncate(len.min(s.length as usize));
        Done::data(reply)
    }

    fn transfer(&self, ep: u8, out: &[u8], len: usize, cancel: &Cancel) -> Done {
        let mut buf = self.buf.lock().unwrap();
        match ep {
            0x01 => {
                if buf.len() + out.len() > 1 << 20 {
                    return Done::status(STALL);
                }
                buf.extend_from_slice(out);
                self.ready.notify_all();
                Done {
                    status: OK,
                    data: Vec::new(),
                    actual: out.len(),
                }
            }
            0x81 => {
                while buf.is_empty() {
                    if cancel.is_set() {
                        return Done::status(UNLINKED);
                    }
                    buf = self
                        .ready
                        .wait_timeout(buf, Duration::from_millis(50))
                        .unwrap()
                        .0;
                }
                let n = len.min(buf.len());
                Done::data(buf.drain(..n).collect())
            }
            _ => Done::status(STALL),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Hardware through nusb.

use nusb::descriptors::TransferType;
use nusb::transfer::{
    Buffer, Bulk, ControlIn, ControlOut, ControlType, In, Interrupt, Out, Recipient, TransferError,
};
use nusb::MaybeFuture;

enum Ep {
    BulkIn(nusb::Endpoint<Bulk, In>),
    BulkOut(nusb::Endpoint<Bulk, Out>),
    IntIn(nusb::Endpoint<Interrupt, In>),
    IntOut(nusb::Endpoint<Interrupt, Out>),
}

/// A real device, opened with all its interfaces claimed for the session.
pub struct Hardware {
    dev: nusb::Device,
    info: Device,
    state: Mutex<HwState>,
}

struct HwState {
    config: u8,
    interfaces: HashMap<u8, nusb::Interface>,
    endpoints: HashMap<u8, Arc<Mutex<Ep>>>,
}

fn status_of(e: TransferError) -> i32 {
    match e {
        TransferError::Stall => STALL,
        TransferError::Cancelled => UNLINKED,
        TransferError::Disconnected => NO_DEVICE,
        TransferError::Fault => PROTOCOL,
        TransferError::InvalidArgument => INVALID,
        _ => IO,
    }
}

impl Hardware {
    /// Opens the device and claims every interface of its active configuration, detaching Linux's
    /// drivers. On macOS a driver that holds an interface (storage, keyboards, serial adapters)
    /// cannot be detached, and the share fails with that reason.
    pub fn open(info: &nusb::DeviceInfo, bus_id: &str) -> Result<Hardware, String> {
        let dev = info
            .open()
            .wait()
            .map_err(|e| format!("Could not open the device: {e}"))?;
        let d = dev.device_descriptor();
        let cfg = dev
            .active_configuration()
            .map_err(|e| format!("The device has no active configuration: {e}"))?;
        let config = cfg.configuration_value();
        let mut interfaces = HashMap::new();
        for i in cfg.interfaces() {
            let n = i.interface_number();
            #[cfg(target_os = "linux")]
            let claimed = dev.detach_and_claim_interface(n).wait();
            #[cfg(not(target_os = "linux"))]
            let claimed = dev.claim_interface(n).wait();
            let iface = claimed.map_err(|e| {
                format!("Interface {n} is in use by this computer's driver ({e}). Devices that macOS drives itself, such as drives, keyboards and many serial adapters, can't be shared from a Mac yet.")
            })?;
            interfaces.insert(n, iface);
        }
        let speed = match dev.speed().or(info.speed()) {
            Some(nusb::Speed::Low) => usbip::SPEED_LOW,
            Some(nusb::Speed::Full) => usbip::SPEED_FULL,
            Some(nusb::Speed::Super | nusb::Speed::SuperPlus) => usbip::SPEED_SUPER,
            _ => usbip::SPEED_HIGH,
        };
        let device = Device {
            path: format!("/mob/{bus_id}"),
            bus_id: bus_id.into(),
            bus_num: 1,
            dev_num: info.device_address() as u32,
            speed,
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            bcd_device: d.device_version(),
            class: d.class(),
            sub_class: d.subclass(),
            protocol: d.protocol(),
            configuration_value: config,
            num_configurations: d.num_configurations(),
            num_interfaces: interfaces.len() as u8,
        };
        Ok(Hardware {
            dev,
            info: device,
            state: Mutex::new(HwState {
                config,
                interfaces,
                endpoints: HashMap::new(),
            }),
        })
    }

    fn endpoint(&self, addr: u8) -> Result<Arc<Mutex<Ep>>, i32> {
        let mut st = self.state.lock().unwrap();
        if let Some(e) = st.endpoints.get(&addr) {
            return Ok(e.clone());
        }
        for iface in st.interfaces.values() {
            let Some(desc) = iface.descriptor() else {
                continue;
            };
            let Some(e) = desc.endpoints().find(|e| e.address() == addr) else {
                continue;
            };
            let opened = match (e.transfer_type(), addr & 0x80 != 0) {
                (TransferType::Bulk, true) => iface.endpoint::<Bulk, In>(addr).map(Ep::BulkIn),
                (TransferType::Bulk, false) => iface.endpoint::<Bulk, Out>(addr).map(Ep::BulkOut),
                (TransferType::Interrupt, true) => {
                    iface.endpoint::<Interrupt, In>(addr).map(Ep::IntIn)
                }
                (TransferType::Interrupt, false) => {
                    iface.endpoint::<Interrupt, Out>(addr).map(Ep::IntOut)
                }
                _ => return Err(STALL), // isochronous is not supported
            };
            let ep = Arc::new(Mutex::new(opened.map_err(|_| IO)?));
            st.endpoints.insert(addr, ep.clone());
            return Ok(ep);
        }
        Err(STALL)
    }
}

/// Runs one transfer, cancelling it when `cancel` is set.
macro_rules! run {
    ($ep:expr, $buf:expr, $cancel:expr) => {{
        let ep = $ep;
        ep.submit($buf);
        loop {
            if let Some(c) = ep.wait_next_complete(Duration::from_millis(100)) {
                break c;
            }
            if $cancel.is_set() {
                ep.cancel_all();
                break ep
                    .wait_next_complete(Duration::from_secs(2))
                    .expect("cancelled transfer completes");
            }
        }
    }};
}

fn in_len(want: usize, mps: usize) -> usize {
    let mps = mps.max(1);
    want.max(1).div_ceil(mps) * mps
}

impl Backend for Hardware {
    fn device(&self) -> Device {
        self.info.clone()
    }

    fn control(&self, raw: [u8; 8], out: &[u8], len: usize, _: &Cancel) -> Done {
        let s = setup(raw);
        let standard = s.request_type & 0x60 == 0;
        let recipient_bits = s.request_type & 0x1f;
        // Requests the exporter must carry out itself, not pass through.
        if standard {
            match (recipient_bits, s.request) {
                (_, SET_ADDRESS) => return Done::status(OK),
                (0, SET_CONFIGURATION) => {
                    let mut st = self.state.lock().unwrap();
                    if s.value as u8 == st.config {
                        return Done::status(OK);
                    }
                    st.endpoints.clear();
                    st.interfaces.clear();
                    return match self.dev.set_configuration(s.value as u8).wait() {
                        Ok(()) => {
                            st.config = s.value as u8;
                            if let Ok(cfg) = self.dev.active_configuration() {
                                for i in cfg.interfaces() {
                                    if let Ok(iface) =
                                        self.dev.claim_interface(i.interface_number()).wait()
                                    {
                                        st.interfaces.insert(i.interface_number(), iface);
                                    }
                                }
                            }
                            Done::status(OK)
                        }
                        Err(_) => Done::status(STALL),
                    };
                }
                (1, SET_INTERFACE) => {
                    let mut st = self.state.lock().unwrap();
                    let n = s.index as u8;
                    let Some(iface) = st.interfaces.get(&n).cloned() else {
                        return Done::status(STALL);
                    };
                    // Endpoints of the old setting must be closed first.
                    let addrs: Vec<u8> = iface
                        .descriptor()
                        .map(|d| d.endpoints().map(|e| e.address()).collect())
                        .unwrap_or_default();
                    addrs.iter().for_each(|a| {
                        st.endpoints.remove(a);
                    });
                    return match iface.set_alt_setting(s.value as u8).wait() {
                        Ok(()) => Done::status(OK),
                        Err(_) => Done::status(STALL),
                    };
                }
                (2, CLEAR_FEATURE) if s.value == 0 => {
                    let Ok(ep) = self.endpoint(s.index as u8) else {
                        return Done::status(STALL);
                    };
                    let mut ep = ep.lock().unwrap();
                    let r = match &mut *ep {
                        Ep::BulkIn(e) => e.clear_halt().wait(),
                        Ep::BulkOut(e) => e.clear_halt().wait(),
                        Ep::IntIn(e) => e.clear_halt().wait(),
                        Ep::IntOut(e) => e.clear_halt().wait(),
                    };
                    return Done::status(if r.is_ok() { OK } else { STALL });
                }
                _ => {}
            }
        }
        let control_type = match (s.request_type >> 5) & 3 {
            0 => ControlType::Standard,
            1 => ControlType::Class,
            _ => ControlType::Vendor,
        };
        let recipient = match recipient_bits {
            0 => Recipient::Device,
            1 => Recipient::Interface,
            2 => Recipient::Endpoint,
            _ => Recipient::Other,
        };
        let timeout = Duration::from_secs(5);
        if s.request_type & 0x80 != 0 {
            let r = self
                .dev
                .control_in(
                    ControlIn {
                        control_type,
                        recipient,
                        request: s.request,
                        value: s.value,
                        index: s.index,
                        length: (len.min(s.length as usize)) as u16,
                    },
                    timeout,
                )
                .wait();
            match r {
                Ok(data) => Done::data(data),
                Err(e) => Done::status(status_of(e)),
            }
        } else {
            let r = self
                .dev
                .control_out(
                    ControlOut {
                        control_type,
                        recipient,
                        request: s.request,
                        value: s.value,
                        index: s.index,
                        data: out,
                    },
                    timeout,
                )
                .wait();
            match r {
                Ok(()) => Done {
                    status: OK,
                    data: Vec::new(),
                    actual: out.len(),
                },
                Err(e) => Done::status(status_of(e)),
            }
        }
    }

    fn transfer(&self, addr: u8, out: &[u8], len: usize, cancel: &Cancel) -> Done {
        let ep = match self.endpoint(addr) {
            Ok(e) => e,
            Err(s) => return Done::status(s),
        };
        let mut ep = ep.lock().unwrap();
        let c = match &mut *ep {
            Ep::BulkIn(e) => {
                let b = Buffer::new(in_len(len, e.max_packet_size()));
                run!(e, b, cancel)
            }
            Ep::IntIn(e) => {
                let b = Buffer::new(in_len(len, e.max_packet_size()));
                run!(e, b, cancel)
            }
            Ep::BulkOut(e) => run!(e, Buffer::from(out.to_vec()), cancel),
            Ep::IntOut(e) => run!(e, Buffer::from(out.to_vec()), cancel),
        };
        let status = match c.status {
            Ok(()) => OK,
            Err(e) => status_of(e),
        };
        if addr & 0x80 != 0 {
            let mut data = c.buffer.into_vec();
            data.truncate(c.actual_len.min(len));
            Done {
                status,
                actual: data.len(),
                data,
            }
        } else {
            Done {
                status,
                data: Vec::new(),
                actual: c.actual_len,
            }
        }
    }
}
