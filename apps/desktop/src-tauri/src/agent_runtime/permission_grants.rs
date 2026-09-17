//! The permissions the user granted "always", read and removed through the engine's own HTTP API.
//!
//! ## Why this is not a table this app keeps
//!
//! `Always allow` is not the session's answer, and treating it as one was the premise
//! `permission-configured.md` §5 corrected by measurement: the engine writes the grant into its
//! own database (`XDG_DATA_HOME/opencode/opencode.db`, inside the profile root), keyed by
//! `(project_id, action, resource)`, and every later evaluation loads it. A later session on the
//! same profile is asked nothing at all. So there is exactly one table, it is the engine's, and
//! this module is a **view and a delete on it** — never a second mechanism, never a copy that
//! could disagree about what is in force.
//!
//! ## How the engine is reached, and why the port is pinned
//!
//! `opencode acp` starts the engine's own HTTP server before it speaks ACP, and the routes this
//! module calls are that server's ([`HttpApi`], read out of the artifact). The server's port is
//! `--port` when it is given and a kernel-assigned one otherwise — undiscoverable from outside —
//! so [`pin_http`] chooses a port and appends the adapter's flag to the launch. `EngineConnection`
//! then owns the whole process, so "the engine that answered" is the engine this session is
//! already talking to.
//!
//! ## What a caller may not do with this
//!
//! **Nothing here decides anything.** The engine evaluates the rules; this reads what it holds and
//! asks it to drop one row. An empty list is therefore the engine's own statement that it has
//! written nothing down, and [`GrantsReadout::Unsupported`] is the different statement that this
//! agent cannot be asked at all. The two must never be rendered as the same page.

use std::net::TcpListener;
use std::time::Duration;

use serde::Serialize;

use super::adapters::HttpApi;
use super::process::EngineLaunch;

/// How long one call to the engine gets.
///
/// Bounded as a whole rather than per read, like `commands/agent_catalogue.rs`'s fetch and for the
/// same reason. It is a loopback call to a process this app started, so the bound is generous
/// rather than tight: a value that times out here is a state the page reports with a retry, and a
/// false timeout on a slow machine would be a page that lies about the engine.
const CALL_BOUND: Duration = Duration::from_secs(10);

/// A live engine's own HTTP surface: the adapter's routes and the port this launch bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineHttp {
    pub port: u16,
    pub api: HttpApi,
}

impl EngineHttp {
    /// The address one route lives at, on loopback.
    ///
    /// The engine's default hostname is `127.0.0.1` and this app writes no `server` member, so the
    /// address is the only one its server is on. An engine configured to bind somewhere else
    /// answers nothing here, which the caller reports as an unreadable readout — never as "no
    /// grants".
    fn url(&self, route: &str) -> String {
        format!("http://127.0.0.1:{}{route}", self.port)
    }
}

/// Pins the port the engine's own server binds, when this engine has one.
///
/// The port comes from the kernel (`bind` to port 0, read it back, release it), so it is free at
/// the moment it is chosen. The window between that and the engine's own bind is the one risk this
/// takes, and it is taken deliberately: the alternative is to let the engine pick, and then
/// **nothing outside the process can learn which port it picked** — the engine logs no URL, writes
/// no file, and its route table is reachable only through the socket. A collision makes the engine
/// fail to start, which surfaces as a launch failure with the engine's own stderr attached; it
/// cannot be mistaken for an engine that started and holds no grants.
///
/// `None` in, `None` out: an engine whose adapter knows no HTTP surface gets no flag, and its
/// grants are reported as unsupported rather than as empty.
pub fn pin_http(launch: &mut EngineLaunch, api: Option<HttpApi>) -> Option<EngineHttp> {
    let api = api?;
    let listener = TcpListener::bind("127.0.0.1:0").ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    launch.args.push(api.port_flag.to_string());
    launch.args.push(port.to_string());
    Some(EngineHttp { port, api })
}

