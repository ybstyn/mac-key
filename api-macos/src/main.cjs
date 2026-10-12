const { app, BrowserWindow, ipcMain, dialog, session, safeStorage, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { MacStore, validateServer, atomic } = require('./store.cjs');
const { MacNative } = require('./native.cjs');

app.setName('API');
const root = path.join(app.getPath('appData'), 'JuhaiAPI');
const mode = process.argv.includes('--api-smoke') ? 'smoke' : process.argv.includes('--api-chat') ? 'chat' : process.argv.includes('--chat-provision') ? 'export' : process.argv.includes('--chat-save-keys') ? 'save-batch' : process.argv.includes('--chat-save-key') ? 'save' : 'main';
const encryption = {
  encrypt(value) { if (!safeStorage.isEncryptionAvailable()) throw new Error('Mac 钥匙串不可用，请解锁登录钥匙串后重试。'); return safeStorage.encryptString(value); },
  decrypt(value) { if (!safeStorage.isEncryptionAvailable()) throw new Error('Mac 钥匙串不可用，保存的 Key 尚未解密。'); return safeStorage.decryptString(value); }
};
if (mode === 'chat') {
  process.env.API_CHAT_PLATFORM = 'shared';
  process.env.API_CHAT_LAUNCHER = process.execPath;
  require(path.join(__dirname, '../out/main/managedEntryPoint.js'));
} else {
  if (mode === 'main') {
    app.setPath('userData', path.join(root, 'launcher'));
    if (!app.requestSingleInstanceLock()) app.quit();
  }
  let store, window, tray, native, quitting = false, closing = false;
  const chats = new Map();
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../resources');
  const errorText = error => String(error.message || error).replace(/ck_[\w-]+/g, '[Key]');
  async function direct(route, platform, key, options = {}) {
    const target = new URL(route, store.settings.server);
    if (target.origin !== store.settings.server) throw new Error('请求地址不属于当前网关。');
    const gateway = session.fromPartition('api-launcher-gateway'); await gateway.setProxy({ mode: 'direct' });
    const headers = key ? { [platform === 'gpt' ? 'authorization' : platform === 'claude' ? 'x-api-key' : 'x-goog-api-key']: platform === 'gpt' ? 'Bearer ' + key : key } : {};
    return gateway.fetch(target.href, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  }
  async function catalog(platform, key) {
    const route = platform === 'gpt' ? '/v1/models' : platform === 'claude' ? '/claude/v1/models' : '/gemini/v1beta/models';
    const response = await direct(route, platform, key);
    if (!response.ok) { const error = new Error(response.status === 401 ? '分发 Key 无效。' : response.status === 403 ? 'Key 平台权限不匹配。' : response.status === 503 ? '账号池暂不可用。' : '模型目录读取失败（HTTP ' + response.status + '）。'); error.status = response.status; throw error; }
    const payload = await response.json();
    const rows = platform === 'gemini' ? payload.models : payload.data;
    const models = (Array.isArray(rows) ? rows : []).map(row => ({ id: String(row.id || row.name || '').replace(/^models\//, ''), label: String(row.display_name || row.displayName || row.id || row.name || ''), ...(row.cockpit ? { controls: row.cockpit } : {}) })).filter(row => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(row.id));
    if (!models.length) throw new Error('这枚 Key 没有可用模型。'); return models;
  }
  async function resolve(key) {
    try { return { platform: 'claude', models: await catalog('claude', key) }; } catch (error) { if (![401, 403].includes(error.status)) throw error; }
    return { platform: 'gemini', models: await catalog('gemini', key) };
  }
  async function prepareChat(values, savedFallback = true, validatePlatforms) {
    if (['gemini', 'claude', 'key'].some(platform => typeof values[platform] === 'string' && (values[platform].length > 4096 || /[\x00-\x1f\x7f]/.test(values[platform])))) throw new Error('Key 格式无效，不能超长或包含控制字符。');
    let keys = Object.fromEntries(['gemini', 'claude'].map(platform => [platform, typeof values[platform] === 'string' ? values[platform].trim() : '']).filter(([, key]) => key));
    if (!Object.keys(keys).length && values.key) { const resolved = await resolve(values.key.trim()); keys = { [resolved.platform]: values.key.trim() }; }
    if (!Object.keys(keys).length && savedFallback) keys = Object.fromEntries(['gemini', 'claude'].map(platform => [platform, store.key(platform)]).filter(([, key]) => key));
    if (!Object.keys(keys).length) throw new Error('请至少填写一个 Gemini 或 Claude 分发 Key。');
    const channels = [];
    for (const [platform, key] of Object.entries(keys)) {
      let models = [];
      if (!validatePlatforms || validatePlatforms.has(platform)) try { models = await catalog(platform, key); } catch (error) { throw new Error((platform === 'claude' ? 'Claude' : 'Gemini') + ' Key 未接通：' + errorText(error)); }
      channels.push({ platform, key, models, model: models[0]?.id || '', sessions: [], channel: platform === 'claude' ? 'claude_messages' : 'gemini_web' });
    }
    return { keys, channels };
  }
  async function launchChat(config) {
    const profile = store.provision(config);
    const env = { ...process.env, API_CHAT_PROFILE: profile, API_CHAT_PLATFORM: 'shared', API_CHAT_LAUNCHER: process.execPath };
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'PI_PW', 'JUHAI_ENGINE_TOKEN', 'JUHAI_ENGINE_PIPE']) delete env[name];
    const child = spawn(process.execPath, ['--api-chat'], { env, stdio: 'ignore' }); let failed;
    child.once('error', error => { failed = error; });
    for (let attempt = 0; attempt < 600; attempt++) {
      if (failed || child.exitCode !== null && child.exitCode !== 0) throw new Error('对话窗口启动失败，请查看本地日志。');
      const ready = path.join(profile, 'api-chat-ready.json');
      if (fs.existsSync(ready)) { const value = JSON.parse(fs.readFileSync(ready)); if (value.pid === child.pid || child.exitCode === 0) { chats.set(profile, value.pid); return { message: 'Key 已接入，对话窗口已启动。真实调用以实际回复为准。', pid: value.pid }; } }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('对话窗口尚未确认就绪。');
  }
  async function stopChats() {
    const owned = [];
    const candidates = new Map(chats), base = path.join(root, 'cherry-chats/shared');
    if (fs.existsSync(base)) for (const item of fs.readdirSync(base, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-f0-9]{32}$/.test(item.name)) continue;
      const profile = store.ownProfile(path.join(base, item.name)), ready = path.join(profile, 'api-chat-ready.json'), activity = path.join(profile, 'api-chat-activity.json');
      if (!fs.existsSync(ready) || !fs.existsSync(activity) || Date.now() - fs.statSync(activity).mtimeMs > 10000) continue;
      const value = JSON.parse(fs.readFileSync(ready)); if (Number.isInteger(value.pid) && value.pid > 0) candidates.set(profile, value.pid);
    }
    for (const [profile, pid] of candidates) {
      try { process.kill(pid, 0); } catch { continue; }
      const file = path.join(profile, 'api-chat-activity.json');
      if (!fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > 10000) throw new Error('请先退出 API 内置对话窗口。');
      const value = JSON.parse(fs.readFileSync(file)); if (value.pid !== pid || value.activeReplies > 0) throw new Error('对话正在回复，请先停止回复，或保留在菜单栏。'); owned.push({ profile, pid });
    }
    for (const value of owned) atomic(path.join(value.profile, 'api-chat-update-request.json'), JSON.stringify({ pid: value.pid, nonce: crypto.randomBytes(16).toString('hex') }));
    for (let attempt = 0; attempt < 150; attempt++) { if (owned.every(value => { try { process.kill(value.pid, 0); return false; } catch { return true; } })) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('对话窗口尚未正常退出，请稍后重试。');
  }
  async function requestClose() {
    if (closing || quitting) return; closing = true;
    try {
      if (native.busy()) throw new Error('原生切换正在进行，请等待操作完成。');
      let action = store.settings.closeAction;
      if (action === 'ask') { const choice = await dialog.showMessageBox(window, { type: 'question', title: '关闭 API', message: '关闭后怎么处理？', buttons: ['保留在菜单栏', '直接退出', '取消'], defaultId: 0, cancelId: 2, checkboxLabel: '记住我的选择', checkboxChecked: false }); if (choice.response === 2) return; action = choice.response === 0 ? 'tray' : 'exit'; store.saveSettings({ closeAction: choice.checkboxChecked ? action : 'ask' }); }
      if (action === 'tray') { window.hide(); return; }
      await stopChats(); await native.stop(); quitting = true; app.quit();
    } catch (error) { await dialog.showMessageBox(window, { type: 'warning', message: errorText(error) }); } finally { closing = false; }
  }
  async function invoke(command, values) {
    if (command === 'state') return { version: app.getVersion(), settings: store.settings, keys: Object.fromEntries(['gpt', 'claude', 'gemini'].map(platform => [platform, Boolean(store.key(platform))])) };
    if (command === 'settings') { store.saveSettings(values); return { message: '设置已保存。' }; }
    if (command === 'health') { const response = await direct('/healthz'); if (!response.ok) throw new Error('网关连接未完成。'); return { message: '树莓派已连接 · 本程序直连' }; }
    const entered = typeof values.key === 'string' ? values.key.trim() : '';
    if (command === 'chat' || command === 'save-chat') {
      if (command === 'save-chat' && values.remember !== true) throw new Error('仅保存 Key 时请勾选“记住 Key”。');
      const prepared = await prepareChat(values), group = store.bindKeys(prepared.keys, values.remember);
      if (command === 'save-chat') return { message: '填写的平台 Key 已保存；尚未启动对话。' };
      return launchChat({ platform: 'shared', server: store.settings.server, group, entryPlatform: prepared.channels[0].platform, channels: prepared.channels });
    }
    if (command === 'save-gpt') { const key = entered || store.key('gpt'); await catalog('gpt', key); store.bind('gpt', key, values.remember); return { message: 'GPT Key 已保存；尚未应用配置。' }; }
    if (command === 'switch-gpt' || command === 'switch-claude') {
      const platform = command === 'switch-gpt' ? 'gpt' : 'claude', key = entered || store.key(platform), models = await catalog(platform, key);
      const confirm = await dialog.showMessageBox(window, { type: 'warning', message: '将关闭并重新启动目标 ' + (platform === 'gpt' ? 'Codex' : 'Claude Desktop') + ' 实例，请先保存工作。', buttons: ['取消', '保存并切换'], cancelId: 0, defaultId: 0 }); if (confirm.response !== 1) return { message: '切换已取消。' };
      const result = await native.switch(platform, { apiKey: key, baseUrl: store.settings.server + (platform === 'gpt' ? '/v1' : '/claude'), clientPath: platform === 'gpt' ? store.settings.codexPath : store.settings.claudePath, models: models.map(row => row.id), model: models[0].id }); store.bind(platform, key, values.remember); return { message: '原生切换已完成，目标客户端 PID 已确认。', result };
    }
    throw new Error('未知操作。');
  }
  app.whenReady().then(async () => {
    store = new MacStore(root, encryption);
    if (mode === 'smoke') {
      if (process.platform !== 'darwin' || process.env.CI !== 'true') throw new Error('Mac smoke checks require an isolated macOS CI runner.');
      const output = process.argv[process.argv.indexOf('--api-smoke') + 1];
      if (!path.resolve(output).startsWith(path.resolve(app.getPath('temp')) + path.sep + 'api-mac-smoke-')) throw new Error('Smoke output must be isolated.');
      const result = { version: app.getVersion(), keychainAvailable: safeStorage.isEncryptionAvailable(), platform: process.platform, arch: process.arch, isPackaged: app.isPackaged, nativeSwitches: 0 };
      if (!app.isPackaged) throw new Error('Mac 应用仍处于开发模式，不能通过安装包验收。');
      const cipher = encryption.encrypt('local-keychain-smoke-only'); result.keychainRoundTrip = encryption.decrypt(cipher) === 'local-keychain-smoke-only';
      native = new MacNative(path.join(output, 'native-data'), resources);
      try { const worker = await native.start('gpt'); const pong = await native.call(worker, { command: 'ping' }); result.nativeVersion = pong.upstreamVersion; result.nativeEntry = pong.nativeSwitchEntry; } finally { await native.stop(); }
      if (!result.keychainAvailable || !result.keychainRoundTrip || result.nativeVersion !== '1.3.66') throw new Error('Mac native/keychain verification failed.');
      fs.writeFileSync(path.join(output, 'smoke.json'), JSON.stringify(result)); app.quit(); return;
    }
    if (mode === 'export') { const file = process.argv[process.argv.indexOf('--chat-provision') + 1]; process.stdout.write(store.exportProvision(file)); app.quit(); return; }
    if (mode === 'save') { let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 32768) throw new Error('Key 数据超出限制。'); } const value = JSON.parse(text); const profile = store.ownProfile(value.profile); if (path.basename(profile) !== value.group || validateServer(value.server) !== store.settings.server) throw new Error('Key 保存地址与当前会话不匹配。'); store.bind(value.platform, value.key, value.remember, value.group); process.stdout.write('{"saved":true}'); app.quit(); return; }
    if (mode === 'save-batch') {
      let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 32768) throw new Error('Key 数据超出限制。'); }
      const value = JSON.parse(text), profile = store.ownProfile(value.profile);
      if (path.basename(profile) !== value.group || validateServer(value.server) !== store.settings.server) throw new Error('Key 保存地址与当前会话不匹配。');
      const entered = value.enteredPlatforms;
      if (!Array.isArray(entered) || !entered.length || entered.some(platform => !['gemini', 'claude'].includes(platform) || typeof value[platform] !== 'string' || !value[platform].trim())) throw new Error('填写的平台列表无效。');
      const prepared = await prepareChat(value, false, new Set(entered));
      const group = store.bindKeys(prepared.keys, value.remember, value.replacement ? '' : value.group, entered);
      let pid = 0;
      if (group !== value.group) {
        const result = await launchChat({ platform: 'shared', server: store.settings.server, group, entryPlatform: entered[0], channels: prepared.channels }); pid = result.pid;
      }
      process.stdout.write(JSON.stringify({ saved: true, switched: group !== value.group, pid })); app.quit(); return;
    }
    native = new MacNative(root, resources);
    window = new BrowserWindow({ width: 760, height: 500, minWidth: 710, minHeight: 490, show: false, backgroundColor: '#F6F8FB', title: 'API', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault()); window.on('close', event => { if (!quitting) { event.preventDefault(); void requestClose(); } });
    ipcMain.handle('api:invoke', async (event, command, values = {}) => { if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('请求来源不属于主窗口。'); try { return { ok: true, ...await invoke(command, values) }; } catch (error) { return { ok: false, message: errorText(error) }; } });
    const image = nativeImage.createFromPath(path.join(__dirname, '../assets/brand.png')).resize({ width: 18, height: 18 }); image.setTemplateImage(true); tray = new Tray(image); tray.setToolTip('API'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 API', click: () => { window.show(); window.focus(); } }, { label: '退出', click: () => void requestClose() }]));
    app.on('activate', () => { window.show(); window.focus(); }); app.on('second-instance', () => { window.show(); window.focus(); });
    window.once('ready-to-show', () => { window.show(); }); await window.loadFile(path.join(__dirname, '../ui/index.html'));
  }).catch(error => { if (mode === 'main') dialog.showErrorBox('API 启动未完成', errorText(error)); else process.stderr.write(errorText(error) + '\n' + String(error.stack || '') + '\n'); app.exit(1); });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
