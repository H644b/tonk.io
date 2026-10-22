import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { build } from "esbuild";
import { unzipSync, zipSync } from "fflate";
import { cloudFiles, type CloudFiles } from "./persistence.ts";
import {
  validateManifest,
  validatePath,
  resolveMods,
  type ModManifest,
} from "../../shared/modkit.ts";

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export type Pack = {
  manifest: ModManifest;
  root: string;
  hash: string;
  clientHash?: string;
  assetHashes: Record<string, string>;
  enabled: boolean;
  distributionBase?: string;
};
const MAX_PACK_BYTES = 64 * 1024 * 1024,
  MAX_FILES = 2048;
export class ModRepository {
  readonly persistence: CloudFiles | undefined;
  constructor(
    readonly directory = path.resolve(process.env.BONK_MODS_DIR || "mods"),
    persistent = true,
  ) {
    this.persistence = persistent ? cloudFiles() : undefined;
    fs.mkdirSync(path.join(directory, "installed"), { recursive: true });
    this.persistence?.restore(directory);
  }
  private configPath() {
    return path.join(this.directory, "enabled.json");
  }
  enabledIds(): string[] {
    const file = this.configPath();
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8")).enabled || []
      : [];
  }
  async install(
    source: string,
    options: { clientOnly?: boolean; reuseIdentical?: boolean } = {},
  ): Promise<Pack> {
    const files: Record<string, Uint8Array> = {};
    let total = 0;
    const add = (name: string, bytes: Uint8Array) => {
      validatePath(name);
      total += bytes.length;
      if (total > MAX_PACK_BYTES || Object.keys(files).length >= MAX_FILES)
        throw Error("Pack exceeds 64MB or 2048 files.");
      files[name] = bytes;
    };
    const location = path.resolve(source);
    if (fs.statSync(location).isDirectory()) {
      const walk = (folder: string) => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          if (
            ["node_modules", ".git", ".build", ".DS_Store"].includes(entry.name)
          )
            continue;
          const absolute = path.join(folder, entry.name);
          if (entry.isSymbolicLink())
            throw Error("Mod packs cannot contain symlinks.");
          if (entry.isDirectory()) walk(absolute);
          else if (entry.isFile())
            add(
              path.relative(location, absolute).split(path.sep).join("/"),
              fs.readFileSync(absolute),
            );
        }
      };
      walk(location);
    } else {
      const zipped = fs.readFileSync(location);
      if (zipped.length > MAX_PACK_BYTES) throw Error("Archive exceeds 64MB.");
      let estimated = 0,
        count = 0;
      const extracted = unzipSync(zipped, {
        filter(file) {
          if (file.name.endsWith("/")) return false;
          validatePath(file.name);
          estimated += file.originalSize;
          if (++count > MAX_FILES || estimated > MAX_PACK_BYTES)
            throw Error("Expanded pack exceeds limits.");
          return true;
        },
      });
      for (const [name, bytes] of Object.entries(extracted)) add(name, bytes);
    }
    if (!files["bonk.mod.json"])
      throw Error("Archive root must contain bonk.mod.json.");
    const manifest = validateManifest(
      JSON.parse(Buffer.from(files["bonk.mod.json"]).toString()),
    );
    if (
      options.clientOnly &&
      (!manifest.entrypoints.client || manifest.entrypoints.server)
    )
      throw Error(
        "Room-host packs must contain client/assets code only. Server entrypoints require operator installation.",
      );
    for (const file of [
      ...Object.values(manifest.entrypoints),
      ...Object.values(manifest.assets || {}),
    ])
      if (!files[file]) throw Error("Missing declared file: " + file);
    const destination = path.join(
      this.directory,
      "installed",
      manifest.id,
      manifest.version,
    );
    if (fs.existsSync(destination) && !options.reuseIdentical)
      throw Error(
        "This mod version is already installed; bump its version to change code.",
      );
    const staging = path.join(
      this.directory,
      ".install-" + randomBytes(8).toString("hex"),
    );
    fs.mkdirSync(staging, { recursive: true });
    try {
      for (const [name, bytes] of Object.entries(files)) {
        const target = path.join(staging, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
      }
      fs.mkdirSync(path.join(staging, ".build"));
      const hostIsolation = options.clientOnly
        ? [
            {
              name: "host-pack-files-only",
              setup(builder: any) {
                builder.onResolve({ filter: /.*/ }, (args: any) => {
                  if (args.kind === "entry-point") return undefined;
                  if (!args.path.startsWith("."))
                    return {
                      errors: [
                        {
                          text: "Host archives must bundle dependencies; imports may only reference files inside this pack.",
                        },
                      ],
                    };
                  const file = path.resolve(
                    args.resolveDir || staging,
                    args.path,
                  );
                  if (file !== staging && !file.startsWith(staging + path.sep))
                    return {
                      errors: [{ text: "Import escapes the host pack." }],
                    };
                  return undefined;
                });
              },
            },
          ]
        : [];
      if (manifest.entrypoints.client)
        await build({
          absWorkingDir: staging,
          entryPoints: [manifest.entrypoints.client],
          bundle: true,
          platform: "browser",
          format: "esm",
          target: "es2022",
          outfile: path.join(staging, ".build/client.js"),
          legalComments: "none",
          logLevel: "silent",
          plugins: hostIsolation,
        });
      if (manifest.entrypoints.server)
        await build({
          absWorkingDir: staging,
          entryPoints: [manifest.entrypoints.server],
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node24",
          outfile: path.join(staging, ".build/server.mjs"),
          legalComments: "none",
          logLevel: "silent",
        });
      // Publish immutable identities over every distributed byte and the server code.
      const assetHashes = Object.fromEntries(
        Object.entries(manifest.assets || {}).map(([key, file]) => [
          key,
          sha256(files[file]),
        ]),
      );
      const clientHash = manifest.entrypoints.client
        ? sha256(fs.readFileSync(path.join(staging, ".build/client.js")))
        : undefined;
      const serverHash = manifest.entrypoints.server
        ? sha256(fs.readFileSync(path.join(staging, ".build/server.mjs")))
        : undefined;
      const hash = sha256(
        JSON.stringify({ manifest, clientHash, serverHash, assetHashes }),
      );
      if (fs.existsSync(destination)) {
        const previous = this.list().find((pack) => pack.root === destination);
        if (previous?.hash === hash) return previous;
        throw Error(
          "This installed version has different bytes. Bump the version.",
        );
      }
      fs.writeFileSync(
        path.join(staging, ".pack.json"),
        JSON.stringify({ hash, clientHash, assetHashes }, null, 2),
      );
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (!options.clientOnly)
        this.persistence?.saveTree(
          staging,
          path.relative(this.directory, destination).split(path.sep).join("/"),
        );
      fs.renameSync(staging, destination);
      return {
        manifest,
        hash,
        clientHash,
        assetHashes,
        root: destination,
        enabled: false,
      };
    } finally {
      if (fs.existsSync(staging))
        fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  list(): Pack[] {
    const result: Pack[] = [],
      enabled = this.enabledIds();
    for (const id of fs.readdirSync(path.join(this.directory, "installed")))
      for (const version of fs.readdirSync(
        path.join(this.directory, "installed", id),
      )) {
        const root = path.join(this.directory, "installed", id, version),
          manifest = validateManifest(
            JSON.parse(
              fs.readFileSync(path.join(root, "bonk.mod.json"), "utf8"),
            ),
          ),
          metadata = JSON.parse(
            fs.readFileSync(path.join(root, ".pack.json"), "utf8"),
          );
        const assetHashes = Object.fromEntries(
          Object.entries(manifest.assets || {}).map(([key, file]) => [
            key,
            sha256(fs.readFileSync(path.join(root, file))),
          ]),
        );
        const clientHash = manifest.entrypoints.client
          ? sha256(fs.readFileSync(path.join(root, ".build/client.js")))
          : undefined;
        const serverHash = manifest.entrypoints.server
          ? sha256(fs.readFileSync(path.join(root, ".build/server.mjs")))
          : undefined;
        const actual = sha256(
          JSON.stringify({ manifest, clientHash, serverHash, assetHashes }),
        );
        if (actual !== metadata.hash)
          throw Error(
            `Installed mod ${id}@${version} was changed. Reinstall with a new version.`,
          );
        result.push({
          root,
          manifest,
          ...metadata,
          enabled: enabled.includes(`${id}@${version}`),
        });
      }
    return result;
  }
  setEnabled(spec: string, on: boolean): void {
    const all = this.list(),
      chosen =
        all.find(
          (pack) => `${pack.manifest.id}@${pack.manifest.version}` === spec,
        ) ||
        all
          .filter((pack) => pack.manifest.id === spec)
          .sort((a, b) =>
            b.manifest.version.localeCompare(a.manifest.version, undefined, {
              numeric: true,
            }),
          )[0];
    if (!chosen) throw Error("Mod is not installed: " + spec);
    let ids = this.enabledIds().filter(
      (id) => !id.startsWith(chosen.manifest.id + "@"),
    );
    if (on) {
      const available = all
        .filter((pack) =>
          pack.manifest.id === chosen.manifest.id
            ? pack === chosen
            : pack.enabled ||
              !all.some(
                (other) =>
                  other.manifest.id === pack.manifest.id && other.enabled,
              ),
        )
        .sort((a, b) =>
          a.manifest.version.localeCompare(b.manifest.version, undefined, {
            numeric: true,
          }),
        );
      const selected = resolveMods(available, [chosen.manifest.id]);
      for (const pack of selected) {
        ids = ids.filter((id) => !id.startsWith(pack.manifest.id + "@"));
        ids.push(`${pack.manifest.id}@${pack.manifest.version}`);
      }
    } else {
      const stillEnabled = all.filter((pack) =>
        ids.includes(`${pack.manifest.id}@${pack.manifest.version}`),
      );
      resolveMods(
        stillEnabled,
        stillEnabled.map((pack) => pack.manifest.id),
      );
    }
    const config = JSON.stringify({ enabled: ids }, null, 2) + "\n";
    this.persistence?.write("enabled.json", Buffer.from(config));
    fs.writeFileSync(this.configPath(), config);
  }
  enabled(): Pack[] {
    const packs = this.list().filter((pack) => pack.enabled);
    return resolveMods(
      packs,
      packs.map((pack) => pack.manifest.id),
    );
  }
  publicInfo(pack: Pack) {
    const base =
      pack.distributionBase ||
      `/modpacks/${pack.manifest.id}/${pack.manifest.version}`;
    return {
      id: pack.manifest.id,
      name: pack.manifest.name,
      version: pack.manifest.version,
      description: pack.manifest.description || "",
      author: pack.manifest.author || "",
      api: 2,
      hash: pack.hash,
      clientHash: pack.clientHash,
      client: pack.clientHash ? base + "/client.js" : null,
      dependencies: pack.manifest.dependencies || {},
      serverCode: !!pack.manifest.entrypoints.server,
      assets: Object.fromEntries(
        Object.entries(pack.manifest.assets || {}).map(([name, file]) => [
          name,
          {
            url: `${base}/assets/${encodeURIComponent(name)}`,
            hash: pack.assetHashes[name],
            file,
          },
        ]),
      ),
      commands: pack.manifest.commands || {},
      channels: pack.manifest.channels || {},
    };
  }
  pack(source: string, destination: string): void {
    const root = path.resolve(source),
      manifest = validateManifest(
        JSON.parse(fs.readFileSync(path.join(root, "bonk.mod.json"), "utf8")),
      ),
      files: Record<string, Uint8Array> = {};
    const walk = (folder: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (
          ["node_modules", ".git", ".build", ".DS_Store"].includes(entry.name)
        )
          continue;
        if (entry.isSymbolicLink()) throw Error("Symlink in mod pack.");
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else
          files[path.relative(root, full).split(path.sep).join("/")] =
            fs.readFileSync(full);
      }
    };
    walk(root);
    if (!manifest.entrypoints) throw Error("Missing mod entrypoint.");
    fs.writeFileSync(path.resolve(destination), zipSync(files));
  }
}
