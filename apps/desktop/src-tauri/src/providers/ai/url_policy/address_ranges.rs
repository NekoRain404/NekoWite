//! The address ranges the SSRF guard is made of: which hosts and literal
//! addresses count as private, loopback, link-local, CGNAT or IPv4-mapped.
//!
//! Extracted from [`super`] as one vertical slice, because judging a URL and
//! knowing which addresses are private are two concerns: this one is a table of
//! RFCs that takes an address and answers, while the file above is the decision
//! that reads it and the messages it produces. A new range is a change here
//! alone, and the range table can be tested without a URL, a config or a
//! resolver.
//!
//! Dependencies: none. Nothing here imports a sibling or a provider module -
//! the predicates are pure functions of the string or address they are handed -
//! so this is the leaf of the `url_policy` module.

pub(super) fn is_private_or_loopback_host(host: &str) -> bool {
    // `Url::host_str()` serialises IPv6 with surrounding brackets (`[::1]`),
    // which would not parse as an `IpAddr`; strip them so it does.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => is_private_or_loopback_ip(ip),
        Err(_) => false,
    }
}

pub(super) fn is_private_or_loopback_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 0                                        // 0.0.0.0/8 "this network"
                || o[0] == 127                                // 127.0.0.0/8 loopback
                || o[0] == 10                                 // 10.0.0.0/8 private
                || (o[0] == 100 && (16..=127).contains(&o[1])) // 100.64.0.0/10 CGNAT
                || (o[0] == 169 && o[1] == 254)               // 169.254.0.0/16 link-local
                || (o[0] == 172 && (16..=31).contains(&o[1])) // 172.16.0.0/12 private
                || (o[0] == 192 && o[1] == 168) // 192.168.0.0/16 private
        }
        std::net::IpAddr::V6(v6) => {
            let seg = v6.segments();
            v6.is_loopback()                                // ::1/128
                || v6.is_unspecified()                      // ::
                || (seg[0] & 0xfe00) == 0xfc00              // fc00::/7 unique-local
                || (seg[0] & 0xffc0) == 0xfe80              // fe80::/10 link-local
                || is_ipv4_mapped_private(v6)
        }
    }
}

/// `::ffff:a.b.c.d` — an IPv4 address embedded in IPv6. Decode the trailing 32
/// bits and re-run the IPv4 guard so a v4 range check cannot be bypassed by
/// writing the address as IPv4-mapped IPv6.
fn is_ipv4_mapped_private(v6: std::net::Ipv6Addr) -> bool {
    let seg = v6.segments();
    if !(seg[0] == 0
        && seg[1] == 0
        && seg[2] == 0
        && seg[3] == 0
        && seg[4] == 0
        && seg[5] == 0xffff)
    {
        return false;
    }
    let v4 = std::net::Ipv4Addr::new(
        (seg[6] >> 8) as u8,
        (seg[6] & 0xff) as u8,
        (seg[7] >> 8) as u8,
        (seg[7] & 0xff) as u8,
    );
    is_private_or_loopback_ip(std::net::IpAddr::V4(v4))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_flags_private_loopback_and_mapped_ips() {
        for host in [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.0.5",
            "localhost",
        ] {
            assert!(is_private_or_loopback_host(host), "should flag {host}");
        }
        for host in [
            "8.8.8.8",
            "203.0.113.9",
            "2606:4700:4700::1111",
            "api.openai.com",
        ] {
            assert!(!is_private_or_loopback_host(host), "should allow {host}");
        }
    }
}
