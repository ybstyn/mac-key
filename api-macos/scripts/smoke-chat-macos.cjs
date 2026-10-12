const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(process.env.CI, 'true', 'Chat verification runs only in isolated CI');
const project = path.resolve(__dirname, '..');
const { _electron: electron, expect } = createRequire(path.join(project, '../cherry-studio/package.json'))('@playwright/test');
const executable = path.join(project, 'build/app/API.app/Contents/MacOS/Electron');
const runId = crypto.randomUUID();
const keys = { claude: 'fixture-claude-' + runId, gemini: 'fixture-gemini-' + runId, other: 'fixture-other-' + runId };
const markers = { claude: 'Mac Claude stream ' + runId, gemini: 'Mac Gemini stream ' + runId };
const observations = [];
let failure;
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const platform = url.pathname.startsWith('/claude/') ? 'claude' : url.pathname.startsWith('/gemini/') ? 'gemini' : '';
    const key = request.headers['x-api-key'] || request.headers['x-goog-api-key'] || request.headers.authorization?.replace(/^Bearer /, '');
    if (platform && !(key === keys[platform] || platform === 'claude' && key === keys.other)) { response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Invalid local fixture key"}}'); return; }
    const json = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/healthz') { json({ ok: true }); return; }
    if (url.pathname === '/claude/v1/models') { json({ data: [{ id: 'claude-haiku-fixture', display_name: 'Claude local fixture' }] }); return; }
    if (url.pathname === '/gemini/v1beta/models') { json({ models: [{ name: 'models/gemini-flash-fixture', displayName: 'Gemini local fixture' }] }); return; }
    if (url.pathname.endsWith('/cockpit/quota')) { json({ accounts: [] }); return; }
    if (url.pathname.endsWith('/count_tokens')) { json({ input_tokens: 1 }); return; }
    if (!platform || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const expected = platform === 'claude' ? '/claude/v1/messages' : '/gemini/v1beta/models/gemini-flash-fixture:streamGenerateContent';
    assert.equal(url.pathname, expected);
    if (platform === 'gemini') assert.equal(url.searchParams.get('alt'), 'sse');
    const input = JSON.stringify(body);
    assert.ok(input.includes('hello-local-' + platform), 'The renderer message must reach the mock gateway');
    observations.push({ platform, path: url.pathname, authenticated: key === keys[platform], streaming: true });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    const event = value => response.write('event: ' + value.type + '\n' + 'data: ' + JSON.stringify(value) + '\n\n');
    if (platform === 'claude') {
      event({ type: 'message_start', message: { id: 'local-' + runId, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const text of [markers.claude.slice(0, 12), markers.claude.slice(12)]) { event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }); await new Promise(resolve => setTimeout(resolve, 100)); }
      event({ type: 'content_block_stop', index: 0 });
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
      event({ type: 'message_stop' });
    } else {
      for (const text of [markers.gemini.slice(0, 12), markers.gemini.slice(12)]) { send({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }] }); await new Promise(resolve => setTimeout(resolve, 100)); }
      send({ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 4, totalTokenCount: 5 } });
    }
    response.end();
  } catch (error) { failure = error; response.destroy(); }
});

