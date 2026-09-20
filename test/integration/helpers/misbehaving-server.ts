import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * How a fixture server answers.
 *
 * `silent` accepts the socket, reads the whole request and never writes a
 * response — the shape a request timeout exists for. `stalled` writes status,
 * headers and one chunk and then holds the socket open without writing again
 * and without ending — the shape a *request* timeout provably cannot cover,
 * because the handler resolves at the headers and clears its timers there.
 * `healthy` answers normally and is the control that proves the client can
 * reach the fixture at all.
 */
export type Misbehaviour = 'healthy' | 'silent' | 'stalled';

/** Options for {@link startMisbehavingServer}. */
export interface MisbehavingServerOptions {
  behaviour: Misbehaviour;
  /** The whole body a `healthy` server writes, or the one chunk a `stalled` one flushes. */
  body?: string;
  /** Sent as `content-type`; the awsJson protocols want their own, S3 wants bytes. */
  contentType?: string;
}

/** A running fixture server, and the handles a test needs to end it. */
export interface MisbehavingServer {
  /** The origin to hand a client as its `endpoint`, e.g. `http://127.0.0.1:53124`. */
  url: string;
  /** How many requests reached it. A fixture nobody reached proves nothing. */
  requests: () => number;
  /**
   * Destroy every open socket. Releases a caller still reading a stalled body,
   * which is how a test tells "nothing released it" from "the read was dead
   * all along".
   */
  dropConnections: () => void;
  close: () => Promise<void>;
}

/** Write whatever this behaviour writes, which for `silent` is nothing at all. */
function answer(behaviour: Misbehaviour, body: string, contentType: string, res: ServerResponse) {
  if (behaviour === 'silent') return;
  res.writeHead(200, { 'content-type': contentType });
  if (behaviour === 'healthy') {
    res.end(body);
    return;
  }
  res.write(body);
}

/**
 * Start a server on `127.0.0.1` that misbehaves in one named way.
 *
 * Accepts: `options.behaviour` — see {@link Misbehaviour}. `options.body` and
 * `options.contentType` — what a `healthy` server answers with and what a
 * `stalled` one flushes before it stops.
 *
 * Returns: the running server. It binds port 0 and reports the assigned port,
 * so nothing collides with the DynamoDB Local container or a parallel worker.
 *
 * Throws: whatever `listen` rejects with.
 *
 * Guarantees: every server-side timeout is disabled, so the only thing that can
 * end a request is the client's own bound — which is the whole point of the
 * fixture. Every accepted socket is tracked and destroyed by `close()`, so a
 * held-open socket cannot keep the Jest worker alive past the run.
 */
export async function startMisbehavingServer(
  options: MisbehavingServerOptions,
): Promise<MisbehavingServer> {
  const body = options.body ?? 'chunk';
  const contentType = options.contentType ?? 'application/octet-stream';
  const sockets = new Set<Socket>();
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    req.once('end', () => answer(options.behaviour, body, contentType, res));
  });
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dropConnections = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests,
    dropConnections,
    close: async () => {
      dropConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
