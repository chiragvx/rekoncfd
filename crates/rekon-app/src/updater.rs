//! Self-update against GitHub Releases. The desktop `.exe` build is the only
//! distribution that needs this -- a hosted web deployment is just
//! redeployed whenever we ship, so it never goes stale the way a
//! downloaded-once binary on someone's machine would.
//!
//! `self_update`'s HTTP calls are blocking (a `ureq`/`reqwest` blocking
//! client, not tokio-aware), so every call into this module from an async
//! handler MUST go through `spawn_blocking` -- same rule this codebase
//! already follows for the panel-method solve and voxelizer.

use self_update::cargo_crate_version;
use serde::Serialize;

/// GitHub repo hosting release builds. Every check below still fails closed
/// (network/API error) until an actual release is cut there -- see
/// `check_for_update`, which treats that as "no update available" rather
/// than surfacing an error to the user.
const REPO_OWNER: &str = "chiragvx";
const REPO_NAME: &str = "rekoncfd";

/// Must match the actual built binary name (`cargo build` produces
/// `rekon-app.exe` on Windows) -- `self_update` appends the platform exe
/// suffix automatically, so this stays extension-less.
const BIN_NAME: &str = "rekon-app";

#[derive(Debug, Clone, Serialize)]
pub struct VersionInfo {
    pub current: String,
    pub latest: Option<String>,
    pub update_available: bool,
    pub release_notes: Option<String>,
}

fn configure() -> self_update::backends::github::UpdateBuilder {
    let mut builder = self_update::backends::github::Update::configure();
    builder
        .repo_owner(REPO_OWNER)
        .repo_name(REPO_NAME)
        .bin_name(BIN_NAME)
        .current_version(cargo_crate_version!())
        .no_confirm(true)
        .show_output(false)
        .show_download_progress(false);
    builder
}

/// Checks GitHub Releases for a version newer than the one currently
/// running. Read-only -- never downloads or modifies anything.
///
/// Deliberately never returns an `Err`: this runs opportunistically (e.g. on
/// every `/api/version` poll from the UI), and a flaky network call or a
/// not-yet-existing repo/release should read as "no update available", not
/// as an application error surfaced to the user.
pub fn check_for_update() -> VersionInfo {
    let current = cargo_crate_version!().to_string();

    let release = configure()
        .build()
        .and_then(|updater| updater.get_latest_release());

    match release {
        Ok(release) => {
            let update_available = self_update::version::bump_is_greater(&current, &release.version).unwrap_or(false);
            VersionInfo {
                current,
                latest: Some(release.version),
                update_available,
                release_notes: release.body,
            }
        }
        Err(err) => {
            tracing::warn!("update check failed (this is expected until a real release exists): {err}");
            VersionInfo { current, latest: None, update_available: false, release_notes: None }
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyUpdateError {
    #[error(transparent)]
    SelfUpdate(#[from] self_update::errors::Error),
}

/// Downloads the latest release and replaces the CURRENTLY RUNNING
/// executable in place, via `self_replace` (which handles Windows' "can't
/// overwrite your own open exe file" restriction with a rename-on-exit
/// trick). The OLD code stays resident in memory until the process exits --
/// callers must tell the user to relaunch afterward; this does not, and
/// safely cannot, restart the process itself.
pub fn apply_update() -> Result<String, ApplyUpdateError> {
    let status = configure().build()?.update()?;
    Ok(status.version().to_string())
}
