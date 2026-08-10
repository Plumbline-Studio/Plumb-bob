/**
 * Fixture web server.
 *
 * serveFixture(dir) hosts a fixture directory as a static site on an
 * ephemeral 127.0.0.1 port — node:http only, no dependencies — so the REAL
 * engine + REAL browser can drive it exactly like a deployed preview URL.
 * Ephemeral ports let variants (and parallel test runs) serve concurrently.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface FixtureServer {
  /** e.g. "http://127.0.0.1:49321" — hand this to runEngine as previewUrl. */
  url: string;
  close: () => Promise<void>;
}

/** Serve `dir` statically until close(). "/" and directory paths map to index.html. */
export async function serveFixture(dir: string): Promise<FixtureServer> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://fixture").pathname);
        const rel = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
        const file = normalize(join(root, rel));
        // Traversal guard: everything served must stay inside the fixture dir.
        if (file !== root && !file.startsWith(root + sep)) {
          res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
          return;
        }
        const body = await readFile(file);
        res
          .writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" })
          .end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("fixture server failed to bind an ephemeral port");
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((done, fail) => {
        // Drop keep-alive sockets so close() never hangs a test run.
        server.closeAllConnections();
        server.close((err) => (err ? fail(err) : done()));
      }),
  };
}
