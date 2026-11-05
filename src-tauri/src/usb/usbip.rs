//! USB/IP, the exporter's side (mobd internal/usbip is the importer's): the import operation for
//! one device, then URBs. Big-endian, as in the kernel's Documentation/usb/usbip_protocol.rst.
//! Messages arrive split anywhere across tunnel messages, so parsing is incremental.

pub const VERSION: u16 = 0x0111;
pub const OP_REQ_IMPORT: u16 = 0x8003;
pub const OP_REP_IMPORT: u16 = 0x0003;
pub const OP_REQ_DEVLIST: u16 = 0x8005;
pub const OP_REP_DEVLIST: u16 = 0x0005;

pub const CMD_SUBMIT: u32 = 1;
pub const CMD_UNLINK: u32 = 2;
pub const RET_SUBMIT: u32 = 3;
pub const RET_UNLINK: u32 = 4;

pub const DIR_IN: u32 = 1;

/// Status values: 0 or a negative errno, as Linux reports them.
pub const OK: i32 = 0;
pub const STALL: i32 = -32; // EPIPE
pub const UNLINKED: i32 = -104; // ECONNRESET
pub const NO_DEVICE: i32 = -19; // ENODEV
pub const PROTOCOL: i32 = -71; // EPROTO
pub const IO: i32 = -5; // EIO
pub const INVALID: i32 = -22; // EINVAL

/// One URB's buffer may be at most this big, as in mobd.
pub const MAX_TRANSFER: usize = 1 << 20;
const BUS_ID: usize = 32;
const PATH: usize = 256;
const HEADER: usize = 48;

pub const SPEED_LOW: u32 = 1;
pub const SPEED_FULL: u32 = 2;
pub const SPEED_HIGH: u32 = 3;
pub const SPEED_SUPER: u32 = 5;

/// The exported device, as sent in OP_REP_IMPORT.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Device {
    pub path: String,
    pub bus_id: String,
    pub bus_num: u32,
    pub dev_num: u32,
    pub speed: u32,
    pub vendor_id: u16,
    pub product_id: u16,
    pub bcd_device: u16,
    pub class: u8,
    pub sub_class: u8,
    pub protocol: u8,
    pub configuration_value: u8,
    pub num_configurations: u8,
    pub num_interfaces: u8,
}

fn put_str(out: &mut Vec<u8>, s: &str, size: usize) {
    let b = s.as_bytes();
    let n = b.len().min(size - 1);
    out.extend_from_slice(&b[..n]);
    out.resize(out.len() + size - n, 0);
}

impl Device {
    pub fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(312);
        put_str(&mut b, &self.path, PATH);
        put_str(&mut b, &self.bus_id, BUS_ID);
        for v in [self.bus_num, self.dev_num, self.speed] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        for v in [self.vendor_id, self.product_id, self.bcd_device] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        b.extend_from_slice(&[
            self.class,
            self.sub_class,
            self.protocol,
            self.configuration_value,
            self.num_configurations,
            self.num_interfaces,
        ]);
        b
    }
}

fn op(code: u16, status: u32, body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(8 + body.len());
    b.extend_from_slice(&VERSION.to_be_bytes());
    b.extend_from_slice(&code.to_be_bytes());
    b.extend_from_slice(&status.to_be_bytes());
    b.extend_from_slice(body);
    b
}

/// A message from the importer.
#[derive(Debug, PartialEq)]
pub enum Request {
    /// OP_REQ_IMPORT for a bus ID.
    Import(String),
    /// OP_REQ_DEVLIST: mobd never sends it; answered with an empty list.
    DevList,
    Submit(Submit),
    /// CMD_UNLINK: (its own sequence number, the one to unlink).
    Unlink {
        seq: u32,
        target: u32,
    },
}

