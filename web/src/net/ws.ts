type RawHandler = (buffer: ArrayBuffer) => void;

const RECONNECT_DELAY_MS = 1000;

export class RekonSocket {
  private readonly url: string;
  private socket: WebSocket | null = null;
  private handlers = new Map<number, RawHandler>();
  private onStatusChange: (status: "connecting" | "open" | "closed") => void = () => {};

  constructor(url: string) {
    this.url = url;
  }

  onStatus(cb: (status: "connecting" | "open" | "closed") => void) {
    this.onStatusChange = cb;
  }

  /** Handler receives the raw frame buffer (tag included) — decode it with the
   * message-type-specific decoder from `./protocol` (`decodeFrame` for f32
   * payloads, `decodeMeshGeometry` for mesh frames, etc). */
  on(tag: number, handler: RawHandler) {
    this.handlers.set(tag, handler);
  }

  connect() {
    this.onStatusChange("connecting");
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => this.onStatusChange("open"));

    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 4) return;
      const tag = new DataView(event.data, 0, 4).getUint32(0, true);
      this.handlers.get(tag)?.(event.data);
    });

    socket.addEventListener("close", () => {
      this.onStatusChange("closed");
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    socket.addEventListener("error", () => socket.close());

    this.socket = socket;
  }

  send(buffer: ArrayBuffer) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(buffer);
    }
  }
}

export function wsUrlForCurrentHost(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

/** The desktop app's local solver server -- always this fixed address (see
 * `rekon-app`'s `ADDR` constant). The hosted site's JS reaches back to this
 * cross-origin for every API call and the WS connection; the local server's
 * CORS policy only trusts the hosted origin to do so (see `main.rs`'s
 * `CorsLayer`). */
const LOCAL_SERVER_ORIGIN = "http://127.0.0.1:3000";

/** True when this page IS the local server (opened directly, e.g. running
 * `cargo run`/the embedded build without going through the hosted site at
 * all) -- same-origin, no cross-origin plumbing needed. */
function isLocalOrigin(): boolean {
  return window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
}

/** Resolves a `/api/...` path to wherever the local solver server actually
 * is: same-origin if this page IS that server, otherwise the local
 * companion's fixed address (this page is the hosted site instead). */
export function apiUrl(path: string): string {
  return isLocalOrigin() ? path : `${LOCAL_SERVER_ORIGIN}${path}`;
}

/** Same resolution as `apiUrl`, but for the WS connection -- replaces
 * `wsUrlForCurrentHost` as the one used by `RekonEngine`, which only ever
 * needs to reach the local solver, never "whatever origin this page happens
 * to be" for its own sake. */
export function resolveWsUrl(path: string): string {
  if (isLocalOrigin()) return wsUrlForCurrentHost(path);
  return `ws:${LOCAL_SERVER_ORIGIN.slice("http:".length)}${path}`;
}
