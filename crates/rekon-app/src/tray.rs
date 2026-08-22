//! Native Windows system-tray icon: a persistent presence for the app beyond
//! the one browser tab `main` opens on launch, showing basic status/trust
//! info (version, an auto-checked update status, a link to the source) via
//! `tray-icon` + `tao`.
//!
//! `tray-icon`'s own docs: on Windows the tray icon must be created on the
//! SAME thread as a running win32 message loop. `tao::EventLoop::run` blocks
//! forever pumping that loop, so this crate's `main` calls `tray::run` as its
//! very last action on the main thread, with the actual Axum server moved
//! onto a separate dedicated OS thread (see `main.rs`) -- the two can't share
//! a thread since both want to block it forever in their own way.

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIconBuilder, TrayIconEvent};

use crate::updater::{self, VersionInfo};

/// A 64x64 RGBA raster of the Rekon brand mark (cropped from `logo/rekon-logo`,
/// rendered once ahead of time in the project's brand blue) -- embedded
/// directly as raw pixels rather than pulling in an image-decoding crate just
/// to decode one fixed, known-good asset at startup.
const TRAY_ICON_RGBA: &[u8] = include_bytes!("../assets/tray_icon_64x64.rgba");
const TRAY_ICON_DIM: u32 = 64;

const GITHUB_URL: &str = "https://github.com/chiragvx/rekoncfd";

enum UserEvent {
    Tray(TrayIconEvent),
    Menu(MenuEvent),
    UpdateChecked(VersionInfo),
}

fn load_icon() -> Icon {
    Icon::from_rgba(TRAY_ICON_RGBA.to_vec(), TRAY_ICON_DIM, TRAY_ICON_DIM)
        .expect("TRAY_ICON_RGBA is a fixed, known-good 64x64xRGBA buffer generated at build time")
}

/// Builds the tray icon + its context menu and runs the (blocking, native)
/// event loop -- never returns. `tao::EventLoop::run` calls
/// `std::process::exit` internally once `control_flow` is set to `Exit`
/// (the "Quit Rekon" menu item), which is this app's one clean-shutdown path
/// -- it terminates the whole process, including the server's own thread.
pub fn run(addr: &str) -> ! {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();

    // Tray/menu events arrive on tray-icon's own internal handling -- forward
    // them into this event loop via a proxy so they show up as ordinary
    // `Event::UserEvent`s alongside everything else `run`'s match handles.
    let tray_proxy = event_loop.create_proxy();
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = tray_proxy.send_event(UserEvent::Tray(event));
    }));
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = menu_proxy.send_event(UserEvent::Menu(event));
    }));

    let version_item = MenuItem::new(format!("Rekon v{}", env!("CARGO_PKG_VERSION")), false, None);
    let status_item = MenuItem::new(format!("● Server running at {addr}"), false, None);
    let update_item = MenuItem::new("Checking for updates…", false, None);
    let open_item = MenuItem::new("Open Tool", true, None);
    let github_item = MenuItem::new("View source on GitHub", true, None);
    let quit_item = MenuItem::new("Quit Rekon", true, None);

    let tray_menu = Menu::new();
    tray_menu
        .append_items(&[
            &version_item,
            &status_item,
            &update_item,
            &PredefinedMenuItem::separator(),
            &open_item,
            &github_item,
            &PredefinedMenuItem::separator(),
            &quit_item,
        ])
        .expect("appending plain menu items never fails");

    let tooltip = format!("Rekon v{} — running at {addr}", env!("CARGO_PKG_VERSION"));
    let tool_url = format!("http://{addr}/tool");

    // Created inside `run`, once the loop is actually pumping (see tray-icon's
    // own `StartCause::Init` note -- creating it any earlier has been an
    // observed source of icons that silently never show up).
    let mut tray_icon = None;

    // self_update's HTTP call is blocking network I/O -- must never run on
    // this thread, which also owns the win32 message pump the tray icon and
    // its menu depend on to stay responsive.
    let update_proxy = event_loop.create_proxy();
    std::thread::spawn(move || {
        let info = updater::check_for_update();
        let _ = update_proxy.send_event(UserEvent::UpdateChecked(info));
    });

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::NewEvents(StartCause::Init) => {
                tray_icon = Some(
                    TrayIconBuilder::new()
                        .with_menu(Box::new(tray_menu.clone()))
                        .with_tooltip(&tooltip)
                        .with_icon(load_icon())
                        .build()
                        .expect("failed to create the system tray icon"),
                );
            }

            Event::UserEvent(UserEvent::Menu(event)) => {
                if event.id == open_item.id() {
                    let _ = open::that(&tool_url);
                } else if event.id == github_item.id() {
                    let _ = open::that(GITHUB_URL);
                } else if event.id == quit_item.id() {
                    tray_icon.take();
                    *control_flow = ControlFlow::Exit;
                }
            }

            Event::UserEvent(UserEvent::UpdateChecked(info)) => {
                let text = match (info.update_available, &info.latest) {
                    (true, Some(latest)) => format!("Update available: v{latest}"),
                    _ => "Up to date".to_string(),
                };
                update_item.set_text(text);
            }

            // Not acted on (single/double-click on the icon itself is left
            // to the OS default of opening the menu) -- traced for anyone
            // debugging tray click behavior later.
            Event::UserEvent(UserEvent::Tray(event)) => tracing::trace!(?event, "tray icon event"),

            _ => {}
        }
    })
}
