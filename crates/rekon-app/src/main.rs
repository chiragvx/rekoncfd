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

use state::AppState;

const ADDR: &str = "127.0.0.1:3000";
const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;

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

    tray::run(ADDR);
}

async fn serve() -> anyhow::Result<()> {
    let state = AppState::new();

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
        .with_state(state);

    let listener = TcpListener::bind(ADDR).await?;
    let url = format!("http://{ADDR}");
    tracing::info!("serving on {url}");

    if let Err(err) = open::that(&url) {
        tracing::warn!("could not auto-launch browser: {err}");
    }

    axum::serve(listener, app).await?;
    Ok(())
}
