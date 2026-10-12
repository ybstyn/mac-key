const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class MacNative {
  constructor(root, resources) { this.root = root; this.resources = resources; this.workers = new Map(); this.transactions = new Map(); }
  async start(platform) {
    let worker = this.workers.get(platform); if (worker && worker.process.exitCode === null) return worker;
    const bundle = path.join(this.resources, 'native-engine', 'cockpit-tools.app'), executable = path.join(bundle, 'Contents', 'MacOS', 'cockpit-tools');
    if (!fs.existsSync(executable)) throw new Error('Mac 原生组件尚未构建，不能执行切换。');
    const folder = fs.mkdtempSync('/tmp/JuhaiAPI-' + process.getuid() + '-'); fs.chmodSync(folder, 0o700);
    const socket = path.join(folder, 'engine.sock'), ready = path.join(folder, 'ready.json'), token = crypto.randomBytes(32).toString('hex');
    const env = { ...process.env, JUHAI_ENGINE_PIPE: socket, JUHAI_ENGINE_READY: ready, JUHAI_ENGINE_PARENT_PID: String(process.pid), JUHAI_ENGINE_TOKEN: token, JUHAI_ENGINE_PLATFORM: platform, COCKPIT_TOOLS_DATA_DIR: path.join(this.root, 'native-' + platform + '-data') };
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'PI_PW']) delete env[key];
    const child = spawn(executable, [], { env, cwd: bundle, stdio: 'ignore' }); worker = { process: child, token, socket, folder };
    let startupError; child.once('error', error => { startupError = error; }); this.workers.set(platform, worker);
    for (let attempt = 0; attempt < 450; attempt++) {
      if (startupError || child.exitCode !== null) throw new Error('Mac 原生组件启动失败，请查看本地日志。');
      if (fs.existsSync(ready)) { const result = JSON.parse(fs.readFileSync(ready)); if (result.pid !== child.pid || result.pipe !== socket || result.upstreamVersion !== '1.3.66') throw new Error('原生组件身份不匹配。'); fs.unlinkSync(ready); return worker; }
      await delay(100);
    }
    child.kill('SIGTERM'); throw new Error('原生组件没有确认就绪。');
  }
  call(worker, request) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(worker.socket); let text = '';
      socket.setTimeout(180000); socket.once('connect', () => socket.write(JSON.stringify({ ...request, token: worker.token }) + '\n'));
      socket.on('data', data => { text += data; if (text.length > 4 * 1024 * 1024) { socket.destroy(); reject(new Error('原生组件响应过大。')); return; } if (text.includes('\n')) { socket.end(); try { const value = JSON.parse(text.split('\n')[0]); if (!value.ok) reject(new Error(value.error)); else resolve(value.result); } catch (error) { reject(error); } } });
      socket.once('error', reject); socket.once('timeout', () => { socket.destroy(); reject(new Error('原生切换超时，未报告成功。')); }); socket.once('close', () => { if (!text.includes('\n')) reject(new Error('原生组件中断，未报告切换成功。')); });
    });
  }
  async switch(platform, values) {
    if (!['gpt', 'claude'].includes(platform)) throw new Error('不支持的原生平台。');
    if (this.transactions.has(platform)) throw new Error('该平台正在切换，请等待完成。');
    const task = (async () => {
      const worker = await this.start(platform), result = await this.call(worker, { ...values, command: platform === 'gpt' ? 'switch_gpt' : 'switch_claude' });
      if (!result.nativeTransactionCompleted) throw new Error('原生事务尚未确认完成。');
      const instance = platform === 'gpt' ? result.instances?.find(item => item.id === '__default__') : result.instance;
      const pid = result.defaultSettings?.lastPid;
      if (!Number.isInteger(pid) || pid <= 0 || instance?.running !== true) throw new Error('配置已应用，但尚未确认目标客户端 PID。');
      try { process.kill(pid, 0); } catch { throw new Error('目标客户端启动后已退出。'); } return result;
    })();
    this.transactions.set(platform, task); try { return await task; } finally { this.transactions.delete(platform); }
  }
  busy() { return this.transactions.size > 0; }
  async stop() { for (const worker of this.workers.values()) { try { await this.call(worker, { command: 'shutdown' }); } catch { worker.process.kill('SIGTERM'); } for (const name of ['engine.sock', 'ready.json']) { const file = path.join(worker.folder, name); if (fs.existsSync(file)) fs.unlinkSync(file); } try { fs.rmdirSync(worker.folder); } catch {} } this.workers.clear(); }
}
module.exports = { MacNative };
