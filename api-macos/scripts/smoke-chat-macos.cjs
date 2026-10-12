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
const executable = path.join(project, 'build/app/API.app/Contents/MacOS/API');
const runId = crypto.randomUUID();
const keys = { claude: 'fixture-claude-' + runId, gemini: 'fixture-gemini-' + runId, other: 'fixture-other-' + runId };
const markers = { claude: 'Mac Claude stream ' + runId, gemini: 'Mac Gemini stream ' + runId };
const observations = [];
const pendingStreams = new Map();
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
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: markers.claude.slice(0, 12) } });
      await new Promise(resolve => pendingStreams.set(platform, resolve));
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: markers.claude.slice(12) } });
      event({ type: 'content_block_stop', index: 0 });
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
      event({ type: 'message_stop' });
    } else {
      send({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: markers.gemini.slice(0, 12) }] } }] });
      await new Promise(resolve => pendingStreams.set(platform, resolve));
      send({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: markers.gemini.slice(12) }] } }] });
      send({ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 4, totalTokenCount: 5 } });
    }
    response.end();
  } catch (error) { failure = error; response.destroy(); }
});

async function rpc(page, route, input) {
  const envelope = await page.evaluate(async ({ route, input }) => window.api.ipcApi.request(route, input), { route, input });
  assert.ok(envelope.ok, JSON.stringify(envelope.error)); return envelope.data;
}
async function catalogReady(page, count) {
  await expect(page.locator('[data-ui~="api-managed.model-picker"]')).toBeVisible({ timeout: 90000 });
  const workspace = await rpc(page, 'managed_chat.workspace');
  assert.equal(workspace.models.length, count);
  await page.locator('[data-ui~="api-managed.model-picker"]').click();
  await expect(page.locator('[data-ui~="api-managed.model"]')).toHaveCount(count);
  await page.keyboard.press('Escape');
  return workspace;
}
async function selectModel(page, model) {
  await page.locator('[data-ui~="api-managed.model-picker"]').click();
  await page.locator('[data-ui~="api-managed.model"][data-model-id="' + model.id + '"]').click();
}
async function chatWindow(instance) {
  let selected;
  await expect.poll(() => {
    selected = instance.windows().find(page => page.url().includes('/windows/main/index.html'));
    return Boolean(selected);
  }, { timeout: 90000 }).toBe(true);
  return selected;
}
const opened = new Set();
const diagnostics = [];
const redact = value => Object.values(keys).reduce((text, key) => text.replaceAll(key, '[fixture-Key]'), String(value));
async function launch(args = [], profile) {
  const env = { ...process.env, CI: 'true' };
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'PI_PW', 'ELECTRON_RUN_AS_NODE', 'API_CHAT_PROFILE', 'API_CHAT_PLATFORM', 'API_CHAT_LAUNCHER']) delete env[name];
  if (profile) Object.assign(env, { API_CHAT_PROFILE: profile, API_CHAT_PLATFORM: 'shared', API_CHAT_LAUNCHER: executable });
  const instance = await electron.launch({ executablePath: executable, args, env, timeout: 90000 }); opened.add(instance);
  const record = { mode: args.join(' ') || 'launcher', stdout: '', stderr: '', pages: [] }; diagnostics.push(record);
  for (const field of ['stdout', 'stderr']) instance.process()[field]?.on('data', chunk => { record[field] = redact(record[field] + chunk).slice(-24000); });
  const watch = page => {
    page.on('pageerror', error => record.pages.push({ type: 'pageerror', message: redact(error.stack || error.message) }));
    page.on('console', message => { if (message.type() === 'error') record.pages.push({ type: 'console', message: redact(message.text()).slice(0, 2000) }); });
  };
  instance.on('window', watch); for (const page of instance.windows()) watch(page);
  return instance;
}
async function close(instance) { await instance.close(); opened.delete(instance); }
async function captureFailure(error) {
  let index = 0;
  for (const instance of opened) {
    const record = { windows: [] };
    try {
      record.boot = await instance.evaluate(({ app, BrowserWindow }) => {
        const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path');
        const logs = app.getPath('logs');
        return {
          appPath: app.getAppPath(), userData: app.getPath('userData'),
          windows: BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), url: window.webContents.getURL(), visible: window.isVisible() })),
          logs: fs.existsSync(logs) ? fs.readdirSync(logs).filter(name => /\.log$/.test(name)).slice(0, 5).map(name => ({ name, text: fs.readFileSync(path.join(logs, name), 'utf8').slice(-16000) })) : []
        };
      });
    } catch (failure) { record.bootError = String(failure); }
    for (const page of instance.windows()) {
      try {
        record.windows.push({ url: page.url(), text: await page.locator('body').innerText({ timeout: 5000 }), api: await page.evaluate(() => ({ api: typeof window.api, ipc: typeof window.api?.ipcApi })) });
        await page.screenshot({ path: path.join(project, 'release/macos-chat-failure-' + index++ + '.png'), timeout: 5000 });
      } catch (failure) { record.windows.push({ error: String(failure) }); }
    }
    diagnostics.push(record);
  }
  const output = redact(JSON.stringify({ error: error.stack, diagnostics }, null, 2));
  fs.writeFileSync(path.join(project, 'release/macos-chat-diagnostics.json'), output);
  console.error(output);
}

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
  const beforePair = await main.evaluate(() => window.api.invoke('state'));
  const invalidPair = await main.evaluate(({ gemini }) => window.api.invoke('save-chat', { gemini, claude: 'invalid-local-fixture', remember: true }), keys);
  assert.equal(invalidPair.ok, false);
  assert.deepEqual((await main.evaluate(() => window.api.invoke('state'))).keys, beforePair.keys);
  const validPair = await main.evaluate(({ gemini, claude }) => window.api.invoke('save-chat', { gemini, claude, remember: true }), keys);
  assert.equal(validPair.ok, true);
  await main.locator('#chat').click();
  await expect(main.locator('#geminiKey')).toBeVisible(); await expect(main.locator('#claudeKey')).toBeVisible();
  assert.equal(await main.locator('#geminiKey').inputValue(), ''); assert.equal(await main.locator('#claudeKey').inputValue(), '');
  await main.screenshot({ path: path.join(project, 'release/macos-dual-key-preview.png') });
  await main.locator('#cancel').click();
  const seed = async other => launcher.evaluate(({ app, safeStorage }, { origin, keys, other }) => {
    const path = process.getBuiltinModule('node:path');
    const load = process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const { MacStore } = load(path.join(app.getAppPath(), 'src/store.cjs'));
    const store = new MacStore(path.join(app.getPath('appData'), 'JuhaiAPI'), { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) });
    const group = store.bindKeys(other ? { claude: keys.other } : { claude: keys.claude, gemini: keys.gemini }, true);
    const channels = [{ platform: 'claude', key: other ? keys.other : keys.claude, model: 'claude-haiku-fixture', models: [{ id: 'claude-haiku-fixture', label: 'Claude local fixture' }], sessions: [], channel: 'claude_messages' }];
    if (!other) channels.push({ platform: 'gemini', key: keys.gemini, model: 'gemini-flash-fixture', models: [{ id: 'gemini-flash-fixture', label: 'Gemini local fixture' }], sessions: [], channel: 'gemini_web' });
    return store.provision({ platform: 'shared', server: origin, group, entryPlatform: 'claude', channels });
  }, { origin, keys, other });
  const profile = await seed(false), chat = await launch(['--api-chat'], profile), page = await chatWindow(chat);
  await catalogReady(page, 2);
  const topics = {};
  for (const platform of ['claude', 'gemini']) {
    const model = (await rpc(page, 'managed_chat.workspace')).models.find(row => row.platform === platform);
    assert.ok(model.available);
    const topic = await rpc(page, 'managed_chat.create_topic', { modelId: model.id }); topics[platform] = topic.id;
    await selectModel(page, model);
    await page.locator('[data-ui~="api-managed.topic"][data-topic-id="' + topic.id + '"]').click({ timeout: 15000 });
    const opening = rpc(page, 'ai.stream.open', { topicId: topic.id, trigger: 'submit-message', userMessageParts: [{ type: 'text', text: 'hello-local-' + platform }] }).then(value => ({ value }), error => ({ error }));
    await expect(page.getByText(markers[platform].slice(0, 12), { exact: false }).first()).toBeVisible({ timeout: 45000 });
    await expect(page.locator('[data-ui~="api-managed.new-topic"]')).toBeEnabled();
    await expect(page.locator('[data-ui~="api-managed.platform"][data-platform="' + (platform === 'claude' ? 'gemini' : 'claude') + '"]')).toBeEnabled();
    await page.locator('[data-ui~="api-managed.new-topic"]').click();
    await expect(page.getByText(markers[platform].slice(0, 12), { exact: false }).first()).not.toBeVisible();
    assert.ok(pendingStreams.has(platform)); pendingStreams.get(platform)(); pendingStreams.delete(platform);
    const openedStream = await opening; if (openedStream.error) throw openedStream.error;
    const unread = page.locator('[data-ui~="api-managed.unread"][data-unread-topic="' + topic.id + '"]');
    await expect(unread).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: path.join(project, 'release/macos-unread-' + platform + '-preview.png') });
    await page.locator('[data-ui~="api-managed.topic"][data-topic-id="' + topic.id + '"]').click();
    await expect(page.getByText(markers[platform], { exact: false }).first()).toBeVisible({ timeout: 45000 });
    await expect(unread).toHaveCount(0);
  }
  assert.ok(!failure, failure?.message);
  assert.ok(observations.some(row => row.platform === 'claude' && row.authenticated));
  assert.ok(observations.some(row => row.platform === 'gemini' && row.authenticated));
  await page.screenshot({ path: path.join(project, 'release/macos-chat-preview.png') });
  await close(chat);
  assert.equal(await seed(false), profile);
  const reopened = await launch(['--api-chat'], profile), restored = await chatWindow(reopened);
  const workspace = await catalogReady(restored, 2);
  for (const platform of ['claude', 'gemini']) {
    const model = workspace.models.find(row => row.platform === platform);
    assert.ok(model.topics.some(row => row.id === topics[platform]), 'Saved conversations must survive restarting');
    await selectModel(restored, model);
    await restored.locator('[data-ui~="api-managed.topic"][data-topic-id="' + topics[platform] + '"]').click();
    await expect(restored.getByText(markers[platform], { exact: false }).first()).toBeVisible();
  }
  await close(reopened);
  const otherProfile = await seed(true); assert.notEqual(otherProfile, profile);
  const otherChat = await launch(['--api-chat'], otherProfile), otherPage = await chatWindow(otherChat);
  const otherWorkspace = await catalogReady(otherPage, 1);
  assert.ok(otherWorkspace.models.every(model => model.topics.every(topic => !Object.values(topics).includes(topic.id))), 'A different distributed Key must not load another user history');
  const connected = await rpc(otherPage, 'managed_chat.connect_keys', { gemini: keys.gemini, claude: '', remember: true });
  assert.equal(connected.switched, false); assert.deepEqual(connected.platforms, ['gemini']);
  await expect.poll(async () => (await rpc(otherPage, 'managed_chat.workspace')).models.length, { timeout: 15000 }).toBe(2);
  const added = await rpc(otherPage, 'managed_chat.workspace');
  assert.ok(added.models.every(model => model.topics.every(topic => !Object.values(topics).includes(topic.id))));
  await close(otherChat);
  await launcher.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1024, 700); window.webContents.setZoomFactor(1.25); });
  await main.waitForFunction(() => window.innerWidth > 780);
  const scaledLayout = await main.evaluate(() => {
    const selectors = ['.heading', '#gpt', '#chat', '#status', 'footer'];
    return { width: innerWidth, height: innerHeight, boxes: selectors.map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { selector, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }) };
  });
  assert.ok(scaledLayout.boxes.every(rect => rect.left >= 0 && rect.top >= 0 && rect.right <= scaledLayout.width + 1 && rect.bottom <= scaledLayout.height + 1), JSON.stringify(scaledLayout));
  const scaledImage = await launcher.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const image = await window.webContents.capturePage();
    return { png: image.toPNG().toString('base64'), size: image.getSize(), windowSize: window.getContentSize() };
  });
  assert.equal(scaledImage.size.width, scaledImage.windowSize[0]);
  fs.writeFileSync(path.join(project, 'release/macos-scaled-preview.png'), Buffer.from(scaledImage.png, 'base64'));
  fs.writeFileSync(path.join(project, 'release/macos-scaled-layout.json'), JSON.stringify({ layout: scaledLayout, imageSize: scaledImage.size, contentSize: scaledImage.windowSize }, null, 2));
  await launcher.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.hide(); window.show(); window.focus(); });
  await expect(main.locator('#gpt')).toBeVisible();
  await close(launcher);
  const pageErrors = diagnostics.flatMap(record => record.pages || []).filter(event => event.type === 'pageerror');
  assert.deepEqual(pageErrors, [], 'Chat windows must not report an unhandled renderer error');
  fs.writeFileSync(path.join(project, 'release/macos-chat-smoke.json'), JSON.stringify({ passed: true, version: JSON.parse(fs.readFileSync(path.join(project, 'package.json'))).version, platform: 'darwin', arch: 'arm64', simulatedConversations: observations.length, authenticatedPaths: observations, sessionRestore: true, userIsolation: true, invalidKeyRejected: true, invalidPairNotSaved: true, dualKeyEntry: true, macBatchBridge: true, interactiveWhileStreaming: true, unreadReplies: true, mainWindowScaled: true, windowRestore: true, realModelCalls: 0, officialClientsLaunched: 0 }, null, 2));
  console.log(JSON.stringify({ macChatSmokePassed: true, simulatedConversations: observations.length, realModelCalls: 0 }));
})().catch(async error => { await captureFailure(error); console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  for (const resolve of pendingStreams.values()) resolve(); pendingStreams.clear();
  for (const instance of opened) { try { await instance.close(); } catch {} }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
