mod http;
mod pipeline;
mod samples;
mod state;
mod tray;
mod updater;
mod ws;

use axum::routing::{delete, get, post};
use axum::Router;
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, CorsLayer};

use state::AppState;

const ADDR: &str = "127.0.0.1:3000";
const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;

/// The real hosted site -- the desktop app opens THIS in the browser (never
/// a raw `127.0.0.1:...` address), and it's the only origin the local
/// server's CORS policy trusts to reach it cross-origin (see `serve`'s
/// `CorsLayer`). The actual solving still happens entirely on this machine;
/// only the UI shell and its sign-in gate are served from here.
const HOSTED_ORIGIN: &str = "https://rekoncfd.vercel.app";

/// Plain (non-async) `main`: the tray icon's native event loop must own this
/// thread (see `tray::run`'s doc comment) for as long as the app runs, so the
/// Axum server -- and the Tokio runtime it needs -- moves onto its own
/// dedicated thread instead of `#[tokio::main]` claiming this one.
fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("rekon_app=info".parse()?)
                .add_directive("rekon_panel=info".parse()?)
                .add_directive("rekon_lbm=info".parse()?),
        )
        .init();

    std::thread::spawn(|| {
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(err) => {
                tracing::error!(%err, "failed to start the server's Tokio runtime");
                return;
            }
        };
        if let Err(err) = runtime.block_on(serve()) {
            tracing::error!(%err, "server task exited with an error");
        }
    });

    tray::run(ADDR, HOSTED_ORIGIN);
}

async fn serve() -> anyhow::Result<()> {
    let state = AppState::new();

    // The browser now loads the UI from `HOSTED_ORIGIN`, not from this
    // server directly -- its JavaScript reaches back here cross-origin for
    // every API call and the WS connection (see `web/src/net/ws.ts`'s
    // `apiUrl`/`resolveWsUrl`). Exact-origin allowlist, never a wildcard: a
    // wildcard would let ANY website the user happens to have open also
    // talk to their local solver. `/ws` itself doesn't need this layer (a
    // WebSocket handshake has no CORS preflight and this server never
    // checks its Origin header), but applying the layer to the whole
    // Router is harmless there and only actually matters for the HTTP
    // routes below it.
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::exact(HOSTED_ORIGIN.parse().expect("HOSTED_ORIGIN is a valid header value")))
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any)
        // Required for Chrome's Private Network Access check, which gates
        // any request from a public HTTPS origin to a private/loopback
        // address (like 127.0.0.1) behind its own extra preflight.
        .allow_private_network(true);

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route(
            "/api/mesh/import",
            post(http::import_mesh).layer(axum::extract::DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .route("/api/mesh/orient", post(http::orient_mesh))
        .route("/api/mesh/generate", post(http::generate_wing))
        .route("/api/mesh", delete(http::clear_mesh))
        .route("/api/models", get(http::list_models))
        .route("/api/models/{id}/load", post(http::load_model))
        .route("/api/version", get(http::version_info))
        .route("/api/update/apply", post(http::apply_update))
        .fallback(http::static_handler)
        .layer(cors)
        .with_state(state);

    let listener = TcpListener::bind(ADDR).await?;
    tracing::info!("serving on http://{ADDR}, opening {HOSTED_ORIGIN}");

    if let Err(err) = open::that(HOSTED_ORIGIN) {
        tracing::warn!("could not auto-launch browser: {err}");
    }

    axum::serve(listener, app).await?;
    Ok(())
}
