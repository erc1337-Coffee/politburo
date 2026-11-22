import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const refusedSymlink = 'refused_symlink';
const refusedMode = () => { throw new Error(refusedSymlink); };
const split = bytes => utf8.decode(bytes).split('\0').slice(0, -1);
const nul = paths => paths.length ? `${paths.join('\0')}\0` : '';
const stat = path => lstatSync(path, { throwIfNoEntry: false });
const gitEntry = name => name.toLowerCase() === '.git';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxFileBytes = 20 * 1024 * 1024;
const refuse = () => { throw new Error('refused_export'); };
function treePath(path) {
  if (/[\\\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || gitEntry(part))) refuse();
  return path;
}

// Git's ls-files --others probes nested .git repositories and omits FIFOs.
// Walk entries ourselves. Git only sees a private directory skeleton and
// copies of the ignore files, never the live worktree or a nested repository.
function candidates(sprite, mirror, git, checkIgnore) {
  const paths = new Set(split(git(['ls-files', '--cached', '-z'])).map(treePath));
  let dirs = [''];
  while (dirs.length) {
    const entries = [];
    for (const dir of dirs) {
      if (!pathStat(sprite, dir)?.isDirectory()) continue;
      const full = checkedPath(sprite, dir);
      const ignore = stat(join(full, '.gitignore'));
      if (ignore?.isFile()) {
        const { bytes } = readRegular(sprite, dir ? `${dir}/.gitignore` : '.gitignore');
        writeFileSync(join(mirror, dir, '.gitignore'), bytes, { flag: 'wx' });
      } else if (ignore && !ignore.isSymbolicLink() && !ignore.isDirectory()) refuse();
      for (const bytes of readdirSync(full, { encoding: 'buffer' })) {
        const name = utf8.decode(bytes);
        if (gitEntry(name)) continue;
        const path = treePath(dir ? `${dir}/${name}` : name);
        // lstat here preserves the ability to ignore a symlink before refusing it.
        const directory = stat(join(full, name))?.isDirectory();
        if (directory) mkdirSync(join(mirror, path));
        entries.push({ path, directory });
      }
    }
    const ignored = new Set(entries.length ? split(checkIgnore(nul(entries.map(({ path }) => `./${path}`)))) : []);
    dirs = [];
    for (const { path, directory } of entries) {
      if (ignored.has(`./${path}`)) continue;
      if (directory) dirs.push(path);
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

function checkedPath(sprite, path) {
  const full = join(sprite, path);
  if (realpathSync(full) !== full) refusedMode();
  return full;
}

function readRegular(sprite, path) {
  // Recheck the parent chain before open and the opened inode before reading.
  pathStat(sprite, path.split('/').slice(0, -1).join('/'));
  let fd;
  try {
    fd = openSync(join(sprite, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ELOOP') refusedMode();
    throw e;
  }
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size > maxFileBytes) refuse();
    const current = pathStat(sprite, path);
    checkedPath(sprite, path);
    if (!current || current.ino !== entry.ino || current.dev !== entry.dev) refuse();
    const bytes = Buffer.allocUnsafe(entry.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > entry.size) refuse();
    return { bytes: bytes.subarray(0, offset), mode: entry.mode & 0o111 ? '100755' : '100644' };
  } finally { closeSync(fd); }
}

// Check the actual modes Git wrote, including file type changes.
export function verifyModes(raw) {
  const fields = split(raw);
  for (let i = 0; i < fields.length; i += 2) {
    const [, mode, , , status] = fields[i].split(' ');
    if (mode !== '100644' && mode !== '100755' && !(mode === '000000' && status === 'D')) refusedMode();
  }
}

export function exportPatch(dir, sprite, trusted, base, git, env, afterWalk) {
  const gitDir = join(dir, 'export.git');
  git(dir, ['init', '--bare', '--template=', gitDir]);
  const objects = join(gitDir, 'objects');
  writeFileSync(join(objects, 'info', 'alternates'), `${join(trusted, 'objects')}\n`, { flag: 'wx' });
  const isolated = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_DIR: gitDir, GIT_INDEX_FILE: join(dir, 'index'), GIT_OBJECT_DIRECTORY: objects };
  const mirror = join(dir, 'ignore-tree');
  mkdirSync(mirror);
  const tempGit = (args, input, options = {}) => {
    try {
      return git(dir, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.symlinks=true', ...args], { env: options.env ?? isolated, input, stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL' });
    } catch (error) {
      if (options.ok?.includes(error.status)) return error.stdout;
      throw error;
    }
  };
  tempGit(['read-tree', base]);
  const regular = [], removed = [];
  let skipped = 0;
  const ignoreEnv = { ...isolated, GIT_WORK_TREE: mirror };
  const checkIgnore = input => tempGit(['check-ignore', '--no-index', '--stdin', '-z'], input, { env: ignoreEnv, ok: [1] });
  for (const path of candidates(sprite, mirror, tempGit, checkIgnore)) {
    const entry = pathStat(sprite, path);
    if (entry?.isFile()) regular.push(path);
    else if (!entry || entry.isDirectory()) removed.push(path);
    else skipped++;
  }
  afterWalk?.();
  // The stdin form of --force-remove requires a worktree, even though it
  // only changes the index. Point it at the private mirror.
  if (removed.length) tempGit(['update-index', '--force-remove', '-z', '--stdin'], nul(removed), { env: ignoreEnv });
  for (const path of regular) {
    const { bytes, mode } = readRegular(sprite, path);
    const oid = tempGit(['hash-object', '-w', '--stdin'], bytes).toString().trim();
    tempGit(['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`]);
  }
  const tree = tempGit(['write-tree']).toString().trim();
  const diff = ['diff-tree', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', `${base}^{tree}`, tree];
  verifyModes(tempGit([...diff, '--raw', '-z']));
  const patch = tempGit([...diff, '--binary', '--full-index', '-p']);
  const numstat = tempGit([...diff, '--numstat', '-z']);
  return { patch, numstat, skipped };
}