#[derive(Debug, PartialEq, Clone)]
pub struct Submit {
    pub seq: u32,
    pub dev_id: u32,
    pub dir: u32,
    pub ep: u8,
    pub flags: u32,
    pub length: usize,
    pub packets: i32,
    pub setup: [u8; 8],
    /// The OUT data.
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct ProtocolError(pub String);

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "USB/IP: {}", self.0)
    }
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_be_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// Parses the next request from `buf` while no device is imported (`imported` false: operations)
/// or after (URBs). Returns the request and the bytes it used, or None until more bytes arrive.
pub fn parse(buf: &[u8], imported: bool) -> Result<Option<(Request, usize)>, ProtocolError> {
    if !imported {
        if buf.len() < 8 {
            return Ok(None);
        }
        if u16_at(buf, 0) != VERSION {
            return Err(ProtocolError(format!("version {:#06x}", u16_at(buf, 0))));
        }
        return match u16_at(buf, 2) {
            OP_REQ_IMPORT => {
                if buf.len() < 8 + BUS_ID {
                    return Ok(None);
                }
                let id = &buf[8..8 + BUS_ID];
                let end = id.iter().position(|&c| c == 0).unwrap_or(BUS_ID);
                Ok(Some((
                    Request::Import(String::from_utf8_lossy(&id[..end]).into_owned()),
                    8 + BUS_ID,
                )))
            }
            OP_REQ_DEVLIST => Ok(Some((Request::DevList, 8))),
            code => Err(ProtocolError(format!("operation {code:#06x}"))),
        };
    }
    if buf.len() < HEADER {
        return Ok(None);
    }
    let (cmd, seq, dev_id, dir, ep) = (
        u32_at(buf, 0),
        u32_at(buf, 4),
        u32_at(buf, 8),
        u32_at(buf, 12),
        u32_at(buf, 16),
    );
    if ep > 15 || dir > 1 {
        return Err(ProtocolError(format!("endpoint {ep} direction {dir}")));
    }
    match cmd {
        CMD_SUBMIT => {
            let length = u32_at(buf, 24) as i32;
            let packets = u32_at(buf, 32) as i32;
            if length < 0 || length as usize > MAX_TRANSFER {
                return Err(ProtocolError(format!("transfer of {length} bytes")));
            }
            let out = if dir == DIR_IN { 0 } else { length as usize };
            let iso = if packets > 0 {
                if packets > 1024 {
                    return Err(ProtocolError(format!("{packets} isochronous packets")));
                }
                16 * packets as usize
            } else {
                0
            };
            if buf.len() < HEADER + out + iso {
                return Ok(None);
            }
            let mut setup = [0u8; 8];
            setup.copy_from_slice(&buf[40..48]);
            let s = Submit {
                seq,
                dev_id,
                dir,
                ep: ep as u8,
                flags: u32_at(buf, 20),
                length: length as usize,
                packets,
                setup,
                data: buf[HEADER..HEADER + out].to_vec(),
            };
            Ok(Some((Request::Submit(s), HEADER + out + iso)))
        }
        CMD_UNLINK => Ok(Some((
            Request::Unlink {
                seq,
                target: u32_at(buf, 20),
            },
            HEADER,
        ))),
        _ => Err(ProtocolError(format!("command {cmd}"))),
    }
}

pub fn import_reply(d: Option<&Device>) -> Vec<u8> {
    match d {
        Some(d) => op(OP_REP_IMPORT, 0, &d.encode()),
        None => op(OP_REP_IMPORT, 1, &[]),
    }
}

pub fn devlist_reply() -> Vec<u8> {
    op(OP_REP_DEVLIST, 0, &0u32.to_be_bytes())
}

fn header(cmd: u32, seq: u32, dev_id: u32, dir: u32, ep: u32) -> Vec<u8> {
    let mut b = Vec::with_capacity(HEADER);
    for v in [cmd, seq, dev_id, dir, ep] {
        b.extend_from_slice(&v.to_be_bytes());
    }
    b
}

