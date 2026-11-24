//! Whether this computer sends connections through a proxy, and what the proxy leaves alone. The web
//! view follows the system proxy, and proxy apps (Clash, Surge…) cannot reach Tailscale addresses
//! unless those are in the bypass list; the app then explains that (src/lib/proxy.ts).

use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxy {
    /// A proxy is set: system settings (HTTP, HTTPS, SOCKS or automatic) or the environment.
    pub enabled: bool,
    /// Hosts and ranges the proxy leaves alone, as written in the settings.
    pub bypass: Vec<String>,
}

#[tauri::command]
pub async fn system_proxy() -> SystemProxy {
    tauri::async_runtime::spawn_blocking(detect).await.unwrap_or_default()
}

fn output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn detect() -> SystemProxy {
    let mut p = SystemProxy::default();
    for name in ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"] {
        if std::env::var(name).is_ok_and(|v| !v.trim().is_empty()) {
            p.enabled = true;
        }
    }
    for name in ["no_proxy", "NO_PROXY"] {
        if let Ok(v) = std::env::var(name) {
            p.bypass.extend(v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from));
        }
    }
    let system = if cfg!(target_os = "macos") {
        output("/usr/sbin/scutil", &["--proxy"]).map(|s| parse_scutil(&s))
    } else if cfg!(windows) {
        output("reg", &["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"]).map(|s| parse_windows(&s))
    } else {
        output("gsettings", &["get", "org.gnome.system.proxy", "mode"]).map(|mode| SystemProxy {
            enabled: matches!(mode.trim().trim_matches('\''), "manual" | "auto"),
            bypass: output("gsettings", &["get", "org.gnome.system.proxy", "ignore-hosts"])
                .map(|s| s.trim().trim_matches(|c| c == '[' || c == ']').split(',').map(|h| h.trim().trim_matches('\'').to_string()).filter(|h| !h.is_empty()).collect())
                .unwrap_or_default(),
        })
    };
    if let Some(s) = system {
        p.enabled |= s.enabled;
        p.bypass.extend(s.bypass);
    }
    p
}

/// `scutil --proxy`: `HTTPSEnable : 1` and the like, and the `ExceptionsList` array.
fn parse_scutil(text: &str) -> SystemProxy {
    let mut p = SystemProxy::default();
    let mut in_list = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with("ExceptionsList") {
            in_list = true;
            continue;
        }
        if in_list {
            if line.starts_with('}') {
                in_list = false;
            } else if let Some((_, v)) = line.split_once(" : ") {
                p.bypass.push(v.trim().to_string());
            }
            continue;
        }
        if let Some((k, v)) = line.split_once(" : ") {
            if matches!(k, "HTTPEnable" | "HTTPSEnable" | "SOCKSEnable" | "ProxyAutoConfigEnable") && v.trim() == "1" {
                p.enabled = true;
            }
        }
    }
    p
}

/// `reg query` of Internet Settings: `ProxyEnable REG_DWORD 0x1`, `ProxyOverride REG_SZ a;b`.
fn parse_windows(text: &str) -> SystemProxy {
    let mut p = SystemProxy::default();
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.as_slice() {
            ["ProxyEnable", _, v] => p.enabled |= *v == "0x1",
            ["AutoConfigURL", _, v, ..] => p.enabled |= !v.is_empty(),
            ["ProxyOverride", _, v, ..] => p.bypass.extend(v.split(';').filter(|s| !s.is_empty()).map(String::from)),
            _ => {}
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_scutil() {
        let text = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : 127.0.0.1\n    1 : *.ts.net\n  }\n  HTTPEnable : 0\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n}\n";
        assert_eq!(parse_scutil(text), SystemProxy { enabled: true, bypass: vec!["127.0.0.1".into(), "*.ts.net".into()] });
        assert!(!parse_scutil("<dictionary> {\n  HTTPEnable : 0\n}\n").enabled);
    }

    #[test]
    fn reads_windows() {
        let text = "    ProxyEnable    REG_DWORD    0x1\n    ProxyOverride    REG_SZ    *.ts.net;<local>\n";
        assert_eq!(parse_windows(text), SystemProxy { enabled: true, bypass: vec!["*.ts.net".into(), "<local>".into()] });
    }
}
