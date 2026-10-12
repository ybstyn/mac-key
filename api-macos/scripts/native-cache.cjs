const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const workspace = path.resolve(__dirname, '../..');
const native = path.join(workspace, 'native-source');
const marker = path.join(native, 'target/api-native-build.json');
const directory = path.join(native, 'target/aarch64-apple-darwin/release/bundle/macos');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const context = {
  tree: execFileSync('git', ['rev-parse', 'HEAD:native-source'], { cwd: workspace, encoding: 'utf8' }).trim(),
  config: digest(fs.readFileSync(path.join(__dirname, 'native-macos-config.json'))),
  deployment: process.env.MACOSX_DEPLOYMENT_TARGET,
  arch: process.arch
};
const bundle = fs.existsSync(directory) && fs.readdirSync(directory).find(name => name.endsWith('.app'));
function bundleDigest() {
  const base = path.join(directory, bundle), hash = crypto.createHash('sha256');
  function visit(folder) {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), stat = fs.lstatSync(file);
      hash.update(path.relative(base, file));
      if (stat.isDirectory()) visit(file);
      else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
      else hash.update(fs.readFileSync(file));
    }
  }
  visit(base); return hash.digest('hex');
}
let verified = false;
if (bundle) {
  const executable = path.join(directory, bundle, 'Contents/MacOS/cockpit-tools');
  execFileSync('/usr/bin/lipo', [executable, '-verify_arch', 'arm64']);
  if (fs.existsSync(marker)) {
    const previous = JSON.parse(fs.readFileSync(marker));
    verified = JSON.stringify(previous.context) === JSON.stringify(context) && previous.bundleDigest === bundleDigest();
  } else {
    // Bootstrap only the exact cache produced by the successful native step in run 38206206000.
    verified = process.env.API_NATIVE_CACHE_KEY === 'macos-arm64-native-fd5f1313fad2adeb215efbb3b85fe48c82cc79f7db1104a35e87479e6fd68e03-v2'
      && context.tree === '765bcc6356dd944a576188c1b86a35338c56b6e7'
      && context.config === '045e55901593915f744feabfb9a952abeeaa02d23342681e2bbe236a0da221e3'
      && context.deployment === '13.0';
  }
}
if (process.argv.includes('--record') || verified) {
  assert.ok(bundle, 'Compiled native bundle is missing');
  fs.writeFileSync(marker, JSON.stringify({ context, bundleDigest: bundleDigest() }));
  console.log(JSON.stringify({ nativeBundleVerified: true, sourceTree: context.tree, reused: verified }));
} else process.exitCode = 2;