/// One permission the engine has written down: its own four fields, verbatim.
///
/// `project_id` is the engine's own key for the folder the grant covers and `resource` its own
/// spelling of what the grant is about (the `edit` tool saves `*`, a blanket allow for the whole
/// project). Neither is renamed into this app's vocabulary: a page that relabelled them would be
/// describing a rule the engine is not evaluating.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedGrant {
    pub id: String,
    pub project_id: String,
    pub action: String,
    pub resource: String,
}

/// What this host can say about the engine's written-down permissions.
///
/// Three arms because there are three different truths, and the whole point of the surface is that
/// they are not confused: [`Listed`](Self::Listed) with no rows is the engine saying it has written
/// nothing down, [`Unsupported`](Self::Unsupported) is an agent that cannot be asked, and
/// [`NotRunning`](Self::NotRunning) is a question with nothing to answer it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum GrantsReadout {
    /// The engine answered, and this is what it holds for this profile.
    Listed { grants: Vec<SavedGrant> },
    /// The connected agent has no verified HTTP surface, so nothing here can list or remove a
    /// grant. Not the same claim as "you have given none".
    Unsupported,
    /// No engine is running: there is no table to read.
    NotRunning,
}

/// What the engine currently holds, or why it cannot be asked.
///
/// `Err` is reserved for one thing: the engine could not be asked. It is not a fourth arm, because
/// the three arms are *answers* — "this is what is written down", "this agent has no such route",
/// "no engine is running" — and a page that rendered a failed call as any of them would be
/// reporting a state nobody established. The caller renders it as unreadable, with a retry.
pub async fn list(http: Option<EngineHttp>) -> Result<GrantsReadout, String> {
    let Some(http) = http else {
        return Ok(GrantsReadout::Unsupported);
    };
    Ok(GrantsReadout::Listed {
        grants: fetch(&http).await?,
    })
}

/// Removes one grant and answers what the engine holds afterwards.
///
/// The list is re-read rather than the row removed from the caller's copy: the engine is the
/// authority on what is in force, and a page that struck a row out itself would be showing its own
/// belief about a removal whose only evidence is the engine's next answer.
pub async fn remove(http: Option<EngineHttp>, grant_id: &str) -> Result<GrantsReadout, String> {
    let Some(http) = http else {
        return Ok(GrantsReadout::Unsupported);
    };
    // The id is a *path segment* of the engine's own route, so it is checked before it is put in
    // one: a renderer-supplied string that reached this point unchecked could address a different
    // route than the one this function means to call. The shape is the engine's (`psv_…`), and
    // anything outside it is refused rather than encoded.
    if grant_id.is_empty()
        || !grant_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "{grant_id:?} is not a shape this host will put in a URL path; a saved permission's id \
             is the engine's own, and this one did not come from the engine's list"
        ));
    }
    let response = client()?
        .delete(format!(
            "{}/{}",
            http.url(http.api.saved_permission),
            grant_id
        ))
        .timeout(CALL_BOUND)
        .send()
        .await
        .map_err(|error| format!("asking the engine to remove a grant: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "the engine refused the removal of {grant_id}: {status}"
        ));
    }
    list(Some(http)).await
}

/// The engine's own list, as its route answers it.
async fn fetch(http: &EngineHttp) -> Result<Vec<SavedGrant>, String> {
    let response = client()?
        .get(http.url(http.api.saved_permissions))
        .timeout(CALL_BOUND)
        .send()
        .await
        .map_err(|error| format!("asking the engine for its saved permissions: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "the engine answered {status} for its saved permissions"
        ));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("the engine's saved permissions are not JSON: {error}"))?;
    let rows = body
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "the engine's saved permissions carry no `data` list".to_string())?;
    rows.iter()
        .map(|row| {
            let field = |name: &str| -> Result<String, String> {
                row.get(name)
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| {
                        format!("a saved permission has no readable `{name}`; this host will not guess one")
                    })
            };
            Ok(SavedGrant {
                id: field("id")?,
                project_id: field("projectID")?,
                action: field("action")?,
                resource: field("resource")?,
            })
        })
        .collect()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .build()
        .map_err(|error| format!("could not build an HTTP client: {error}"))
}
