import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudFiles } from "../server/modding/persistence.ts";

test("durable mod files restore binary chunks, verify integrity and ignore incomplete packs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bonk-file-test-"));
  const db = new DatabaseSync(":memory:");
  try {
    const files = new CloudFiles(db);
    const bytes = Buffer.alloc(600000, 73);
    files.write("installed/test/1.0.0/assets/image.bin", bytes);
    files.write("installed/test/1.0.0/.pack.json", Buffer.from("{}"));
    files.write(
      "installed/incomplete/1.0.0/client.js",
      Buffer.from("throw Error('incomplete')"),
    );
    files.write("enabled.json", Buffer.from('{"enabled":["test@1.0.0"]}'));
    files.write("data/test.json", Buffer.from('{"counter":4}'));
    files.restore(directory);
    assert.deepEqual(
      fs.readFileSync(
        path.join(directory, "installed/test/1.0.0/assets/image.bin"),
      ),
      bytes,
    );
    assert.equal(
      fs.existsSync(path.join(directory, "installed/incomplete")),
      false,
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(directory, "data/test.json"), "utf8"),
      ).counter,
      4,
    );
    assert.throws(
      () => files.write("../escape", bytes),
      /Invalid stored mod path/,
    );
    db.exec(
      "UPDATE mod_file_chunks SET bytes = X'00' WHERE generation IN (SELECT generation FROM mod_files WHERE path = 'data/test.json')",
    );
    assert.throws(() => files.restore(directory), /incomplete/);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed durable file replacement preserves the previous committed bytes", () => {
  const db = new DatabaseSync(":memory:");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bonk-file-atomic-"));
  try {
    const files = new CloudFiles(db);
    files.write("data/test.json", Buffer.from('{"counter":1}'));
    db.exec(
      `CREATE TRIGGER reject_new_mod_header BEFORE UPDATE ON mod_files BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`,
    );
    assert.throws(
      () => files.write("data/test.json", Buffer.from('{"counter":2}')),
      /simulated failure/,
    );
    files.restore(directory);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(directory, "data/test.json"), "utf8"),
      ).counter,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM mod_file_chunks").get()!.count,
      1,
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
