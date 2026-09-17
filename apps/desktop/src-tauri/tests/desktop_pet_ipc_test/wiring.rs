//! The two commands that join the pet window to the agent runtime: the task list it reads, and
//! the click that goes back to the session.
//!
//! Both were reported as missing by the tasks that delivered their halves — D4's projection had no
//! managed state, and D9's rows had no host route — and both are the difference between a pet that
//! can remind a user about work and one that cannot. What is asserted here is what no lower layer
//! can: that the list crosses the real IPC entry in D1's shape, and that a click carries D1's
//! `PetTaskKey` to the main window and nothing else.
//!
//! `commands.rs` next door drives the window operations; these two are here rather than there
//! because their subject is the runtime's tasks, not the windows.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Listener;
use tauri::Manager;

use nekowite_lib::agent_runtime::events::{AgentEventEnvelope, AgentEventKind, AgentIdentity};
use nekowite_lib::commands::desktop_pet as pet_commands;
use nekowite_lib::commands::desktop_pet::PET_TASK_OPEN_CHANNEL;
use nekowite_lib::desktop_pet::notification_delivery::SystemNotifications;
use nekowite_lib::desktop_pet::task_projection::PetTaskState;
use nekowite_lib::desktop_pet::{
    DeliveryState, NotificationOutcome, NotificationPolicy, NotificationPreferences, PetTaskFeed,
    TaskHistory,
};
use nekowite_lib::state::DesktopPetState;

use crate::support::{FakeSurfaces, MAIN_WINDOW};

// The wrappers exist for the reason `commands.rs` documents: `generate_handler!` resolves a
// command through a macro that is `pub(crate)` to the library, so a test in another crate
// registers the library's own functions itself. The parameter names are the wire contract.

#[tauri::command]
fn desktop_pet_tasks(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Vec<nekowite_lib::desktop_pet::PetTaskProjection>, String> {
    pet_commands::desktop_pet_tasks(state)
}

#[tauri::command]
fn desktop_pet_open_task<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    task: nekowite_lib::desktop_pet::PetTaskKey,
) -> Result<(), String> {
    pet_commands::desktop_pet_open_task(app, task)
}

struct Pet {
    app: tauri::App<tauri::test::MockRuntime>,
}

/// A session bus of this test's own, with no notification daemon on it and no way to start one.
///
/// The app's channel is the session's own daemon, so a case that ended a run through the state
/// `with_surfaces` builds would raise a real toast on whoever is running the suite. Pointing the
/// channel at a bus this test started is how it stays a test: it exercises the app's own
/// `SystemNotifications` — the same type, the same call, the same classification — against a bus on
/// which nothing owns `org.freedesktop.Notifications`.
///
/// `<standard_session_servicedirs/>` is what has to be absent for that to be true. A stock session
/// bus *activates* `org.freedesktop.Notifications` from the desktop's own `.service` file the moment
/// anything addresses it — measured on this machine: a plain `dbus-daemon --session` answered
/// `GetCapabilities` with a daemon's capability list, having started one on demand. The policy
/// below is the system's own, verbatim; only service activation is missing.
const BUS_CONFIG: &str = r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"#;

/// Which bus this is, for the config file's name.
static NEXT_BUS: AtomicUsize = AtomicUsize::new(0);

struct PrivateBus {
    child: Child,
    config: std::path::PathBuf,
    address: String,
}

impl PrivateBus {
    fn start() -> Self {
        let config = std::env::temp_dir().join(format!(
            "nekowite-ipc-wiring-bus-{}-{}.conf",
            std::process::id(),
            NEXT_BUS.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&config, BUS_CONFIG).expect("a config file this test can write");
        let mut child = Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--print-address=1", "--nofork"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("dbus-daemon is installed (the `dbus` package)");
        let stdout = child.stdout.take().expect("the pipe just asked for");
        let mut address = String::new();
        let read = BufReader::new(stdout).read_line(&mut address).unwrap_or(0);
        assert!(read > 0, "dbus-daemon printed no address");
        Self {
            child,
            config,
            address: address.trim().to_string(),
        }
    }
}

impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.config);
    }
}

/// The app's state, with the app's own channel pointed at `bus`.
///
/// `with_surfaces` alone would put `SystemNotifications` on the *session* bus, which for a run of
/// this suite means the real desktop. What is substituted is where that channel connects, not what
/// it is — see `tests/desktop_pet_notification_channel_test.rs` for the same channel measured
/// against a daemon that answers.
fn app_on(bus: &PrivateBus) -> Pet {
    let surfaces = FakeSurfaces::new();
    let tasks = PetTaskFeed::with_notifications(NotificationPolicy::new(
        Box::new(SystemNotifications::at(bus.address.as_str())),
        NotificationPreferences::default(),
        TaskHistory::new(),
    ));
    let app = mock_builder()
        .manage(DesktopPetState::with_tasks(Box::new(surfaces), tasks))
        .invoke_handler(tauri::generate_handler![
            desktop_pet_tasks,
            desktop_pet_open_task
        ])
        .build(mock_context(noop_assets()))
        .expect("the pet's task surface builds");
    Pet { app }
}

