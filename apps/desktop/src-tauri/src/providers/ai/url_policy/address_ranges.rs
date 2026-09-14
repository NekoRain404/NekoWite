//! The address ranges the SSRF guard is made of: which hosts and literal
//! addresses count as private, loopback, link-local, CGNAT or IPv4-embedded.
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
                || embedded_ipv4(v6)
                    .is_some_and(|v4| is_private_or_loopback_ip(std::net::IpAddr::V4(v4)))
        }
    }
}

/// The IPv4 address an IPv6 literal carries, for the shapes in which the low
/// 32 bits **are** that address rather than the address's own bits:
///
///   * `::ffff:a.b.c.d` — IPv4-mapped, `::ffff:0:0/96`, RFC 4291. A v4
///     destination written as IPv6; the stack dials `a.b.c.d`.
///   * `::a.b.c.d` — IPv4-compatible, `::/96`, RFC 4291 (deprecated there,
///     still accepted by the parser and by translation setups). This is the
///     form the audit found judged public: `::127.0.0.1` is segments
///     `[0,0,0,0,0,0,0x7f00,0x0001]`, which is not `::1`, not `::`, has a
///     zero `seg[0]` and a zero `seg[5]`, so no test that only looked at the
///     shape of the v6 address ever fired.
///   * `::ffff:0:a.b.c.d` — IPv4-translated, `::ffff:0:0:0/96`, RFC 2765.
///   * `64:ff9b::a.b.c.d` — the NAT64 well-known prefix, `64:ff9b::/96`,
///     RFC 6052. A NAT64 gateway dials `a.b.c.d` on this host's behalf, so it
///     reaches a private address with no translation configured here.
///
/// All four share one layout, so one decode answers for all of them and there
/// is no second rule set to keep in step with [`is_private_or_loopback_ip`]:
/// the embedded address is handed straight back to the IPv4 table.
///
/// `None` for every other address, and that half is load-bearing rather than a
/// formality: the low 32 bits of a native IPv6 address are its own, so a decode
/// that ran unconditionally would read `2606:4700:4700::1111` as `0.0.17.17`
/// and refuse a public DNS server. The recogniser has to come first.
///
/// What carries a v4 address at some *other* position, or by some other
/// convention, is left out on purpose: an operator's NAT64 prefix (and RFC
/// 8215's local-use `64:ff9b:1::/48`) splits the address around the zero `u`
/// octet, 6to4 embeds at bits 16-47, Teredo complements the address, and
/// ISATAP's `0000:5efe:` is an interface-id convention any prefix may carry
/// rather than a statement about the address space. Each needs an extraction of
/// its own with its own way to be wrong, and the test below records all four so
/// the exclusion stays a decision.
fn embedded_ipv4(v6: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let seg = v6.segments();
    let zero = |r: std::ops::Range<usize>| seg[r].iter().all(|&s| s == 0);
    let recognised = (zero(0..5) && seg[5] == 0xffff) // ::ffff:0:0/96
        || zero(0..6)                                 // ::/96 (`::` and `::1` too)
        || (zero(0..4) && seg[4] == 0xffff && seg[5] == 0) // ::ffff:0:0:0/96
        || (seg[0] == 0x0064 && seg[1] == 0xff9b && zero(2..6)); // 64:ff9b::/96
    recognised.then(|| {
        std::net::Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            (seg[6] & 0xff) as u8,
            (seg[7] >> 8) as u8,
            (seg[7] & 0xff) as u8,
        )
    })
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
            "::127.0.0.1",
            "::ffff:0:127.0.0.1",
            "64:ff9b::127.0.0.1",
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

    /// Finding u2 as an address rather than a URL: `::127.0.0.1` is segments
    /// `[0,0,0,0,0,0,0x7f00,0x0001]` — not `::1`, not `::`, `seg[0]` zero so
    /// neither prefix test fired, `seg[5]` zero so the mapped decode never ran.
    /// It was judged public, and the literal-IP branch of the caller has no
    /// resolution check behind it to disagree.
    #[test]
    fn the_ipv4_compatible_form_is_private() {
        // The two spellings are one address: the URL parser canonicalises
        // `[::127.0.0.1]` to `[::7f00:1]` before this table sees it, so the
        // hex spelling is the one an attacker's URL actually arrives as.
        for host in [
            "::127.0.0.1",
            "::7f00:1",
            "::10.0.0.5",
            "::172.16.0.1",
            "::192.168.1.1",
            "::169.254.169.254",
            "::100.64.0.1",
        ] {
            assert!(is_private_or_loopback_host(host), "should flag {host}");
        }
    }

    /// The embedded address is re-checked, not merely recognised: the same
    /// shape has to answer private or public according to the IPv4 table.
    ///
    /// A rule that matched the shape alone — "everything in `::/96` is private"
    /// — would pass the private half of this and fail the public half, and a
    /// rule that knew only `127/8` would fail CGNAT and link-local. Tying each
    /// verdict to the one the guard gives that address written as plain IPv4 is
    /// what makes this table say the whole IPv4 rule set ran.
    #[test]
    fn an_embedded_ipv4_is_rechecked_by_range_not_matched_by_shape() {
        for v4 in [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "8.8.8.8",
            "203.0.113.9",
        ] {
            let expected = is_private_or_loopback_host(v4);
            for prefix in ["::", "::ffff:", "::ffff:0:", "64:ff9b::"] {
                let host = format!("{prefix}{v4}");
                assert_eq!(
                    is_private_or_loopback_host(&host),
                    expected,
                    "{host} must be judged like {v4}, not like its shape"
                );
            }
        }
    }

    /// The forms that carry an IPv4 address at some other position, or by some
    /// other convention, and are left out on purpose.
    ///
    /// They are asserted here so the exclusions are a decision with a name on
    /// it: a later change that widens the guard into "decode the low 32 bits of
    /// everything" would break `2606:4700:4700::1111` in the allow-list above,
    /// and one that adds a second extraction has to argue with this test.
    #[test]
    fn the_forms_carrying_an_ipv4_elsewhere_are_recorded_as_uncovered() {
        for host in [
            "64:ff9b:1:c0a8:1:100::", // RFC 8215 local-use NAT64: v4 split around the u octet
            "2002:7f00:1::",          // 6to4: embedded at bits 16-47, not in the low 32
            "2001::80ff:fffe",        // Teredo: the low 32 bits are COMPLEMENTED 127.0.0.1
            "2001:db8::5efe:7f00:1",  // ISATAP: an IID convention that any prefix may carry
        ] {
            assert!(
                host.parse::<std::net::IpAddr>().is_ok(),
                "{host} must parse, or this test passes without testing anything"
            );
            assert!(
                !is_private_or_loopback_host(host),
                "{host} is uncovered by decision, not by accident"
            );
        }
    }
}
