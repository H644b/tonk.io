import fs from 'node:fs';
import path from 'node:path';
/** Browser/CLI-prepared code is already host-authored executable content.
 * Hashes cover the actual compiled bytes that every room member approves.
 */
export async function build(options:any) {
  const output=options.outfile;
  if(fs.existsSync(output)&&fs.existsSync(path.join(options.absWorkingDir,'.build/prepared.json')))return;
  const entry=path.resolve(options.absWorkingDir,options.entryPoints[0]);
  const source=fs.readFileSync(entry,'utf8');
  if(!entry.endsWith('.js')||/\bimport\s*(?:\(|[\s{*])|\bexport\s+[^;\n]*\bfrom\s*['"]/.test(source))
    throw Error('Upload this pack through Workbench to compile its modules first.');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,source);
}
