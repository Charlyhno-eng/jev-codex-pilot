import { createServer as createHttpServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createServer } from "vite";
import { expect, it } from "vitest";

it("preserves the browser authority and origin through the development API proxy", async () => {
  const backend = createHttpServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin }));
  });
  await new Promise<void>(done => backend.listen(0, "127.0.0.1", done));
  const apiPort = (backend.address() as AddressInfo).port;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    vite = await createServer({
      configFile: resolve("vite.config.ts"),
      server: { port: 0, proxy: { "/api": { target: `http://127.0.0.1:${apiPort}` } } }
    });
    await vite.listen();
    const webPort = (vite.httpServer!.address() as AddressInfo).port;
    expect(webPort).not.toBe(apiPort);
    for (const hostname of ["localhost", "127.0.0.1"]) {
      const host = `${hostname}:${webPort}`;
      const origin = `http://${host}`;
      const result = await new Promise<unknown>((done, reject) => {
        const call = request(`http://127.0.0.1:${webPort}/api/system/select-directory`, {
          method: "POST", headers: { host, origin, "sec-fetch-site": "same-origin" }
        }, response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("error", reject);
          response.on("end", () => { try { done(JSON.parse(body)); } catch (error) { reject(error); } });
        });
        call.on("error", reject);
        call.end();
      });
      expect(result).toEqual({ host, origin });
    }
  } finally {
    await vite?.close();
    await new Promise<void>((done, reject) => backend.close(error => error ? reject(error) : done()));
  }
}, 15_000);
