use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use rekon_protocol::{decode_f32_frame, encode_f32_frame, encode_mesh_geometry, tags};
use tokio::sync::mpsc;

use crate::state::{AppState, MeshRecord};
use crate::ws::bank_sweep;
use crate::ws::lbm;
use crate::ws::panel::{self, SliderState};

/// Depth 2: `SolveProgress` is explicitly droppable (see the protocol design
/// in the project plan) — a slow client should never make the solve loop
/// block on `try_send`, and only the latest couple of progress updates are
/// ever worth keeping around.
const LBM_CHANNEL_DEPTH: usize = 2;

/// A panel model rebuilt at some nonzero bank angle, cached per-connection so
/// dragging OTHER sliders (alpha/V/CG) at a held bank doesn't rebuild the AIC
/// on every tick -- only an actual bank CHANGE does that. `None` means "wings
/// level", i.e. use `MeshRecord::panel_model` (built once at import) directly
/// rather than a per-connection rebuild.
type BankModelCache = Option<(f32, rekon_panel::PanelModel)>;

pub async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let mut mesh_rx = state.current_mesh.subscribe();
    let mut current: Option<Arc<MeshRecord>> = None;
    let mut slider_state: Option<SliderState> = None;
    let mut bank_model: BankModelCache = None;
    let (lbm_tx, mut lbm_rx) = mpsc::channel::<Vec<u8>>(LBM_CHANNEL_DEPTH);

    // A fresh/reconnecting client should see whatever mesh is already loaded,
    // not wait for the next import. Cloned out of a separate `let` so the
    // `watch::Ref` guard (not `Send`) drops before the `.await` below. A
    // reconnecting client with no mesh loaded gets an explicit MESH_CLEARED
    // too -- otherwise one that reconnects after the mesh was cleared while
    // briefly disconnected would keep showing whatever it rendered before.
    let initial = mesh_rx.borrow().clone();
    match initial {
        Some(record) => {
            if send_mesh(&mut socket, &record).await.is_err() {
                return;
            }
            slider_state = send_default_panel_result(&mut socket, &record).await;
            current = Some(record);
        }
        None => {
            if send_mesh_cleared(&mut socket).await.is_err() {
                return;
            }
        }
    }

    loop {
        tokio::select! {
            changed = mesh_rx.changed() => {
                if changed.is_err() {
                    break; // sender dropped — server is shutting down
                }
                let latest = mesh_rx.borrow_and_update().clone();
                match latest {
                    Some(record) => {
                        if send_mesh(&mut socket, &record).await.is_err() {
                            break;
                        }
                        slider_state = send_default_panel_result(&mut socket, &record).await;
                        bank_model = None; // a new/reoriented mesh invalidates any cached bank rebuild
                        current = Some(record);
                    }
                    None => {
                        current = None;
                        slider_state = None;
                        bank_model = None;
                        if send_mesh_cleared(&mut socket).await.is_err() {
                            break;
                        }
                    }
                }
            }
            Some(frame) = lbm_rx.recv() => {
                if socket.send(Message::Binary(frame.into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Binary(bytes))) => {
                        if handle_binary_message(&mut socket, &bytes, &state, current.as_ref(), &mut slider_state, &mut bank_model, &lbm_tx).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn handle_binary_message(
    socket: &mut WebSocket,
    bytes: &[u8],
    state: &AppState,
    current: Option<&Arc<MeshRecord>>,
    slider_state: &mut Option<SliderState>,
    bank_model: &mut BankModelCache,
    lbm_tx: &mpsc::Sender<Vec<u8>>,
) -> Result<(), axum::Error> {
    let Some((tag, payload)) = decode_f32_frame(bytes) else { return Ok(()) };

    if tag == tags::SLIDER_UPDATE {
        let Some(slider) = panel::decode_slider_update(&payload) else { return Ok(()) };
        *slider_state = Some(slider);
        let Some(record) = current else { return Ok(()) };

        // Wings level: use the model built once at import, no rebuild.
        if slider.bank_deg.abs() < 1e-3 {
            *bank_model = None;
            return send_panel_result(socket, Some(record.as_ref()), &slider).await;
        }

        // Held at the same bank angle as last time (e.g. the user is only
        // dragging alpha/V/CG right now): reuse the cached rebuild instead of
        // refactoring the AIC again.
        if let Some((cached_bank, model)) = bank_model.as_ref() {
            if (*cached_bank - slider.bank_deg).abs() < 1e-3 {
                let result = match model.solve(slider.freestream) {
                    Ok(r) => r,
                    Err(err) => {
                        tracing::warn!(mesh_id = record.mesh_id, %err, "panel-method solve failed for held bank angle");
                        return Ok(());
                    }
                };
                let flow = rekon_panel::surface_flow(model, &result);
                let coeffs = rekon_panel::coefficients(model, &result, &flow, slider.cg);
                let rotated = record.mesh.rotated_around_x(slider.bank_deg);
                let vertex_cp = panel::per_vertex_cp(&rotated, &flow.cp);
                let frame = panel::encode_panel_result_raw(coeffs, &vertex_cp);
                return socket.send(Message::Binary(frame.into())).await;
            }
        }

        // A genuine bank CHANGE: rebuild the AIC from scratch on a fresh
        // spawn_blocking thread (this is real CPU work, not something the
        // async task should ever do inline) using the SAME routine the
        // bank-sweep animation calls per frame.
        let record = record.clone();
        let bank_deg = slider.bank_deg;
        let solved = tokio::task::spawn_blocking(move || {
            panel::solve_panel_at_bank(&record, bank_deg, slider.freestream, slider.cg)
        })
        .await;
        return match solved {
            Ok(Ok(solve)) => {
                let frame = panel::encode_panel_result_raw(solve.coeffs, &solve.vertex_cp);
                let sent = socket.send(Message::Binary(frame.into())).await;
                *bank_model = Some((bank_deg, solve.panel_model));
                sent
            }
            Ok(Err(err)) => {
                tracing::warn!(%bank_deg, %err, "panel-method rebuild failed at new bank angle");
                Ok(())
            }
            Err(join_err) => {
                tracing::warn!(%join_err, "bank-angle rebuild task panicked");
                Ok(())
            }
        };
    }

    if tag == tags::TRIM_REQUEST {
        let bracket = panel::decode_trim_request(&payload);
        let Some(record) = current else { return Ok(()) };
        let model = match bank_model.as_ref() {
            Some((_, m)) => m,
            None => {
                let Some(m) = &record.panel_model else { return Ok(()) };
                m
            }
        };
        let Some(state) = slider_state.as_ref() else { return Ok(()) };
        return match panel::encode_trim_result(model, state, bracket) {
            Ok(frame) => socket.send(Message::Binary(frame.into())).await,
            Err(err) => {
                tracing::warn!(mesh_id = record.mesh_id, %err, "trim search's panel solve failed");
                Ok(())
            }
        };
    }

    if tag == tags::POLAR_REQUEST {
        let Some((alpha_min, alpha_max, n_points)) = panel::decode_polar_request(&payload) else { return Ok(()) };
        let Some(record) = current else { return Ok(()) };
        let model = match bank_model.as_ref() {
            Some((_, m)) => m,
            None => {
                let Some(m) = &record.panel_model else { return Ok(()) };
                m
            }
        };
        let Some(state) = slider_state.as_ref() else { return Ok(()) };
        return match panel::encode_polar_curve(model, state, alpha_min, alpha_max, n_points) {
            Ok(frame) => socket.send(Message::Binary(frame.into())).await,
            Err(err) => {
                tracing::warn!(mesh_id = record.mesh_id, %err, "polar sweep's panel solve failed");
                Ok(())
            }
        };
    }

    if tag == tags::MULTI_BANK_SWEEP_REQUEST {
        let Some(request) = bank_sweep::decode_request(&payload) else { return Ok(()) };
        let Some(record) = current else { return Ok(()) };
        let Some(slider) = slider_state.as_ref().copied() else { return Ok(()) };

        // Same supersede-on-newer-request mechanism as the on-demand LBM
        // solve: bumping this generation cancels an in-flight batch if
        // another request, a reorient, or a mesh clear arrives mid-run.
        let generation = state.solve_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let current_generation = state.solve_generation.clone();
        let record = record.clone();
        let tx = lbm_tx.clone();
        tokio::task::spawn_blocking(move || {
            bank_sweep::run(record, slider, request, generation, current_generation, tx);
        });
    }

    if tag == tags::SOLVE_FLOW_FIELD_REQUEST {
        let Some(request) = lbm::decode_solve_request(&payload) else { return Ok(()) };
        let Some(record) = current else { return Ok(()) };

        let generation = state.solve_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let current_generation = state.solve_generation.clone();
        let record = record.clone();
        let tx = lbm_tx.clone();
        tokio::task::spawn_blocking(move || {
            lbm::run_solve(record, request, generation, current_generation, tx);
        });
    }

    Ok(())
}

async fn send_mesh_cleared(socket: &mut WebSocket) -> Result<(), axum::Error> {
    let frame = encode_f32_frame(tags::MESH_CLEARED, &[]);
    socket.send(Message::Binary(frame.into())).await
}

async fn send_mesh(socket: &mut WebSocket, record: &Arc<MeshRecord>) -> Result<(), axum::Error> {
    let mesh = &record.mesh;
    let normals = mesh.vertex_normals();

    let mut positions = Vec::with_capacity(mesh.vertices.len() * 3);
    for v in &mesh.vertices {
        positions.extend_from_slice(&[v.x, v.y, v.z]);
    }
    let mut normal_floats = Vec::with_capacity(normals.len() * 3);
    for n in &normals {
        normal_floats.extend_from_slice(&[n.x, n.y, n.z]);
    }
    let indices: Vec<u32> = mesh.triangles.iter().flat_map(|t| t.iter().copied()).collect();

    let frame = encode_mesh_geometry(tags::MESH_GEOMETRY, &positions, &normal_floats, &indices);
    socket.send(Message::Binary(frame.into())).await
}

/// Sends an initial `PanelResult` at a sensible default AoA/V/CG so the
/// pressure colormap has something to show immediately after import, not
/// just after the user first touches a slider. Returns the `SliderState`
/// that was used, so later `SliderUpdate` messages start from it.
async fn send_default_panel_result(socket: &mut WebSocket, record: &Arc<MeshRecord>) -> Option<SliderState> {
    let state = panel::default_slider_state(record.chord_estimate_m);
    if send_panel_result(socket, Some(record), &state).await.is_ok() {
        Some(state)
    } else {
        None
    }
}

async fn send_panel_result(
    socket: &mut WebSocket,
    record: Option<&MeshRecord>,
    state: &SliderState,
) -> Result<(), axum::Error> {
    let Some(record) = record else { return Ok(()) };
    let Some(model) = &record.panel_model else { return Ok(()) };

    match panel::encode_panel_result(&record.mesh, model, state) {
        Ok(frame) => socket.send(Message::Binary(frame.into())).await,
        Err(err) => {
            tracing::warn!(mesh_id = record.mesh_id, %err, "panel-method solve failed for this slider state");
            Ok(())
        }
    }
}
