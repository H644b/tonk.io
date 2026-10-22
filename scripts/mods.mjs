import { closeCloudDatabase } from "../server/database.ts";
import { ModRepository } from "../server/modding/repository.ts";
const [command, source, destination] = process.argv.slice(2),
  repository = new ModRepository();
try {
  if (command === "install" && source) {
    const pack = await repository.install(source);
    console.log(
      `Installed ${pack.manifest.id}@${pack.manifest.version}. Enable it, then restart the server.`,
    );
  } else if (["enable", "disable"].includes(command) && source) {
    repository.setEnabled(source, command === "enable");
    console.log(
      `${source} ${command}d. Restart the server to apply code changes.`,
    );
  } else if (command === "pack" && source && destination) {
    repository.pack(source, destination);
    console.log("Created " + destination);
  } else if (command === "list")
    console.table(
      repository.list().map((pack) => ({
        id: pack.manifest.id,
        version: pack.manifest.version,
        enabled: pack.enabled,
        hash: pack.hash.slice(0, 12),
      })),
    );
  else
    throw Error(
      "Usage: npm run mods -- install <directory|zip> | enable <id[@version]> | disable <id> | list | pack <directory> <output.bonkmod>",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  closeCloudDatabase();
}
