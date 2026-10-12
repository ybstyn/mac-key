//! Small authenticated transport adapter. Account switching and instance startup
//! are intentionally delegated to the unchanged Cockpit 1.3.66 command modules.
use crate::{commands, models, modules};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    command: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    client_path: String,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    model: String,
}

fn checkpoint_path() -> Result<PathBuf, String> {
    Ok(modules::account::get_data_dir()?.join("juhai-previous-account.json"))
}

async fn state() -> Result<Value, String> {
    let settings = modules::codex_instance::load_default_settings()?;
    let views = commands::codex_instance::codex_list_instances().await?;
    let current = modules::codex_account::get_current_account().map(|account| account.id);
    Ok(json!({"upstreamVersion": env!("CARGO_PKG_VERSION"), "currentAccountId":current,
        "defaultSettings":settings,"instances":views}))
}

fn configure(request: &Request) -> Result<(), String> {
    if !request.client_path.is_empty() {
        let path = std::path::Path::new(&request.client_path);
        let valid = path.is_file()
            || cfg!(target_os = "macos") && path.is_dir() && path.extension().is_some_and(|value| value == "app");
        if !valid {
            return Err("指定的官方客户端程序不存在".into());
        }
        commands::system::set_app_path("codex".into(), request.client_path.clone())?;
    }
    modules::config::patch_user_config(|config| {
        config.codex_launch_on_switch = true;
        config.startup_minimized = true;
        Ok(())
    })?;
    // This product targets the official desktop, while retaining all other
    // existing native default settings, routing, working directory and arguments.
    modules::codex_instance::update_default_settings(None,None,None,None,
        Some(models::InstanceLaunchMode::App),None)?;
    Ok(())
}

