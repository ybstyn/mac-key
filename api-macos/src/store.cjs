const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function validateServer(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请填写树莓派根地址，不包含路径、Key 或账号密码。');
  if (/(^|\.)(anthropic\.com|claude\.com|googleapis\.com|google\.com)$/i.test(url.hostname)) throw new Error('分发 Key 只能用于 Cock 网关。');
  if (url.protocol === 'http:' && !(url.hostname.endsWith('.local') || !url.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname))) throw new Error('公网网关请使用 HTTPS。');
  return url.origin;
}
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, content, { mode: 0o600 }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
class MacStore {
  constructor(root, encryption) {
    this.root = root; this.encryption = encryption;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const saved = this.read('settings.json', {}), { autoDownload, ...settings } = saved;
    this.settings = { server: 'http://raspberry5.local:1456', closeAction: 'ask', codexPath: '', claudePath: '', ...settings };
    this.settings.server = validateServer(this.settings.server);
    if (autoDownload !== undefined) atomic(path.join(root, 'settings.json'), JSON.stringify(this.settings));
  }
  read(name, fallback) { const file = path.join(this.root, name); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  saveSettings(change) {
    if (Object.keys(change).some(key => !['server', 'closeAction', 'codexPath', 'claudePath'].includes(key))) throw new Error('此 Mac 版本不支持该设置。');
    const next = { ...this.settings, ...change }; next.server = validateServer(next.server);
    if (!['ask', 'tray', 'exit'].includes(next.closeAction)) throw new Error('关闭选项无效。');
    atomic(path.join(this.root, 'settings.json'), JSON.stringify(next)); this.settings = next;
  }
  vault() { const file = path.join(this.root, 'keys.keychain'); return fs.existsSync(file) ? JSON.parse(this.encryption.decrypt(fs.readFileSync(file))) : { keys: {}, bindings: {}, groups: {} }; }
  saveVault(value) { atomic(path.join(this.root, 'keys.keychain'), this.encryption.encrypt(JSON.stringify(value))); }
  mutateVault(action) {
    const lock = path.join(this.root, 'vault.lock'), started = Date.now(); let owned = false;
    while (!owned && Date.now() - started < 10000) {
      try { fs.mkdirSync(lock, { mode: 0o700 }); owned = true; fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (missing) { if (missing.code === 'ESRCH') { fs.unlinkSync(path.join(lock, 'pid')); fs.rmdirSync(lock); continue; } } } } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    if (!owned) throw new Error('Key 保存正在进行，请稍后重试。');
    try { return action(); } finally { fs.unlinkSync(path.join(lock, 'pid')); fs.rmdirSync(lock); }
  }
  id(platform) { if (!['gpt', 'claude', 'gemini'].includes(platform)) throw new Error('未知平台。'); return platform + '@' + this.settings.server; }
  key(platform) { return this.vault().keys[this.id(platform)] || ''; }
  bind(platform, key, remember, group = '') {
    if (!key || key.length > 4096 || /[\x00-\x1f\x7f]/.test(key) || !['gpt', 'claude', 'gemini'].includes(platform)) throw new Error('请输入有效的个人分发 Key。');
    return this.mutateVault(() => {
    const value = this.vault(), binding = crypto.createHash('sha256').update(this.settings.server + '\n' + platform + '\n' + key).digest('hex');
    if (group && !/^[a-f0-9]{32}$/.test(group)) throw new Error('本地会话空间无效。');
    const known = value.bindings[binding];
    if (known && group && known !== group) throw new Error('此 Key 已属于其他本地会话空间，请从主窗口单独打开。');
    const selected = group || known || binding.slice(0, 32), item = value.groups[selected] || {};
    if (item[platform + '@' + this.settings.server] && item[platform + '@' + this.settings.server] !== key) throw new Error('此会话空间已接入另一枚 Key，请单独打开新用户空间。');
    value.bindings[binding] = selected;
    if (remember) { value.keys[this.id(platform)] = key; item[this.id(platform)] = key; }
    else { delete item[this.id(platform)]; if (value.keys[this.id(platform)] === key) delete value.keys[this.id(platform)]; }
    value.groups[selected] = item; this.saveVault(value); return selected;
    });
  }
  bindKeys(submitted, remember, preferredGroup = '', enteredPlatforms) {
    const inputs = {};
    for (const [platform, raw] of Object.entries(submitted)) {
      if (!['claude', 'gemini'].includes(platform) || typeof raw !== 'string') throw new Error('请输入有效的平台 Key。');
      const key = raw.trim(); if (!key) continue;
      if (key.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) throw new Error('Key 格式无效。');
      inputs[platform] = key;
    }
    const platforms = Object.keys(inputs), entered = new Set(enteredPlatforms || platforms);
    if (!platforms.length || !entered.size || [...entered].some(platform => !inputs[platform])) throw new Error('请至少填写一个有效的平台 Key。');
    if (preferredGroup && !/^[a-f0-9]{32}$/.test(preferredGroup)) throw new Error('本地会话空间无效。');
    return this.mutateVault(() => {
      const value = this.vault(), hash = text => crypto.createHash('sha256').update(text).digest('hex');
      value.pairs ||= {};
      const binding = platform => hash(this.settings.server + '\n' + platform + '\n' + inputs[platform]);
      const compatible = group => platforms.every(platform => {
        const saved = value.groups[group]?.[this.id(platform)], known = value.bindings[binding(platform)];
        return (!saved || saved === inputs[platform]) && (!known || known === group);
      });
      const pair = platforms.length === 2 ? 'pair:' + hash(this.settings.server + '\nclaude\n' + inputs.claude + '\ngemini\n' + inputs.gemini) : 'single:' + binding(platforms[0]);
      let group = value.pairs[pair] || (platforms.length === 1 ? value.bindings[binding(platforms[0])] : '');
      if (!group && preferredGroup && compatible(preferredGroup)) group = preferredGroup;
      if (!group) {
        const prior = [...new Set(platforms.map(binding).map(id => value.bindings[id]).filter(Boolean))];
        if (prior.length === 1 && compatible(prior[0])) group = prior[0];
      }
      group ||= platforms.length === 2 ? hash('paired\n' + this.settings.server + '\n' + inputs.claude + '\n' + inputs.gemini).slice(0, 32) : binding(platforms[0]).slice(0, 32);
      const item = value.groups[group] || {};
      for (const platform of platforms) if (item[this.id(platform)] && item[this.id(platform)] !== inputs[platform]) throw new Error('Key 与此会话空间不匹配。');
      value.pairs[pair] = group;
      if (platforms.length === 1) value.bindings[binding(platforms[0])] = group;
      for (const platform of platforms) {
        const id = this.id(platform), key = inputs[platform];
        const persist = entered.has(platform) ? remember : Object.values(value.groups).some(row => row[id] === key) || value.keys[id] === key;
        if (persist) item[id] = key; else delete item[id];
        if (entered.has(platform)) { if (remember) value.keys[id] = key; else if (value.keys[id] === key) delete value.keys[id]; }
      }
      value.groups[group] = item; this.saveVault(value); return group;
    });
  }
  keysFor(group) { return this.vault().groups[group] || {}; }
  profile(group) { if (!/^[a-f0-9]{32}$/.test(group)) throw new Error('本地会话空间无效。'); return path.join(this.root, 'cherry-chats', 'shared', group); }
  ownProfile(profile) { const full = path.resolve(profile), base = path.join(this.root, 'cherry-chats', 'shared') + path.sep; if (!full.startsWith(base) || !/^[a-f0-9]{32}$/.test(path.basename(full))) throw new Error('会话不属于当前用户。'); return full; }
  provision(config) { const profile = this.profile(config.group); atomic(path.join(profile, 'api-launch.dpapi'), this.encryption.encrypt(JSON.stringify(config))); return profile; }
  exportProvision(file) { const profile = this.ownProfile(path.dirname(file)); if (path.basename(file) !== 'api-launch.dpapi') throw new Error('对话配置文件无效。'); const result = this.encryption.decrypt(fs.readFileSync(path.join(profile, 'api-launch.dpapi'))); fs.unlinkSync(file); return result; }
}
module.exports = { MacStore, validateServer, atomic };
