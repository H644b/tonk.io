import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function start(directory: string, trustProxy: string) {
  const child = spawn(process.execPath, ["dist/server.mjs"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      NODE_TEST_CONTEXT: "",
      BONK_DATABASE_URL: "",
      BONK_DATABASE_AUTH_TOKEN: "",
      HOST: "127.0.0.1",
      PORT: "0",
      TRUST_PROXY: trustProxy,
      BONK_DATA_PATH: path.join(directory, "bonk.sqlite"),
      BONK_MODS_DIR: path.join(directory, "mods"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (bytes) => (logs += bytes));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Startup timed out: " + logs));
    }, 5000);
    child.stdout.on("data", (bytes) => {
      logs += bytes;
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Startup exited " + code + ": " + logs));
    });
  });
  return { child, url };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(signal, null, "SIGTERM is handled, not an abrupt process exit");
  assert.equal(code, 0);
}

test("production proxy trust, secure sessions, graceful shutdown and database restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bonk-deploy-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  let session = "";
  try {
    for (const [trust, secure] of [
      ["", false],
      ["192.0.2.1", false],
      ["loopback", true],
    ] as const) {
      running = await start(directory, trust);
      const headers = {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.21",
      };
      const response = await fetch(running.url + "/api/register", {
        method: "POST",
        headers,
        body: JSON.stringify({
          username: secure ? "ReleasePlayer" : `Player${trust ? "B" : "A"}`,
          password: "test-release-password",
        }),
      });
      assert.equal(response.status, 201);
      const cookie = response.headers.get("set-cookie")!;
      assert.equal(/; Secure\b/.test(cookie), secure);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      if (secure) session = cookie.split(";")[0];
      assert.equal(response.headers.get("x-powered-by"), null);
      const rejected = await fetch(running.url + "/api/rooms", {
        method: "POST",
        headers: { ...headers, Origin: "https://other.example" },
        body: "{}",
      });
      assert.equal(rejected.status, 403);
      assert.equal((await fetch(running.url + "/evidence")).status, 404);
      await stop(running.child);
      running = undefined;
    }
    running = await start(directory, "loopback");
    const profile = await (
      await fetch(running.url + "/api/profile", {
        headers: { Cookie: session },
      })
    ).json();
    assert.equal(profile.user.username, "ReleasePlayer");
    assert.deepEqual(
      await (await fetch(running.url + "/api/rooms")).json(),
      [],
    );
    await stop(running.child);
    running = undefined;
  } finally {
    if (running) await stop(running.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
