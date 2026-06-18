use serde::Serialize;
use tauri::{window::Color, LogicalSize, Manager, Size, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const QUOTE_ENDPOINT: &str = "https://push2.eastmoney.com/api/qt/ulist.np/get";

#[derive(Serialize)]
struct StockQuote {
    symbol: String,
    name: String,
    price: Option<f64>,
    change: Option<f64>,
    change_percent: Option<f64>,
    open: Option<f64>,
    high: Option<f64>,
    low: Option<f64>,
    volume: Option<u64>,
    quote_time: String,
}

#[derive(Serialize)]
struct MarketSnapshot {
    quotes: Vec<StockQuote>,
    updated_at: String,
    source: String,
}

fn write_log_file(app: &tauri::AppHandle, level: &str, message: &str) {
    let Some(log_dir) = app.path().app_log_dir().ok() else {
        return;
    };
    if let Err(_) = std::fs::create_dir_all(&log_dir) {
        return;
    }
    let log_path = log_dir.join("xiaobaisha.log");
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let log_line = format!("[{}] [{}] {}\n", now, level, message);

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        use std::io::Write;
        let _ = file.write_all(log_line.as_bytes());
    }
}

#[tauri::command]
fn log_message(app: tauri::AppHandle, level: String, message: String) {
    write_log_file(&app, &level, &message);
}

