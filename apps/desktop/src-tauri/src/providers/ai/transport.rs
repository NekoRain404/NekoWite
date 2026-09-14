//! The HTTP transport every AI request is dialled through: the per-phase
//! timeouts it is built with, the redirect refusal and the vetted-address pin.
//!
//! Extracted from [`super::client`] as one vertical slice - the dial, rather
//! than a step inside a request - because both entry points that leave this
//! layer (`client::list_models` and `client::stream_complete`) hand their
//! decisions to it, and because the redirect test below is its test, not the
//! loop's. The function stays crate-visible: nothing outside this layer builds a
//! client, and `client` calls it by path.
//!
//! Dependencies: [`super::url_policy`] for the [`VettedHost`] it pins to, and
//! the per-phase timeouts the caller reads from `limits`. Nothing here imports
//! `client`, so the graph keeps its one-way direction.

use std::time::Duration;

use super::url_policy::VettedHost;

/// Build the HTTP client used for every AI request.
///
/// Two things here are security-relevant, not style:
///
///   * **Redirects are refused.** Following one means the request can land on
///     an origin the SSRF check never saw — a `302` to `http://127.0.0.1:11434/`
///     or to an attacker's host. `reqwest` strips `Authorization` on a
///     cross-origin redirect but does NOT touch the custom headers the non-OpenAI
///     providers authenticate with (`x-api-key`, `x-goog-api-key`), so a followed
///     redirect would hand over the user's key. The AI providers do not need
///     redirects; a redirect here is an error, not a hop to follow.
///   * **The vetted addresses are pinned** via `resolve_to_addrs`, so the name
///     cannot resolve to a different address between the check and the connect.
pub(super) fn ai_http_client(
    connect_timeout: Duration,
    read_timeout: Duration,
    pin: Option<&VettedHost>,
) -> Result<reqwest::Client, reqwest::Error> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(pin) = pin {
        if !pin.addrs.is_empty() {
            builder = builder.resolve_to_addrs(&pin.host, &pin.addrs);
        }
    }
    builder.build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A followed redirect can leave the vetted origin, and the custom auth
    /// headers the non-OpenAI providers use (`x-api-key`, `x-goog-api-key`) are
    /// NOT stripped by reqwest the way `Authorization` is — so the key would go
    /// to whatever host the redirect names. This drives a real 302 to prove the
    /// client surfaces it instead of following.
    #[tokio::test]
    async fn the_ai_client_does_not_follow_a_redirect() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a loopback port");
        let addr = listener.local_addr().expect("local addr");
        let target_hit = Arc::new(AtomicBool::new(false));
        let hit_by_server = target_hit.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let hit = hit_by_server.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = sock.read(&mut buf).await;
                    let req = String::from_utf8_lossy(&buf).to_string();
                    let response = if req.starts_with("GET /target") {
                        hit.store(true, Ordering::SeqCst);
                        "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nhit!!!"
                            .to_string()
                    } else {
                        format!(
                            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/target\r\n\
                             Content-Length: 0\r\nConnection: close\r\n\r\n",
                            addr.port()
                        )
                    };
                    let _ = sock.write_all(response.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        let client = ai_http_client(Duration::from_secs(5), Duration::from_secs(5), None)
            .expect("client builds");
        let response = client
            .get(format!("http://127.0.0.1:{}/start", addr.port()))
            .send()
            .await
            .expect("the 302 itself is a valid response");

        assert_eq!(
            response.status().as_u16(),
            302,
            "the redirect must be surfaced as the response, not followed"
        );
        assert!(
            !target_hit.load(Ordering::SeqCst),
            "the redirect target must never be requested"
        );
        server.abort();
    }
}
