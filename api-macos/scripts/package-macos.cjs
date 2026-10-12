const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

assert.equal(process.platform, 'darwin', 'Mac packaging must run on macOS');
assert.equal(process.arch, 'arm64', 'This package targets Apple Silicon');
const workspace = path.resolve(__dirname, '../..'), project = path.join(workspace, 'api-macos'), cherry = path.join(workspace, 'cherry-studio');
const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'))).version;
const stage = path.join(project, 'build', 'app'), bundle = path.join(stage, 'API.app'), contents = path.join(bundle, 'Contents'), resources = path.join(contents, 'Resources'), app = path.join(resources, 'app');
if (fs.existsSync(bundle)) throw new Error('Build stage already exists; use a clean build checkout');
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(cherry, 'node_modules/electron/dist/Electron.app'), bundle, { recursive: true, verbatimSymlinks: true });
fs.renameSync(path.join(contents, 'MacOS/Electron'), path.join(contents, 'MacOS/API'));
fs.mkdirSync(app, { recursive: true });
for (const folder of ['src', 'ui', 'assets']) fs.cpSync(path.join(project, folder), path.join(app, folder), { recursive: true });
fs.copyFileSync(path.join(project, 'package.json'), path.join(app, 'package.json'));
fs.cpSync(path.join(cherry, 'out'), path.join(app, 'out'), { recursive: true });
fs.cpSync(path.join(cherry, 'resources/managed-chat'), path.join(app, 'resources/managed-chat'), { recursive: true });
fs.cpSync(path.join(cherry, 'migrations/sqlite-drizzle'), path.join(resources, 'migrations/sqlite-drizzle'), { recursive: true });
fs.cpSync(path.join(cherry, 'packages/provider-registry/data'), path.join(resources, 'provider-registry'), { recursive: true });