#[tauri::command]
fn open_log_file(app: tauri::AppHandle) -> Result<(), String> {
    let Some(log_dir) = app.path().app_log_dir().ok() else {
        return Err("获取日志目录失败".to_string());
    };
    let log_path = log_dir.join("xiaobaisha.log");
    if !log_path.exists() {
        if let Err(_) = std::fs::create_dir_all(&log_dir) {
            return Err("创建日志目录失败".to_string());
        }
        if let Err(e) = std::fs::File::create(&log_path) {
            return Err(format!("创建日志文件失败: {e}"));
        }
    }
    app.opener()
        .open_path(log_path.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("打开日志文件失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn resize_window(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    window.set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())?;
    Ok(())
}


async fn fetch_market_snapshot_eastmoney(
    app: &tauri::AppHandle,
    stock_codes: &[String],
) -> Result<MarketSnapshot, String> {
    if stock_codes.is_empty() {
        return Ok(MarketSnapshot {
            quotes: Vec::new(),
            updated_at: current_unix_seconds().to_string(),
            source: "东方财富网页行情".to_string(),
        });
    }

    let secids = stock_codes
        .iter()
        .filter_map(|code| stock_code_to_secid(code))
        .collect::<Vec<_>>();

    if secids.is_empty() {
        return Ok(MarketSnapshot {
            quotes: Vec::new(),
            updated_at: current_unix_seconds().to_string(),
            source: "东方财富网页行情".to_string(),
        });
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 Xiaobaisha/0.1")
        .build()
        .map_err(|error| {
            let log_msg = format!("东财源: 初始化行情客户端失败: {:?}", error);
            write_log_file(app, "ERROR", &log_msg);
            format!("初始化行情客户端失败: {error}")
        })?;

    let url = format!(
        "{QUOTE_ENDPOINT}?fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f5,f15,f16,f17,f18&secids={}",
        secids.join(",")
    );
    let text = client
        .get(url)
        .header("Referer", "https://quote.eastmoney.com/")
        .send()
        .await
        .map_err(|error| {
            let log_msg = format!("东财源: 获取 A 股行情失败 (详细原因): {:?}", error);
            write_log_file(app, "ERROR", &log_msg);
            format!("获取 A 股行情失败: {error}")
        })?
        .text()
        .await
        .map_err(|error| {
            let log_msg = format!("东财源: 读取 A 股行情失败 (详细原因): {:?}", error);
            write_log_file(app, "ERROR", &log_msg);
            format!("读取 A 股行情失败: {error}")
        })?;
    let payload = serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|error| {
            let log_msg = format!("东财源: 解析 A 股行情失败 (详细原因): {:?}", error);
            write_log_file(app, "ERROR", &log_msg);
            format!("解析 A 股行情失败: {error}")
        })?;
    let quotes = payload
        .get("data")
        .and_then(|data| data.get("diff"))
        .and_then(|diff| diff.as_array())
        .ok_or_else(|| {
            let msg = "东财源: A 股行情响应缺少 data.diff".to_string();
            write_log_file(app, "ERROR", &msg);
            msg
        })?
        .iter()
        .map(parse_quote)
        .collect::<Vec<_>>();

    Ok(MarketSnapshot {
        quotes,
        updated_at: current_unix_seconds().to_string(),
        source: "东方财富网页行情".to_string(),
    })
}

fn stock_code_to_tencent_id(code: &str) -> Option<String> {
    let code = code.trim();
    if code.len() != 6 || !code.chars().all(|char| char.is_ascii_digit()) {
        return None;
    }
    let prefix = if code.starts_with('5') || code.starts_with('6') || code == "000001" {
        "sh"
    } else {
        "sz"
    };
    Some(format!("{prefix}{code}"))
}

async fn fetch_market_snapshot_from_tencent(
    app: &tauri::AppHandle,
    stock_codes: &[String],
) -> Result<MarketSnapshot, String> {
    let tencent_ids = stock_codes
        .iter()
        .filter_map(|code| stock_code_to_tencent_id(code))
        .collect::<Vec<_>>();

    if tencent_ids.is_empty() {
        return Ok(MarketSnapshot {
            quotes: Vec::new(),
            updated_at: current_unix_seconds().to_string(),
            source: "腾讯财经行情".to_string(),
        });
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 Xiaobaisha/0.1")
        .build()
        .map_err(|error| {
            let log_msg = format!("腾讯源: 初始化行情客户端失败: {:?}", error);
            write_log_file(app, "ERROR", &log_msg);
            format!("初始化行情客户端失败: {error}")
        })?;

    let url = format!("https://qt.gtimg.cn/q={}", tencent_ids.join(","));
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| {
            let log_msg = format!("腾讯源: 获取行情失败 (详细原因): {:?}", error);
            write_log_file(app, "ERROR", &log_msg);
            format!("获取腾讯行情失败: {error}")
        })?;

    let bytes = response.bytes().await.map_err(|error| {
        let log_msg = format!("腾讯源: 读取行情字节流失败 (详细原因): {:?}", error);
        write_log_file(app, "ERROR", &log_msg);
        format!("读取腾讯行情字节流失败: {error}")
    })?;

    let (cow, _, had_errors) = encoding_rs::GBK.decode(&bytes);
    if had_errors {
        write_log_file(app, "WARNING", "腾讯源: GBK 解码过程中遇到一些无效字符");
    }
    let text = cow.into_owned();

    let mut quotes = Vec::new();
    for line in text.split(';') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(start) = line.find('"') else { continue; };
        let Some(end) = line.rfind('"') else { continue; };
        if start >= end {
            continue;
        }
        let data_str = &line[start + 1..end];
        let parts = data_str.split('~').collect::<Vec<_>>();
        if parts.len() < 35 {
            continue;
        }

        let name = parts[1].to_string();
        let symbol = parts[2].to_string();
        let price = parts[3].parse::<f64>().ok();
        let open = parts[5].parse::<f64>().ok();
        let volume = parts[6].parse::<u64>().ok().map(|v| v * 100);
        let high = parts[33].parse::<f64>().ok();
        let low = parts[34].parse::<f64>().ok();
        let change = parts[31].parse::<f64>().ok();
        let change_percent = parts[32].parse::<f64>().ok();

        quotes.push(StockQuote {
            symbol,
            name,
            price,
            change,
            change_percent,
            open,
            high,
            low,
            volume,
            quote_time: String::new(),
        });
    }

    Ok(MarketSnapshot {
        quotes,
        updated_at: current_unix_seconds().to_string(),
        source: "腾讯财经行情".to_string(),
    })
}

#[tauri::command]
async fn fetch_market_snapshot(
    app: tauri::AppHandle,
    stock_codes: Vec<String>,
) -> Result<MarketSnapshot, String> {
    match fetch_market_snapshot_eastmoney(&app, &stock_codes).await {
        Ok(snapshot) => Ok(snapshot),
        Err(eastmoney_err) => {
            let warning_msg = format!(
                "东财源获取行情失败 ({})，正在尝试切换到腾讯财经备选数据源...",
                eastmoney_err
            );
            write_log_file(&app, "WARNING", &warning_msg);

            match fetch_market_snapshot_from_tencent(&app, &stock_codes).await {
                Ok(snapshot) => {
                    write_log_file(&app, "INFO", "腾讯财经备选数据源行情获取成功！");
                    Ok(snapshot)
                }
                Err(tencent_err) => {
                    let err_msg = format!(
                        "所有数据源均获取行情失败。东财错误: {} ; 腾讯错误: {}",
                        eastmoney_err, tencent_err
                    );
                    write_log_file(&app, "ERROR", &err_msg);
                    Err(err_msg)
                }
            }
        }
    }
}

fn stock_code_to_secid(code: &str) -> Option<String> {
    let code = code.trim();
    if code.len() != 6 || !code.chars().all(|char| char.is_ascii_digit()) {
        return None;
    }

    // 5 开头基金/ETF、6 开头股票和上证指数 000001 都需要走沪市 secid。
    let market = if code.starts_with('5') || code.starts_with('6') || code == "000001" {
        "1"
    } else {
        "0"
    };
    Some(format!("{market}.{code}"))
}

fn parse_quote(value: &serde_json::Value) -> StockQuote {
    StockQuote {
        symbol: read_string(value, "f12").unwrap_or_default(),
        name: read_string(value, "f14").unwrap_or_default(),
        price: read_number(value, "f2"),
        change: read_number(value, "f4"),
        change_percent: read_number(value, "f3"),
        open: read_number(value, "f17"),
        high: read_number(value, "f15"),
        low: read_number(value, "f16"),
        volume: read_u64(value, "f5"),
        quote_time: String::new(),
    }
}

fn read_string(value: &serde_json::Value, key: &str) -> Option<String> {
    let field = value.get(key)?;
    field
        .as_str()
        .map(ToString::to_string)
        .or_else(|| field.as_i64().map(|number| number.to_string()))
}

fn read_number(value: &serde_json::Value, key: &str) -> Option<f64> {
    let field = value.get(key)?;
    field
        .as_f64()
        .or_else(|| field.as_str().and_then(|text| text.parse::<f64>().ok()))
}

fn read_u64(value: &serde_json::Value, key: &str) -> Option<u64> {
    let field = value.get(key)?;
    field
        .as_u64()
        .or_else(|| field.as_str().and_then(|text| text.parse::<u64>().ok()))
}

fn current_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn toggle_overlay(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyE);
            let shortcut_for_handler = shortcut.clone();

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if shortcut == &shortcut_for_handler
                            && event.state() == ShortcutState::Pressed
                        {
                            toggle_overlay(app);
                        }
                    })
                    .build(),
            )?;

            app.global_shortcut().register(shortcut)?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_shadow(false);
                let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
            }

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fetch_market_snapshot,
            resize_window,
            start_dragging,
            log_message,
            open_log_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
