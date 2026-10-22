import { DatabaseSync } from "node:sqlite";
import Libsql from "libsql";

// Both drivers implement the synchronous statement API used by the game services.
export type Database = Pick<DatabaseSync, "exec" | "prepare" | "close">;
let cloud: Database | undefined;
export function cloudDatabase(): Database | undefined {
  const url = process.env.NODE_TEST_CONTEXT
    ? ""
    : process.env.BONK_DATABASE_URL;
  if (!url) return undefined;
  if (!cloud) {
    const parsed = new URL(url);
    if (
      !["libsql:", "https:"].includes(parsed.protocol) &&
      !(
        parsed.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      )
    )
      throw Error("BONK_DATABASE_URL must use libsql:// or HTTPS.");
    const options = {
      authToken: process.env.BONK_DATABASE_AUTH_TOKEN || "",
      timeout: 10000,
    };
    cloud = new Libsql(url, options) as unknown as Database;
  }
  return cloud;
}
export function closeDatabase(database: Database) {
  database.close();
  if (database === cloud) cloud = undefined;
}
export function closeCloudDatabase() {
  if (cloud) closeDatabase(cloud);
}
