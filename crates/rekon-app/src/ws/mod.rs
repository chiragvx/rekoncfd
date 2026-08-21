mod bank_sweep;
mod connection;
mod lbm;
mod panel;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::State;
use axum::response::IntoResponse;

use crate::state::AppState;

pub async fn ws_handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| connection::handle_socket(socket, state))
}
