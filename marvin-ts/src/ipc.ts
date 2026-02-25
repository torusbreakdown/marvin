/**
 * IPC socket for external processes (e.g., wake word detector) to send commands
 * to a running Marvin instance.
 *
 * Protocol: newline-delimited plain text commands over a Unix domain socket.
 * Commands: "wake" (start voice recording), "ping" (health check)
 * Responses: "OK\n" or "ERR <message>\n"
 */
import { createServer, type Server } from 'node:net';
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SOCK_DIR = join(tmpdir(), 'marvin');
const SOCK_PATH = join(SOCK_DIR, 'marvin.sock');
const PID_PATH = join(SOCK_DIR, 'marvin.pid');

export type IpcHandler = (command: string) => string;

let server: Server | null = null;

/**
 * Start the IPC socket server. The handler is called for each command received.
 * Returns the socket path.
 */
export function startIpcServer(handler: IpcHandler): string {
  mkdirSync(SOCK_DIR, { recursive: true });

  // Clean up stale socket
  if (existsSync(SOCK_PATH)) {
    try { unlinkSync(SOCK_PATH); } catch { /* ignore */ }
  }

  server = createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const cmd = line.trim();
        if (!cmd) continue;
        try {
          const result = handler(cmd);
          socket.write(result + '\n');
        } catch (err) {
          socket.write(`ERR ${(err as Error).message}\n`);
        }
      }
    });
    socket.on('error', () => {}); // ignore client disconnects
  });

  server.listen(SOCK_PATH);

  // Write PID file so external processes can find us
  writeFileSync(PID_PATH, String(process.pid));

  return SOCK_PATH;
}

/**
 * Stop the IPC server and clean up socket/pid files.
 */
export function stopIpcServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  try { unlinkSync(SOCK_PATH); } catch { /* ignore */ }
  try { unlinkSync(PID_PATH); } catch { /* ignore */ }
}

/** Exported for external processes to know where to connect. */
export { SOCK_PATH, PID_PATH };