fn app() -> Pet {
    let surfaces = FakeSurfaces::new();
    let app = mock_builder()
        .manage(DesktopPetState::with_surfaces(Box::new(surfaces)))
        .invoke_handler(tauri::generate_handler![
            desktop_pet_tasks,
            desktop_pet_open_task
        ])
        .build(mock_context(noop_assets()))
        .expect("the pet's task surface builds");
    Pet { app }
}

/// The identity a real start installs, and the frames the runtime publishes for one run.
fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "default".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-a".to_string(),
    }
}

fn envelope(kind: AgentEventKind, payload: Value) -> AgentEventEnvelope {
    AgentEventEnvelope {
        agent_id: "opencode".to_string(),
        profile_id: "default".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-a".to_string(),
        session_id: "ses-1".to_string(),
        run_id: Some("run-0".to_string()),
        sequence: 1,
        kind,
        payload,
    }
}

fn window(pet: &Pet, label: &str) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
    tauri::WebviewWindowBuilder::new(&pet.app, label, tauri::WebviewUrl::default())
        .build()
        .expect("a window")
}

fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    let request = InvokeRequest {
        cmd: cmd.to_string(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().expect("a local URL"),
        body: if body.is_null() {
            InvokeBody::default()
        } else {
            InvokeBody::Json(body)
        },
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(window, request).map(|body| {
        body.deserialize::<Value>()
            .expect("every command answers JSON")
    })
}

#[test]
fn a_window_reads_the_run_the_host_started_over_real_ipc() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    // What the host does when a prompt is sent: the projection is fed from the runtime's own
    // moments, and the window's read is a read of that — the same state `desktop_pet_tasks`
    // answers from, reached here the way the driver reaches it.
    let state = pet.app.state::<DesktopPetState>();
    state.tasks.install(&identity()).expect("a fresh feed");
    state
        .tasks
        .started(&identity(), "ses-1", "run-0")
        .expect("a fresh feed");

    let tasks = call(&main, "desktop_pet_tasks", Value::Null).expect("the list answers");

    assert_eq!(tasks.as_array().expect("a list").len(), 1);
    let task = &tasks[0];
    assert_eq!(task["key"]["runId"], "run-0");
    assert_eq!(task["key"]["sessionId"], "ses-1");
    assert_eq!(task["key"]["runtimeEpoch"], "epoch-1");
    assert_eq!(task["state"], "working");
    assert_eq!(task["permissionRequestId"], Value::Null);
    assert!(
        task["updatedAt"].is_u64(),
        "the host's clock, in epoch ms, as the display subtracts it"
    );
}

#[test]
fn the_list_a_window_reads_is_the_list_a_frame_left() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    let state = pet.app.state::<DesktopPetState>();
    state.tasks.install(&identity()).expect("a fresh feed");
    state
        .tasks
        .started(&identity(), "ses-1", "run-0")
        .expect("a fresh feed");
    state
        .tasks
        .apply(&envelope(
            AgentEventKind::RunFinished,
            json!({ "stopReason": "end-turn" }),
        ))
        .expect("a fresh feed");

    let tasks = call(&main, "desktop_pet_tasks", Value::Null).expect("the list answers");

    // The ending, not a second task and not the working state it had: §6.3's terminal state is the
    // record, and this is what a reminder is drawn from.
    assert_eq!(tasks[0]["state"], "turn-finished");
}

