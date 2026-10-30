import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { cloudDatabase, withTransaction, type Database } from "../database.ts";
const chunkSize = 256 * 1024;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Durable files for ephemeral hosts. A header is switched only after all chunks exist. */
export class CloudFiles {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS mod_files (
      path TEXT PRIMARY KEY, generation TEXT NOT NULL, chunks INTEGER NOT NULL,
      size INTEGER NOT NULL, hash TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS mod_file_chunks (
      generation TEXT NOT NULL, chunk INTEGER NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY(generation, chunk)
    );`);
  }
  write(name: string, bytes: Uint8Array) {
    this.validate(name);
    if (bytes.length > 64 * 1024 * 1024)
      throw Error("Stored mod files must be 64 MB or smaller.");
    const generation = randomUUID();
    const chunks = Math.max(1, Math.ceil(bytes.length / chunkSize));
    try {
      for (let index = 0; index < chunks; index++)
        this.db
          .prepare("INSERT INTO mod_file_chunks VALUES (?, ?, ?)")
          .run(
            generation,
            index,
            Buffer.from(
              bytes.subarray(index * chunkSize, (index + 1) * chunkSize),
            ),
          );
      withTransaction(this.db, () => {
        const old = this.db
          .prepare("SELECT generation FROM mod_files WHERE path = ?")
          .get(name);
        this.db
          .prepare(
            "INSERT INTO mod_files VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET generation=excluded.generation, chunks=excluded.chunks, size=excluded.size, hash=excluded.hash",
          )
          .run(name, generation, chunks, bytes.length, hash(bytes));
        if (old)
          this.db
            .prepare("DELETE FROM mod_file_chunks WHERE generation = ?")
            .run(old.generation);
      });
    } catch (error) {
      this.db
        .prepare("DELETE FROM mod_file_chunks WHERE generation = ?")
        .run(generation);
      throw error;
    }
  }
  restore(directory: string) {
    const files = this.db
      .prepare("SELECT * FROM mod_files ORDER BY path")
      .all();
    const committed = new Set(
      files
        .map((file) => String(file.path))
        .filter((name) => /^installed\/[^/]+\/[^/]+\/\.pack\.json$/.test(name))
        .map((name) => name.slice(0, -".pack.json".length)),
    );
    for (const file of files) {
      if (
        String(file.path).startsWith("installed/") &&
        ![...committed].some((prefix) => String(file.path).startsWith(prefix))
      )
        continue;
      const name = String(file.path);
      this.validate(name);
      const size = Number(file.size),
        chunks = Number(file.chunks);
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 64 * 1024 * 1024 ||
        chunks !== Math.max(1, Math.ceil(size / chunkSize))
      )
        throw Error("Invalid stored mod file.");
      const bytes = Buffer.alloc(size);
      for (let index = 0; index < chunks; index++) {
        const row = this.db
          .prepare(
            "SELECT bytes FROM mod_file_chunks WHERE generation = ? AND chunk = ?",
          )
          .get(file.generation, index);
        if (
          !row ||
          !(row.bytes instanceof Uint8Array) ||
          row.bytes.length !== Math.min(chunkSize, size - index * chunkSize)
        )
          throw Error("Stored mod file is incomplete.");
        bytes.set(row.bytes, index * chunkSize);
      }
      if (hash(bytes) !== file.hash)
        throw Error("Stored mod file failed integrity verification.");
      const destination = path.resolve(directory, name);
      if (!destination.startsWith(path.resolve(directory) + path.sep))
        throw Error("Invalid mod destination.");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination + ".restore", bytes);
      fs.renameSync(destination + ".restore", destination);
    }
  }
  saveTree(source: string, prefix: string) {
    // .pack.json is the commit marker: write it after all sources and compiled bytes.
    const files: string[] = [];
    const walk = (folder: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const name = path.join(folder, entry.name);
        if (entry.isSymbolicLink())
          throw Error("Mod files cannot be symlinks.");
        if (entry.isDirectory()) walk(name);
        else if (entry.isFile()) files.push(name);
      }
    };
    walk(source);
    files.sort(
      (a, b) =>
        Number(path.basename(a) === ".pack.json") -
        Number(path.basename(b) === ".pack.json"),
    );
    for (const file of files)
      this.write(
        prefix + "/" + path.relative(source, file).split(path.sep).join("/"),
        fs.readFileSync(file),
      );
  }
  private validate(name: string) {
    if (
      !name ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw Error("Invalid stored mod path.");
    if (
      !name.startsWith("installed/") &&
      !name.startsWith("data/") &&
      name !== "enabled.json"
    )
      throw Error("Unsupported stored mod path.");
  }
}
export function cloudFiles() {
  const db = cloudDatabase();
  return db ? new CloudFiles(db) : undefined;
}
