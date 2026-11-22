import { lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const refusedSymlink = 'refused_symlink';
const refusedMode = () => { throw new Error(refusedSymlink); };
const split = bytes => bytes.toString().split('\0').slice(0, -1);
const nul = paths => paths.length ? `${paths.join('\0')}\0` : '';
const stat = path => lstatSync(path, { throwIfNoEntry: false });
const gitEntry = name => name.toLowerCase() === '.git';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Git's ls-files --others probes nested .git repositories and omits FIFOs.
// Walk directory entries ourselves, asking Git only which paths are ignored.
function candidates(sprite, git) {
  const paths = new Set(split(git(['ls-files', '--cached', '-z'])));
  let dirs = [''];
  while (dirs.length) {
    const entries = [];
    for (const dir of dirs) {
      const entry = pathStat(sprite, dir);
      if (!entry?.isDirectory()) continue;
      // Git reads ignore files, so never let it open a special file as one.
      const ignore = stat(join(sprite, dir, '.gitignore'));
      if (ignore && !ignore.isFile() && !ignore.isSymbolicLink() && !ignore.isDirectory()) {
        throw new Error('invalid ignore file');
      }
      for (const bytes of readdirSync(join(sprite, dir), { encoding: 'buffer' })) {
        const name = utf8.decode(bytes);
        if (!gitEntry(name)) entries.push(dir ? `${dir}/${name}` : name);
      }
    }
    const ignored = new Set(entries.length ? split(git(['check-ignore', '--no-index', '--stdin', '-z'],
      nul(entries.map(path => `./${path}`)), [1])) : []);
    dirs = [];
    for (const path of entries) {
      if (ignored.has(`./${path}`)) continue;
      if (pathStat(sprite, path)?.isDirectory()) dirs.push(path);
      else paths.add(path);
    }
  }
  return paths;
}

function pathStat(sprite, path) {
  let full = sprite, entry = stat(full);
  for (const name of path ? path.split('/') : []) {
    if (entry?.isSymbolicLink()) refusedMode();
    if (!entry?.isDirectory()) return;
    full = join(full, name);
    entry = stat(full);
  }
  if (entry?.isSymbolicLink()) refusedMode();
  return entry;
}

// Check the written tree, not just the earlier lstat results: an entry
// could have become a symlink between classification and update-index.
export function verifyModes(raw) {
  const fields = split(raw);
  for (let i = 0; i < fields.length; i += 2) {
    const [, mode, , , status] = fields[i].split(' ');
    if (mode !== '100644' && mode !== '100755' && !(mode === '000000' && status === 'D')) refusedMode();
  }
}

export function exportPatch(dir, sprite, trusted, base, git, env) {
  const gitDir = join(dir, 'export.git');
  git(dir, ['init', '--bare', '--template=', gitDir]);
  const objects = join(gitDir, 'objects');
  writeFileSync(join(objects, 'info', 'alternates'), `${join(trusted, 'objects')}\n`, { flag: 'wx' });
  const isolated = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_DIR: gitDir, GIT_WORK_TREE: sprite, GIT_INDEX_FILE: join(dir, 'index'), GIT_OBJECT_DIRECTORY: objects };
  const tempGit = (args, input, ok = []) => {
    try {
      return git(dir, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.symlinks=true', ...args], { env: isolated, input, stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL' });
    } catch (error) {
      if (ok.includes(error.status)) return error.stdout;
      throw error;
    }
  };
  tempGit(['read-tree', base]);
  const regular = [], removed = [];
  let skipped = 0;
  for (const path of candidates(sprite, tempGit)) {
    const entry = pathStat(sprite, path);
    if (entry?.isFile()) regular.push(path);
    else if (!entry || entry.isDirectory()) removed.push(path);
    else skipped++;
  }
  if (removed.length) tempGit(['update-index', '--force-remove', '-z', '--stdin'], nul(removed));
  if (regular.length) tempGit(['update-index', '--add', '--remove', '-z', '--stdin'], nul(regular));
  // From here on Git needs only objects, never the sprite work tree.
  delete isolated.GIT_WORK_TREE;
  const tree = tempGit(['write-tree']).toString().trim();
  const diff = ['diff-tree', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', `${base}^{tree}`, tree];
  verifyModes(tempGit([...diff, '--raw', '-z']));
  const patch = tempGit([...diff, '--binary', '--full-index', '-p']);
  const numstat = tempGit([...diff, '--numstat', '-z']);
  return { patch, numstat, skipped };
}