#[test]
fn a_completion_is_recorded_for_the_user_by_the_ledger_the_app_holds() {
    // The reminder half of the same wiring, asserted against the state the app actually manages:
    // `DesktopPetState` builds the feed, and the feed builds §6.3's ledger with this build's own
    // channel — `SystemNotifications`, a real D-Bus call to the session's notification daemon
    // (`notification_delivery.rs`). What this case holds down is the chain a completion travels:
    // frame → projection → ledger → the row the user keeps, with the delivery recorded either way.
    //
    // **Why the channel is pointed at a bus this test started.** The premise this case used to
    // carry — "this build has no channel" — stopped being true when the channel landed, and the
    // delivery is real: driven against the live session bus, the same code put a `Notify` on it
    // and the desktop's own daemon closed the notification it had shown. Asserting that here would
    // make the case depend on the machine it runs on, and raise a toast on whoever runs it. So the
    // one thing substituted is *where the app's channel connects*: the same type, the same call and
    // the same classification, against a bus where nothing owns `org.freedesktop.Notifications`
    // and nothing can be activated to own it. `no-channel` is then a fact about that bus, which is
    // what it always meant: nothing on this session can show a notification.
    //
    // The delivered arm is measured too, and by the channel's own target
    // (`tests/desktop_pet_notification_channel_test.rs`), where a daemon the test serves answers.
    let bus = PrivateBus::start();
    let pet = app_on(&bus);
    let main = window(&pet, MAIN_WINDOW);
    let state = pet.app.state::<DesktopPetState>();
    state.tasks.install(&identity()).expect("a fresh feed");
    state
        .tasks
        .started(&identity(), "ses-1", "run-0")
        .expect("a fresh feed");

    state
        .tasks
        .apply(&envelope(
            AgentEventKind::RunFinished,
            json!({ "stopReason": "end-turn" }),
        ))
        .expect("a fresh feed");

    // Recorded before anything is delivered: the row is the user's from the moment the frame was
    // applied, which is §6.3's 先记录再投递 seen from the outside.
    let due = {
        let ledger = state.tasks.notifications().expect("a fresh ledger");
        let rows = ledger.unread();
        assert_eq!(rows.len(), 1, "the ending is owed to the user");
        assert_eq!(rows[0].state, PetTaskState::TurnFinished);
        assert_eq!(
            rows[0].delivery,
            DeliveryState::NotAttempted,
            "nothing has been asked of the channel yet"
        );
        ledger.pending_due().expect("a completion is gathering")
    };

    // The window's close, which the host reaches from the wake the feed asks for.
    let outcome = state
        .tasks
        .flush_notices(due)
        .expect("a fresh ledger")
        .expect("the burst was due");
    let NotificationOutcome::DeliveryFailed { notice, failure } = &outcome else {
        panic!(
            "nothing on this test's own bus owns org.freedesktop.Notifications, so nothing can \
             have been delivered: {outcome:?}"
        );
    };
    assert_eq!(failure.kind(), "no-channel");
    assert_eq!(
        notice.target.as_ref().map(|key| key.run_id.as_str()),
        Some("run-0"),
        "the notice carries the run a click would return to, even though it cannot be shown"
    );

    // And what survives the toast this machine cannot raise: the row, unread, saying it failed.
    let listed = call(&main, "desktop_pet_tasks", Value::Null).expect("the list answers");
    assert_eq!(
        listed[0]["state"], "turn-finished",
        "the pet window still shows the ending, which is §7.2's unread-list fallback"
    );
    let ledger = state.tasks.notifications().expect("a fresh ledger");
    let rows = ledger.unread();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].delivery, DeliveryState::Failed);
    assert!(rows[0].unread, "a failed delivery is not a seen one");
}

#[test]
fn a_click_on_a_task_reaches_the_main_window_as_the_key_and_nothing_else() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    // Listened for *on the window*, which is how the page that has to act on it hears: the host
    // emits to the `main` label, and a request delivered to a window nobody is listening in is a
    // request answered by nothing (`pet-settings-request.ts` listens the same way).
    let heard = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = Arc::clone(&heard);
    main.listen(PET_TASK_OPEN_CHANNEL, move |event| {
        sink.lock()
            .expect("the listener lock")
            .push(serde_json::from_str(event.payload()).expect("the payload is JSON"));
    });

    let task = json!({
        "agentId": "opencode",
        "profileId": "default",
        "runtimeEpoch": "epoch-1",
        "vaultId": "vault-a",
        "sessionId": "ses-1",
        "runId": "run-0",
    });
    call(&main, "desktop_pet_open_task", json!({ "task": task })).expect("the route answers");

    let heard = heard.lock().expect("the listener lock");
    assert_eq!(heard.len(), 1, "one click is one request");
    // The whole payload is D1's key: a session route, not a URL, not a path, not a window label,
    // and not a command (§6.3's limited target).
    assert_eq!(heard[0], task);
    assert_eq!(heard[0].as_object().expect("an object").len(), 6);
}

#[test]
fn a_click_with_no_main_window_is_refused_in_words() {
    let pet = app();

    // No window labelled `main` exists in this app, which is the "the app was closed" case: the
    // pet does not get to reopen it, and the refusal says which of the two happened.
    let task = json!({
        "agentId": "opencode",
        "profileId": "default",
        "runtimeEpoch": "epoch-1",
        "vaultId": "vault-a",
        "sessionId": "ses-1",
        "runId": "run-0",
    });
    let router = window(&pet, "pet-1");
    let refusal = call(&router, "desktop_pet_open_task", json!({ "task": task }))
        .expect_err("there is nowhere to show the session");

    let sentence = refusal.as_str().expect("a sentence, not a code");
    assert!(sentence.contains("main window"), "{sentence}");
}