async fn handle(app: tauri::AppHandle, request: Request, events: Arc<Mutex<Vec<Value>>>) -> Result<Value,String> {
    match request.command.as_str() {
        "ping" => Ok(json!({"upstreamVersion":env!("CARGO_PKG_VERSION"),"nativeSwitchEntry":"switch_codex_account"})),
        "get_state" => state().await,
        "switch_claude" => {
            if request.api_key.trim().is_empty() { return Err("缺少 Claude API Key".into()); }
            if !request.client_path.is_empty() {
                commands::system::set_app_path("claude".into(),request.client_path.clone())?;
            }
            let claude_models:Vec<String>=request.models.iter().filter(|model|
                modules::claude_desktop_gateway::is_claude_desktop_model(model)).cloned().collect();
            if claude_models.is_empty() { return Err("当前 Key 尚未提供 Claude Desktop 可识别的模型，请在树莓派设置模型 ID 或映射".into()); }
            let upstream_models=request.models.clone();
            let mappings=claude_models.iter().map(|model|models::claude::ClaudeDesktopGatewayModelMapping {
                desktop_model:model.clone(),upstream_model:model.clone(),label_override:None,supports_1m:None
            }).collect();
            let account=commands::claude::import_claude_desktop_gateway(
                app.clone(),request.api_key,Some("剧海API · Claude".into()),Some(request.base_url),
                Some("juhai-api-claude".into()),Some("剧海API".into()),None,None,None,None,
                Some(request.models),None,Some("bearer".into()),Some(claude_models),Some("local_mapping".into()),Some(upstream_models),Some(mappings)).await?;
            // The original account-switch entry already closes the old desktop,
            // applies both normal/3p config and starts the new desktop. Calling
            // claude_start_instance immediately afterwards would kill and start it
            // a second time. Record the original launch without another restart.
            let switch_id=account.id.clone();let switch_app=app.clone();
            let message=tauri::async_runtime::spawn_blocking(move||
                commands::claude::switch_claude_account(switch_app,switch_id)).await.map_err(|error|error.to_string())??;
            modules::claude_instance::update_default_settings(Some(Some(account.id.clone())),None,None,
                Some(false),Some(models::InstanceLaunchMode::App))?;
            let pid=modules::claude_instance::resolve_claude_pid(None,None)
                .ok_or("原生账号切换已返回，但未找到真实 Claude Desktop 主进程")?;
            modules::claude_instance::update_default_pid(Some(pid))?;
            let views=commands::claude_instance::claude_list_instances().await?;
            let view=views.into_iter().find(|item|item.id=="__default__")
                .ok_or("Claude 默认实例未登记")?;
            let settings=modules::claude_instance::load_default_settings()?;
            Ok(json!({"nativeTransactionCompleted":true,"upstreamVersion":env!("CARGO_PKG_VERSION"),
                "accountId":account.id,"defaultSettings":settings,"instance":view,"message":message}))
        }
        "shutdown" => { app.exit(0); Ok(json!({"stopping":true})) },
        "get_events" => {
            let mut values = events.lock().map_err(|_| "进度锁失效")?;
            Ok(Value::Array(std::mem::take(&mut *values)))
        }
        "switch_gpt" => {
            if request.api_key.trim().is_empty() { return Err("缺少 API Key".into()); }
            let url = url::Url::parse(&request.base_url).map_err(|_| "基础地址无效")?;
            if !matches!(url.scheme(), "http"|"https") || !url.username().is_empty() || url.password().is_some() {
                return Err("基础地址格式无效".into());
            }
            configure(&request)?;
            let previous = modules::codex_account::get_current_account().or_else(|| {
                modules::codex_account::import_from_local_at(&modules::codex_account::get_codex_home()).ok()
            }).map(|account| account.id);
            // A restore checkpoint contains only account identifiers. The native
            // account store remains responsible for credential encryption.
            let checkpoint = checkpoint_path()?;
            let mut catalog = request.models.clone();
            if !request.model.is_empty() {
                if !catalog.contains(&request.model) { return Err("所选模型不属于当前 Key".into()); }
                catalog.retain(|model| model != &request.model);
                catalog.insert(0,request.model.clone());
            }
            let account = commands::codex::add_codex_account_with_api_key(
                request.api_key, Some(request.base_url), Some(models::codex::CodexApiProviderMode::Custom),
                Some("juhai-api".into()),Some("剧海API".into()),Some(catalog),Some(true),
                Some("responses".into()),Some(false),Some(false),None,None,
                Some("剧海API · GPT".into()),None)?;
            // This is the real original desktop transaction, including token
            // preparation, old runtime/gateway/injection shutdown, projection,
            // account and instance binding, speed/session sync and native startup.
            let selected_id=account.id.clone();
            let switched = commands::codex::switch_codex_account(app,account.id,None,None,Some(true)).await?;
            if previous.as_deref()!=Some(selected_id.as_str()) || !checkpoint.exists() {
                let content=serde_json::to_string(&json!({"previousAccountId":previous})).map_err(|error|error.to_string())?;
                modules::atomic_write::write_string_atomic(&checkpoint,&content).map_err(|error|error.to_string())?;
            }
            let mut result = state().await?;
            result["accountId"] = json!(switched.id);
            result["nativeTransactionCompleted"] = json!(true);
            Ok(result)
        }
        "restore_gpt" => {
            configure(&request)?;
            let data: Value = serde_json::from_slice(&std::fs::read(checkpoint_path()?).map_err(|error|error.to_string())?)
                .map_err(|error|error.to_string())?;
            let account_id = data.get("previousAccountId").and_then(Value::as_str)
                .filter(|value|!value.is_empty()).ok_or("没有可通过原生切换恢复的先前账号")?;
            commands::codex::switch_codex_account(app,account_id.to_string(),None,None,Some(true)).await?;
            let mut result = state().await?;
            result["nativeTransactionCompleted"] = json!(true);
            Ok(result)
        }
        _ => Err("不支持的原生后台操作".into())
    }
}