/// RET_SUBMIT for `s`: IN data, or the OUT length transferred.
pub fn ret_submit(s: &Submit, status: i32, data: &[u8], actual: usize) -> Vec<u8> {
    let mut b = header(RET_SUBMIT, s.seq, s.dev_id, s.dir, s.ep as u32);
    let len = if s.dir == DIR_IN { data.len() } else { actual };
    for v in [
        status as u32,
        len as u32,
        0,
        if s.packets > 0 { 0 } else { u32::MAX },
        0,
    ] {
        b.extend_from_slice(&v.to_be_bytes());
    }
    b.resize(HEADER, 0);
    if s.dir == DIR_IN {
        b.extend_from_slice(data);
    }
    b
}

pub fn ret_unlink(seq: u32, dev_id: u32, status: i32) -> Vec<u8> {
    let mut b = header(RET_UNLINK, seq, dev_id, 0, 0);
    b.extend_from_slice(&(status as u32).to_be_bytes());
    b.resize(HEADER, 0);
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn submit(seq: u32, dir: u32, ep: u32, setup: [u8; 8], data: &[u8], len: u32) -> Vec<u8> {
        let mut b = header(CMD_SUBMIT, seq, 0x10002, dir, ep);
        for v in [0, len, 0, u32::MAX, 0] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        b.extend_from_slice(&setup);
        b.extend_from_slice(data);
        b
    }

    #[test]
    fn device_is_312_bytes() {
        assert_eq!(
            Device {
                bus_id: "1-1".into(),
                ..Default::default()
            }
            .encode()
            .len(),
            312
        );
    }

    #[test]
    fn parses_import_across_splits() {
        let mut req = op(OP_REQ_IMPORT, 0, &[]);
        let mut id = b"20-1.2".to_vec();
        id.resize(BUS_ID, 0);
        req.extend_from_slice(&id);
        for cut in 0..req.len() {
            assert!(
                parse(&req[..cut], false).unwrap().is_none(),
                "partial at {cut}"
            );
        }
        assert_eq!(
            parse(&req, false).unwrap(),
            Some((Request::Import("20-1.2".into()), 40))
        );
    }

    #[test]
    fn parses_submits_and_unlinks() {
        let out = submit(7, 0, 1, [0; 8], b"hello", 5);
        let (r, n) = parse(&out, true).unwrap().unwrap();
        assert_eq!(n, 48 + 5);
        let Request::Submit(s) = r else { panic!() };
        assert_eq!((s.seq, s.ep, s.data.as_slice()), (7, 1, &b"hello"[..]));
        // IN carries no data.
        let inn = submit(8, 1, 0, [0x80, 6, 0, 1, 0, 0, 18, 0], &[], 18);
        assert_eq!(parse(&inn, true).unwrap().unwrap().1, 48);
        let mut unlink = header(CMD_UNLINK, 9, 0x10002, 0, 0);
        unlink.extend_from_slice(&8u32.to_be_bytes());
        unlink.resize(48, 0);
        assert_eq!(
            parse(&unlink, true).unwrap().unwrap().0,
            Request::Unlink { seq: 9, target: 8 }
        );
    }

    #[test]
    fn rejects_bad_input() {
        let big = submit(1, 1, 1, [0; 8], &[], (MAX_TRANSFER + 1) as u32);
        assert!(parse(&big, true).is_err());
        let bad_ep = submit(1, 1, 16, [0; 8], &[], 0);
        assert!(parse(&bad_ep, true).is_err());
        assert!(parse(&op(0x9999, 0, &[]), false).is_err());
    }

    #[test]
    fn ret_submit_layout() {
        let s = Submit {
            seq: 5,
            dev_id: 0x10002,
            dir: DIR_IN,
            ep: 0,
            flags: 0,
            length: 18,
            packets: -1,
            setup: [0; 8],
            data: vec![],
        };
        let b = ret_submit(&s, OK, &[1, 2, 3], 3);
        assert_eq!(b.len(), 48 + 3);
        assert_eq!(u32_at(&b, 0), RET_SUBMIT);
        assert_eq!(u32_at(&b, 24), 3);
        assert_eq!(u32_at(&b, 32), u32::MAX);
    }
}
