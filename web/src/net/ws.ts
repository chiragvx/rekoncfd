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