pub fn start(app: tauri::AppHandle) -> Result<(),String> {
    let pipe = match std::env::var("JUHAI_ENGINE_PIPE") { Ok(value)=>value,Err(_)=>return Ok(()) };
    let token = std::env::var("JUHAI_ENGINE_TOKEN").map_err(|_|"缺少后台连接凭据")?;
    if token.len() < 32 { return Err("后台传输配置无效".into()); }
    #[cfg(target_os = "windows")]
    if !pipe.starts_with(r"\\.\pipe\JuhaiAPI-") { return Err("后台传输配置无效".into()); }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::MetadataExt;
        let socket = std::path::Path::new(&pipe);
        let parent = socket.parent().ok_or("缺少本地通信目录")?;
        let metadata = std::fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
        if !socket.is_absolute() || socket.file_name().is_none_or(|name| name != "engine.sock")
            || !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0 || pipe.len() > 100 {
            return Err("本地通信目录必须属于当前用户且仅该用户可访问".into());
        }
    }
    let ready_path = std::env::var_os("JUHAI_ENGINE_READY").map(PathBuf::from).ok_or("缺少后台就绪文件路径")?;
    // Original launch commands inherit process environment. Keep bridge secrets
    // in adapter memory so they cannot reach the official client or its tools.
    std::env::remove_var("JUHAI_ENGINE_TOKEN");
    if let Ok(parent)=std::env::var("JUHAI_ENGINE_PARENT_PID").and_then(|value|value.parse::<u32>().map_err(|_|std::env::VarError::NotPresent)) {
        let owner=app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                if !modules::process::is_pid_running(parent) { owner.exit(0); break; }
            }
        });
    }
    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    for name in ["codex:switch-progress","codex:instance-launch-progress"] {
        let collection = events.clone();
        app.listen(name,move |event| {
            if let Ok(value)=serde_json::from_str::<Value>(event.payload()) {
                if let Ok(mut rows)=collection.lock() { if rows.len()>=128 { rows.remove(0); } rows.push(value); }
            }
        });
    }
    if let Some(window)=app.get_webview_window("main") { let _=window.hide(); let _=window.set_skip_taskbar(true); }
    #[cfg(target_os = "windows")]
    tauri::async_runtime::spawn(async move {
        let mut first=true;
        loop {
            let server=tokio::net::windows::named_pipe::ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true).create(&pipe);
            let mut server=match server { Ok(server)=>server,Err(error)=>{ modules::logger::log_error(&format!("[JuhaiBridge] 建立管道失败: {error}")); break; } };
            if first {
                let content=json!({"pid":std::process::id(),"upstreamVersion":env!("CARGO_PKG_VERSION"),"pipe":pipe}).to_string();
                if let Err(error)=modules::atomic_write::write_string_atomic(&ready_path,&content) {
                    modules::logger::log_error(&format!("[JuhaiBridge] 发布就绪状态失败: {error}")); break;
                }
                first=false;
            }
            if server.connect().await.is_err() { continue; }
            let app=app.clone(); let expected=token.clone(); let collection=events.clone();
            tauri::async_runtime::spawn(async move {
                let mut reader=BufReader::new((&mut server).take(1024*1024+1)); let mut line=String::new();
                let read=tokio::time::timeout(std::time::Duration::from_secs(10),reader.read_line(&mut line)).await;
                let response=if !matches!(read,Ok(Ok(size)) if size>0) || line.len()>1024*1024 {
                    json!({"ok":false,"error":"后台请求无效"})
                } else {
                    match serde_json::from_str::<Request>(&line) {
                        Ok(request) if request.token==expected => match handle(app,request,collection).await {
                            Ok(result)=>json!({"ok":true,"result":result}),
                            Err(error)=>json!({"ok":false,"error":error}),
                        },
                        _=>json!({"ok":false,"error":"后台身份校验失败"}),
                    }
                };
                drop(reader);
                let bytes=format!("{}\n",response).into_bytes();
                let _=server.write_all(&bytes).await; let _=server.flush().await;
            });
        }
    });
    #[cfg(target_os = "macos")]
    tauri::async_runtime::spawn(async move {
        use std::os::unix::fs::PermissionsExt;
        let listener = match tokio::net::UnixListener::bind(&pipe) {
            Ok(value) => value,
            Err(error) => { modules::logger::log_error(&format!("[JuhaiBridge] 建立本地通信失败: {error}")); return; }
        };
        if std::fs::set_permissions(&pipe, std::fs::Permissions::from_mode(0o600)).is_err() { app.exit(1); return; }
        let content=json!({"pid":std::process::id(),"upstreamVersion":env!("CARGO_PKG_VERSION"),"pipe":pipe}).to_string();
        if modules::atomic_write::write_string_atomic(&ready_path,&content).is_err() { app.exit(1); return; }
        while let Ok((mut socket, _)) = listener.accept().await {
            if socket.peer_cred().map(|value| value.uid()).ok() != Some(unsafe { libc::geteuid() }) { continue; }
            let app=app.clone(); let expected=token.clone(); let collection=events.clone();
            tauri::async_runtime::spawn(async move {
                let mut reader=BufReader::new((&mut socket).take(1024*1024+1)); let mut line=String::new();
                let read=tokio::time::timeout(std::time::Duration::from_secs(10),reader.read_line(&mut line)).await;
                let response=if !matches!(read,Ok(Ok(size)) if size>0) || line.len()>1024*1024 {
                    json!({"ok":false,"error":"后台请求无效"})
                } else {
                    match serde_json::from_str::<Request>(&line) {
                        Ok(request) if request.token==expected => match handle(app,request,collection).await {
                            Ok(result)=>json!({"ok":true,"result":result}),
                            Err(error)=>json!({"ok":false,"error":error}),
                        },
                        _=>json!({"ok":false,"error":"后台身份校验失败"}),
                    }
                };
                drop(reader);
                let bytes=format!("{}\n",response).into_bytes();
                let _=socket.write_all(&bytes).await; let _=socket.flush().await;
            });
        }
        let _=std::fs::remove_file(&pipe);
    });
    Ok(())
}