async function rpc(page, route, input) {
  const envelope = await page.evaluate(async ({ route, input }) => window.api.ipcApi.request(route, input), { route, input });
  assert.ok(envelope.ok, JSON.stringify(envelope.error)); return envelope.data;
}
const opened = new Set();
async function launch(args = [], profile) {
  const env = { ...process.env, CI: 'true' };
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'PI_PW', 'ELECTRON_RUN_AS_NODE', 'API_CHAT_PROFILE', 'API_CHAT_PLATFORM', 'API_CHAT_LAUNCHER']) delete env[name];
  if (profile) Object.assign(env, { API_CHAT_PROFILE: profile, API_CHAT_PLATFORM: 'shared', API_CHAT_LAUNCHER: executable });
  const instance = await electron.launch({ executablePath: executable, args, env, timeout: 90000 }); opened.add(instance); return instance;
}
async function close(instance) { await instance.close(); opened.delete(instance); }

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const launcher = await launch(), main = await launcher.firstWindow();
  await main.locator('#gpt').waitFor();
  await expect(main.locator('#updates')).toHaveCount(0);
  await main.screenshot({ path: path.join(project, 'release/macos-main-preview.png') });
  const change = await main.evaluate(server => window.api.invoke('settings', { server, closeAction: 'exit' }), origin);
  assert.ok(change.ok);
  const invalid = await main.evaluate(() => window.api.invoke('save-chat', { key: 'invalid-local-fixture', remember: true }));
  assert.equal(invalid.ok, false); assert.match(invalid.message, /Key.*无效/);
  const seed = async other => launcher.evaluate(({ app, safeStorage }, { origin, keys, other }) => {
    const path = require('node:path'), { MacStore } = require(path.join(app.getAppPath(), 'src/store.cjs'));
    const store = new MacStore(path.join(app.getPath('appData'), 'JuhaiAPI'), { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) });
    const group = store.bind('claude', other ? keys.other : keys.claude, true);
    if (!other) store.bind('gemini', keys.gemini, true, group);
    const channels = [{ platform: 'claude', key: other ? keys.other : keys.claude, model: 'claude-haiku-fixture', models: [{ id: 'claude-haiku-fixture', label: 'Claude local fixture' }], sessions: [], channel: 'claude_messages' }];
    if (!other) channels.push({ platform: 'gemini', key: keys.gemini, model: 'gemini-flash-fixture', models: [{ id: 'gemini-flash-fixture', label: 'Gemini local fixture' }], sessions: [], channel: 'gemini_web' });
    return store.provision({ platform: 'shared', server: origin, group, entryPlatform: 'claude', channels });
  }, { origin, keys, other });
  const profile = await seed(false), chat = await launch(['--api-chat'], profile), page = await chat.firstWindow();
  await expect(page.locator('[data-ui="api-managed.model"]')).toHaveCount(2, { timeout: 90000 });
  const topics = {};
  for (const platform of ['claude', 'gemini']) {
    const model = (await rpc(page, 'managed_chat.workspace')).models.find(row => row.platform === platform);
    assert.ok(model.available);
    const topic = await rpc(page, 'managed_chat.create_topic', { modelId: model.id }); topics[platform] = topic.id;
    const button = page.locator('[data-ui="api-managed.model"][data-model-id="' + model.id + '"]'); await button.click();
    await page.locator('[data-ui="api-managed.topic"][data-topic-id="' + topic.id + '"]').click({ timeout: 15000 });
    await rpc(page, 'ai.stream.open', { topicId: topic.id, trigger: 'submit-message', userMessageParts: [{ type: 'text', text: 'hello-local-' + platform }] });
    await expect(page.getByText(markers[platform], { exact: false }).first()).toBeVisible({ timeout: 45000 });
    await expect(page.locator('[data-ui="api-managed.model"]').first()).toBeEnabled();
  }
  assert.ok(!failure, failure?.message);
  assert.ok(observations.some(row => row.platform === 'claude' && row.authenticated));
  assert.ok(observations.some(row => row.platform === 'gemini' && row.authenticated));
  await page.screenshot({ path: path.join(project, 'release/macos-chat-preview.png') });
  await close(chat);
  assert.equal(await seed(false), profile);
  const reopened = await launch(['--api-chat'], profile), restored = await reopened.firstWindow();
  await expect(restored.locator('[data-ui="api-managed.model"]')).toHaveCount(2, { timeout: 90000 });
  const workspace = await rpc(restored, 'managed_chat.workspace');
  for (const platform of ['claude', 'gemini']) {
    const model = workspace.models.find(row => row.platform === platform);
    assert.ok(model.topics.some(row => row.id === topics[platform]), 'Saved conversations must survive restarting');
    await restored.locator('[data-ui="api-managed.model"][data-model-id="' + model.id + '"]').click();
    await restored.locator('[data-ui="api-managed.topic"][data-topic-id="' + topics[platform] + '"]').click();
    await expect(restored.getByText(markers[platform], { exact: false }).first()).toBeVisible();
  }
  await close(reopened);
  const otherProfile = await seed(true); assert.notEqual(otherProfile, profile);
  const otherChat = await launch(['--api-chat'], otherProfile), otherPage = await otherChat.firstWindow();
  await expect(otherPage.locator('[data-ui="api-managed.model"]')).toHaveCount(1, { timeout: 90000 });
  const otherWorkspace = await rpc(otherPage, 'managed_chat.workspace');
  assert.ok(otherWorkspace.models.every(model => model.topics.every(topic => !Object.values(topics).includes(topic.id))), 'A different distributed Key must not load another user history');
  await close(otherChat);
  await launcher.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1024, 700); window.webContents.setZoomFactor(1.25); });
  await main.screenshot({ path: path.join(project, 'release/macos-scaled-preview.png') });
  await launcher.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.hide(); window.show(); window.focus(); });
  await expect(main.locator('#gpt')).toBeVisible();
  await close(launcher);
  fs.writeFileSync(path.join(project, 'release/macos-chat-smoke.json'), JSON.stringify({ passed: true, platform: 'darwin', arch: 'arm64', simulatedConversations: observations.length, authenticatedPaths: observations, sessionRestore: true, userIsolation: true, invalidKeyRejected: true, mainWindowScaled: true, windowRestore: true, realModelCalls: 0, officialClientsLaunched: 0 }, null, 2));
  console.log(JSON.stringify({ macChatSmokePassed: true, simulatedConversations: observations.length, realModelCalls: 0 }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  for (const instance of opened) { try { await instance.close(); } catch {} }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