const roots = ['@cherrystudio/remote-protocol', '@paymoapp/electron-shutdown-handler', '@napi-rs/system-ocr', '@node-rs/xxhash', 'better-sqlite3', 'cross-spawn', 'font-list', 'graceful-fs', 'gray-matter', 'jsdom', 'markdown-it', 'node-mac-permissions', 'node-screenshots', 'node-stream-zip', 'officeparser', 'os-proxy-config', 'pako', 'pdf-parse', 'sharp', 'sqlite-vec', 'systeminformation', 'tar', 'turndown', 'winston', 'ws'];
const packages = new Map();
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
function find(from, name) { for (let at = from; ; at = path.dirname(at)) { const candidate = path.join(at, 'node_modules', name); if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate); if (path.dirname(at) === at) return null; } }
const applies = (values, target) => !values || !values.includes('!' + target) && (values.every(value => value.startsWith('!')) || values.includes(target));
const compatible = meta => applies(meta.os, 'darwin') && applies(meta.cpu, 'arm64');
const dependencies = meta => Object.keys({ ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies }).filter(name => name !== 'electron' && !name.startsWith('@types/'));
for (const name of roots) { const dir = find(cherry, name); if (!dir) throw new Error('Missing Mac dependency: ' + name); packages.set(name, dir); }
const queue = [...packages.values()], seen = new Set();
while (queue.length) {
  const dir = queue.shift(); if (seen.has(dir)) continue; seen.add(dir); const meta = read(dir);
  for (const name of dependencies(meta)) {
    const found = find(dir, name); if (!found) { if (meta.optionalDependencies?.[name] || meta.peerDependencies?.[name]) continue; throw new Error('Missing dependency ' + name); }
    if (!compatible(read(found))) continue; if (!packages.has(name)) packages.set(name, found); queue.push(found);
  }
}
const filter = file => {
  const name = path.basename(file);
  const prebuild = file.match(/[\\/]prebuilds[\\/]([^\\/]+)/)?.[1];
  if (prebuild && !(prebuild.startsWith('darwin-') && (prebuild.includes('arm64') || prebuild.includes('universal')))) return false;
  if (/^(node_modules|\.git|test|tests|__tests__|coverage|examples?|docs|obj|Debug)$/.test(name)) return false;
  if (/\.(map|d\.ts|tsx?|cpp|cc|h|o|obj|pdb|lib|exp|iobj|ipdb|vcxproj|gypi?)$/i.test(name)) return false;
  if (/[\/]better-sqlite3[\/]build[\/]Release[\/]/.test(file)) return name === 'better_sqlite3.node';
  return true;
};
for (const [name, dir] of packages) fs.cpSync(dir, path.join(app, 'node_modules', name), { recursive: true, filter });
function conflicts(dir, destination, ancestors = new Map(), visited = new Set()) {
  if (visited.has(dir)) return; const next = new Set([...visited, dir]), meta = read(dir), available = new Map(ancestors); available.set(meta.name, dir);
  for (const name of dependencies(meta)) { const found = find(dir, name); if (!found || !compatible(read(found)) || (available.get(name) || packages.get(name)) === found) continue; const target = path.join(destination, 'node_modules', name); fs.cpSync(found, target, { recursive: true, filter }); conflicts(found, target, available, next); }
}
for (const [name, dir] of packages) conflicts(dir, path.join(app, 'node_modules', name));
const nativeDir = path.join(workspace, 'native-source/target/aarch64-apple-darwin/release/bundle/macos');
const native = fs.readdirSync(nativeDir).find(name => name.endsWith('.app')); if (!native) throw new Error('Native Cockpit Mac bundle is missing');
fs.cpSync(path.join(nativeDir, native), path.join(resources, 'native-engine/cockpit-tools.app'), { recursive: true, verbatimSymlinks: true });
assert.ok(fs.existsSync(path.join(app, 'out/main/managedEntryPoint.js')), 'Managed chat entry is missing');
assert.ok(fs.existsSync(path.join(app, 'out/preload/preload.js')), 'Managed preload is missing');
assert.ok(fs.existsSync(path.join(app, 'out/renderer/windows/main/index.html')), 'Managed chat renderer is missing');
fs.copyFileSync(path.join(cherry, 'LICENSE'), path.join(app, 'LICENSE-Cherry-Studio-AGPL-3.0'));
fs.copyFileSync(path.join(project, 'licenses/Cockpit-Tools.txt'), path.join(app, 'LICENSE-Cockpit-Tools'));
function run(file, args) { const result = spawnSync(file, args, { stdio: 'inherit' }); if (result.status !== 0) throw new Error(file + ' failed'); }
const plist = path.join(contents, 'Info.plist');
const minimum = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', plist], { encoding: 'utf8' });
assert.equal(minimum.status, 0, 'Electron minimum macOS version must be available');
const minimumMacOS = minimum.stdout.trim();
for (const [key, value] of [['CFBundleExecutable', 'API'], ['CFBundleDisplayName', 'API'], ['CFBundleName', 'API'], ['CFBundleIdentifier', 'com.juhai.api'], ['CFBundleShortVersionString', version], ['CFBundleVersion', version]]) run('/usr/libexec/PlistBuddy', ['-c', 'Set :' + key + ' ' + value, plist]);
const iconset = path.join(project, 'build/brand.iconset'); fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), path.join(project, 'assets/brand-icon.png'), '--out', path.join(iconset, 'icon_' + size + 'x' + size + (scale === 2 ? '@2x' : '') + '.png')]);
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'electron.icns')]);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]);
for (const file of walk(bundle).filter(file => fs.lstatSync(file).isSymbolicLink())) {
  const link = fs.readlinkSync(file), resolved = fs.realpathSync(file);
  if (path.isAbsolute(link) || !resolved.startsWith(bundle + path.sep)) throw new Error('Bundle symlink escapes the application: ' + path.relative(bundle, file));
}
for (const executable of [path.join(contents, 'MacOS/API'), path.join(resources, 'native-engine/cockpit-tools.app/Contents/MacOS/cockpit-tools')]) {
  run('/usr/bin/lipo', [executable, '-verify_arch', 'arm64']);
}
for (const file of walk(bundle).filter(file => /\.(node|dylib)$/.test(file))) { const check = spawnSync('/usr/bin/lipo', [file, '-verify_arch', 'arm64'], { encoding: 'utf8' }); if (check.status !== 0) throw new Error('Non-arm64 native dependency: ' + path.relative(bundle, file)); }
const entitlements = path.join(project, 'scripts/entitlements.plist');
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, bundle]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
const output = path.join(project, 'release'); fs.mkdirSync(output, { recursive: true });
const zip = path.join(output, 'API_' + version + '_macos-arm64.zip');
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip]);
const dmg = path.join(output, 'API_' + version + '_macos-arm64.dmg');
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
run('/usr/bin/hdiutil', ['create', '-volname', 'API', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]);
for (const file of [zip, dmg]) { const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); fs.writeFileSync(file + '.sha256', hash + '  ' + path.basename(file) + '\n'); }
fs.writeFileSync(path.join(output, 'package-report.json'), JSON.stringify({ version, platform: 'darwin', arch: 'arm64', minimumMacOS, nativeCockpit: '1.3.66', packages: packages.size, signing: 'ad-hoc; not Apple Developer ID notarized', runtimeSmoke: 'must pass separately', containsUserKeys: false }, null, 2));
