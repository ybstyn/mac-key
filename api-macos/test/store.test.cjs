const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { MacStore, validateServer } = require('../src/store.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-mac-store-')), secret = crypto.randomBytes(32);
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'api-mac-store-')); fs.rmSync(root, { recursive: true, force: true }); });
  const encryption = { encrypt(value) { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce), data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), data]); }, decrypt(value) { const cipher = crypto.createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); } };
  return { root, encryption, store: new MacStore(root, encryption) };
}
test('separate platform credentials survive reopening without plaintext distribution', t => {
  const { store, root, encryption } = fixture(t); store.saveSettings({}); store.bind('gpt', 'gpt-fixture', true); store.bind('claude', 'claude-fixture', true); store.bind('gemini', 'gemini-fixture', true);
  const reopened = new MacStore(root, encryption); assert.equal(reopened.key('gpt'), 'gpt-fixture'); assert.equal(reopened.key('claude'), 'claude-fixture'); assert.equal(reopened.key('gemini'), 'gemini-fixture');
  assert.ok(!fs.readFileSync(path.join(root, 'keys.keychain')).includes('claude-fixture')); assert.ok(!fs.readFileSync(path.join(root, 'settings.json')).includes('claude-fixture'));
});
test('one explicit pair can share history, replacement and cross-user pairing are rejected', t => {
  const { store } = fixture(t); const group = store.bind('claude', 'first-claude', true); store.bind('gemini', 'paired-gemini', true, group);
  assert.equal(store.bind('claude', 'first-claude', true), group); const other = store.bind('claude', 'second-user', true);
  assert.notEqual(other, group); assert.notEqual(store.profile(other), store.profile(group));
  assert.throws(() => store.bind('claude', 'second-user', true, group)); assert.equal(store.keysFor(group)['claude@' + store.settings.server], 'first-claude');
});
test('unremembered key does not overwrite other platform credentials', t => {
  const { store } = fixture(t); store.bind('gpt', 'gpt-fixture', true); store.bind('claude', 'claude-fixture', true); store.bind('gemini', 'gemini-fixture', false);
  assert.equal(store.key('gemini'), ''); assert.equal(store.key('claude'), 'claude-fixture'); assert.equal(store.key('gpt'), 'gpt-fixture');
});
test('provision is encrypted, export consumes it, and paths outside the user profile are rejected', t => {
  const { store, root } = fixture(t); const group = store.bind('claude', 'private-fixture', true), config = { group, channels: [{ key: 'private-fixture' }] };
  const profile = store.provision(config), file = path.join(profile, 'api-launch.dpapi'); assert.ok(!fs.readFileSync(file).includes('private-fixture'));
  assert.deepEqual(JSON.parse(store.exportProvision(file)), config); assert.equal(fs.existsSync(file), false);
  assert.throws(() => store.ownProfile(path.join(root, '../outside'))); assert.throws(() => store.exportProvision(path.join(root, 'keys.keychain')));
});
test('settings persist remembered close options but cannot redirect distributed keys to an upstream', t => {
  const { store, root, encryption } = fixture(t); store.saveSettings({ closeAction: 'tray' }); assert.equal(new MacStore(root, encryption).settings.closeAction, 'tray');
  assert.throws(() => store.saveSettings({ server: 'https://api.anthropic.com' })); assert.equal(store.settings.server, 'http://raspberry5.local:1456');
  assert.throws(() => validateServer('http://raspberry5.local:1456/gemini')); assert.throws(() => validateServer('http://raspberry5.local:1456/?key=fixture')); assert.throws(() => validateServer('http://user:pass@raspberry5.local'));
});
test('legacy automatic download preference is removed and cannot be enabled in the Mac edition', t => {
  const { root, encryption } = fixture(t);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ server: 'http://raspberry5.local:1456', autoDownload: true, closeAction: 'tray' }));
  const store = new MacStore(root, encryption);
  assert.equal(store.settings.closeAction, 'tray');
  assert.equal('autoDownload' in store.settings, false);
  assert.equal('autoDownload' in JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')), false);
  assert.throws(() => store.saveSettings({ autoDownload: true }));
});
test('dual keys save together and invalid input leaves both credentials unchanged', t => {
  const { store, root, encryption } = fixture(t); store.bind('gpt', 'gpt-preserved', true);
  const group = store.bindKeys({ claude: 'claude-one', gemini: 'gemini-one' }, true);
  assert.equal(new MacStore(root, encryption).bindKeys({ gemini: 'gemini-one', claude: 'claude-one' }, true), group);
  assert.equal(store.key('claude'), 'claude-one'); assert.equal(store.key('gemini'), 'gemini-one'); assert.equal(store.key('gpt'), 'gpt-preserved');
  const before = fs.readFileSync(path.join(root, 'keys.keychain'));
  assert.throws(() => store.bindKeys({ claude: 'claude-two', gemini: 'invalid\nkey' }, true));
  assert.deepEqual(fs.readFileSync(path.join(root, 'keys.keychain')), before);
});
test('replacing a key selects isolated history and single keys do not reopen paired history', t => {
  const { store } = fixture(t);
  const original = store.bindKeys({ claude: 'claude-one', gemini: 'gemini-one' }, true);
  atomicMarker(store.profile(original));
  const changed = store.bindKeys({ claude: 'claude-two', gemini: 'gemini-one' }, true, '', ['claude']);
  assert.notEqual(changed, original);
  assert.equal(store.keysFor(original)['claude@' + store.settings.server], 'claude-one');
  assert.equal(fs.existsSync(path.join(store.profile(original), 'history-marker')), true);
  assert.equal(fs.existsSync(path.join(store.profile(changed), 'history-marker')), false);
  assert.notEqual(store.bindKeys({ claude: 'claude-two' }, true), changed);
});
test('adding a platform keeps the current history and unremembered changes preserve the untouched key', t => {
  const { store } = fixture(t);
  const solo = store.bindKeys({ claude: 'claude-one' }, true);
  assert.equal(store.bindKeys({ claude: 'claude-one', gemini: 'gemini-one' }, true, solo, ['gemini']), solo);
  const changed = store.bindKeys({ claude: 'claude-two', gemini: 'gemini-one' }, true, '', ['claude']);
  store.bindKeys({ claude: 'claude-two', gemini: 'gemini-one' }, false, changed, ['claude']);
  assert.equal(store.key('claude'), ''); assert.equal(store.key('gemini'), 'gemini-one');
  assert.equal(store.keysFor(changed)['gemini@' + store.settings.server], 'gemini-one');
  store.bind('claude', 'another-window', true);
  store.bindKeys({ claude: 'claude-two', gemini: 'gemini-one' }, true, changed, ['gemini']);
  assert.equal(store.key('claude'), 'another-window');
});
test('an encryption failure during a batch leaves the original keychain file intact', t => {
  const { store, root, encryption } = fixture(t); store.bindKeys({ claude: 'claude-one', gemini: 'gemini-one' }, true);
  const before = fs.readFileSync(path.join(root, 'keys.keychain'));
  store.encryption = { ...encryption, encrypt() { throw new Error('Keychain unavailable'); } };
  assert.throws(() => store.bindKeys({ claude: 'claude-two', gemini: 'gemini-two' }, true), /Keychain unavailable/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'keys.keychain')), before);
});
function atomicMarker(profile) { fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, 'history-marker'), 'existing private history'); }
