const $ = id => document.getElementById(id);
let state, platform = 'chat', working = false;
async function request(command, value) { const result = await window.api.invoke(command, value); if (!result.ok) throw new Error(result.message); return result; }
async function refresh() { state = await request('state'); $('version').textContent = 'v' + state.version; $('gptState').textContent = state.keys.gpt ? 'Key 已保存' : '未配置'; $('chatState').textContent = state.keys.claude && state.keys.gemini ? '两平台 Key 已保存' : state.keys.claude || state.keys.gemini ? 'Key 已保存 · 可添加另一平台' : '接入任意一个分发 Key'; }
function open(kind) { platform = kind; const saved = kind === 'gpt' ? state.keys.gpt : state.keys.claude || state.keys.gemini; $('connectTitle').textContent = kind === 'gpt' ? '连接 GPT' : '连接 Claude / Gemini'; $('baseAddress').textContent = state.settings.server + (kind === 'gpt' ? '/v1' : ' · 平台 Key 独立接入'); $('apply').textContent = kind === 'gpt' ? '保存并切换' : '保存并打开'; $('key').value = ''; $('key').required = !saved; $('key').placeholder = saved ? '留空使用已保存的 ' + (kind === 'gpt' ? 'GPT' : state.keys.claude ? 'Claude' : 'Gemini') + ' Key' : '输入个人分发 Key'; $('connectStatus').textContent = ''; $('connect').showModal(); }
$('gpt').onclick = () => open('gpt'); $('chat').onclick = () => open('chat'); $('cancel').onclick = () => { if (!working) $('connect').close(); };
async function connect(save) {
  if (working || !$('keyForm').reportValidity()) return; working = true;
  $('apply').disabled = $('save').disabled = true; $('connectStatus').classList.remove('error'); $('connectStatus').textContent = '正在检查分发 Key 与模型目录…';
  try { const command = platform === 'gpt' ? save ? 'save-gpt' : 'switch-gpt' : save ? 'save-chat' : 'chat'; const result = await request(command, { key: $('key').value.trim(), remember: $('remember').checked }); $('status').textContent = result.message; $('key').value = ''; $('connect').close(); await refresh(); } catch (error) { $('connectStatus').textContent = error.message; $('connectStatus').classList.add('error'); } finally { working = false; $('apply').disabled = $('save').disabled = false; }
}
$('keyForm').onsubmit = event => { event.preventDefault(); void connect(false); }; $('save').onclick = () => void connect(true);
$('settings').onclick = () => { for (const name of ['server', 'codexPath', 'claudePath', 'closeAction']) $(name).value = state.settings[name]; $('preferences').showModal(); };
$('settingsCancel').onclick = () => $('preferences').close();
$('settingsForm').onsubmit = async event => { event.preventDefault(); try { await request('settings', Object.fromEntries(['server', 'codexPath', 'claudePath', 'closeAction'].map(name => [name, $(name).value]))); await refresh(); $('preferences').close(); } catch (error) { $('status').textContent = error.message; } };
void refresh().then(async () => { try { $('connection').textContent = (await request('health')).message; } catch { $('connection').textContent = '树莓派未连接 · 请检查局域网'; } }).catch(error => { $('status').textContent = error.message; });
