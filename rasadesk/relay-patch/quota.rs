// سهمیه‌ی ترافیک رسا دسک: ارتباط hbbs/hbbr با سرور تبلیغات/سهمیه (ads-server) روی همین ماشین.
// مبنا: «کسی که وصل می‌شود» (کنترل‌کننده)، نه دستگاهی که کنترل می‌شود.
// متغیرهای محیطی: RELAY_TOKEN (الزامی؛ بدون آن همه‌چیز غیرفعال است) و QUOTA_URL (پیش‌فرض http://127.0.0.1:5200)
use hbb_common::{log, tokio};
use once_cell::sync::Lazy;
use std::{
    collections::HashMap,
    sync::{Mutex, Once, RwLock},
    time::{Duration, Instant},
};

static BLOCKED: Lazy<RwLock<HashMap<String, String>>> = Lazy::new(Default::default);
static START: Once = Once::new();
// آدرس کنترل‌کننده -> (کلید حساب، زمان)؛ بین درخواست اتصال و پاسخ دستگاه مقصد نگه داشته می‌شود
static CONTROLLERS: Lazy<Mutex<HashMap<String, (String, Instant)>>> = Lazy::new(Default::default);

fn base() -> String {
    std::env::var("QUOTA_URL").unwrap_or_else(|_| "http://127.0.0.1:5200".to_owned())
}

fn token() -> String {
    std::env::var("RELAY_TOKEN").unwrap_or_default()
}

fn enabled() -> bool {
    !token().is_empty()
}

fn http_post(path: &str, body: String) -> Option<String> {
    let res = minreq::post(format!("{}{}", base(), path))
        .with_header("X-Relay-Token", token())
        .with_header("Content-Type", "application/json")
        .with_body(body)
        .with_timeout(3)
        .send()
        .ok()?;
    res.as_str().ok().map(|s| s.to_owned())
}

fn http_get(path: &str) -> Option<String> {
    let res = minreq::get(format!("{}{}", base(), path))
        .with_header("X-Relay-Token", token())
        .with_timeout(3)
        .send()
        .ok()?;
    res.as_str().ok().map(|s| s.to_owned())
}

/// حلقه‌ی همگام‌سازی فهرست حساب‌های محدودشده (هر ۲۰ ثانیه) - فقط بار اول راه می‌افتد
fn ensure_started() {
    if !enabled() {
        return;
    }
    START.call_once(|| {
        tokio::spawn(async move {
            log::info!("quota sync started: {}", base());
            loop {
                let res = tokio::task::spawn_blocking(|| http_get("/api/relay/blocked"))
                    .await
                    .ok()
                    .flatten();
                if let Some(text) = res {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(obj) = v.get("blocked").and_then(|b| b.as_object()) {
                            let map: HashMap<String, String> = obj
                                .iter()
                                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                                .collect();
                            if let Ok(mut w) = BLOCKED.write() {
                                *w = map;
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(20)).await;
            }
        });
    });
}

/// اگر این حساب (id:... یا ip:...) محدود است، متن پیام محدودیت (برای نمایش در برنامه) برگردانده می‌شود
pub fn blocked_message(key: &str) -> Option<String> {
    ensure_started();
    BLOCKED.read().ok()?.get(key).cloned()
}

/// کلید حساب کنترل‌کننده. ادعای «rasa:<ID>» در فیلد token (کلاینت رسا دسک آن را می‌فرستد) فقط وقتی
/// پذیرفته می‌شود که IP ثبت‌شده‌ی آن ID با IP درخواست یکی باشد؛ وگرنه حساب بر اساس IP است.
pub fn controller_key(claim: &str, claimed_ip: Option<String>, request_ip: &str) -> String {
    if let (Some(id), Some(ip)) = (claim.strip_prefix("rasa:"), claimed_ip) {
        if ip == request_ip && !id.is_empty() && id.len() <= 32 {
            return format!("id:{}", id);
        }
    }
    format!("ip:{}", request_ip)
}

pub fn remember_controller(addr: &str, key: &str) {
    if let Ok(mut m) = CONTROLLERS.lock() {
        m.retain(|_, v| v.1.elapsed() < Duration::from_secs(180));
        m.insert(addr.to_owned(), (key.to_owned(), Instant::now()));
    }
}

pub fn controller_for(addr: &str, ip: &str) -> String {
    CONTROLLERS
        .lock()
        .ok()
        .and_then(|m| m.get(addr).map(|v| v.0.clone()))
        .unwrap_or_else(|| format!("ip:{}", ip))
}

/// ثبت نشست relay: uuid -> حسابِ کنترل‌کننده (مبنای شمارش مصرف hbbr) + ID دستگاه مقصد (فقط اطلاع)
pub fn report_session(uuid: &str, controller: &str, target: &str, ip: &str) {
    if !enabled() || uuid.is_empty() || controller.is_empty() {
        return;
    }
    let body = serde_json::json!({ "uuid": uuid, "controller": controller, "target": target, "ip": ip }).to_string();
    tokio::task::spawn_blocking(move || {
        http_post("/api/relay/session", body);
    });
}

/// گزارش مصرف (بایت) یک نشست؛ true یعنی سقف تمام شده و نشست باید قطع شود
pub async fn report_usage(uuid: &str, bytes: u64) -> bool {
    if !enabled() {
        return false;
    }
    let body = serde_json::json!({ "uuid": uuid, "bytes": bytes }).to_string();
    let res = tokio::task::spawn_blocking(move || http_post("/api/relay/usage", body))
        .await
        .ok()
        .flatten();
    res.and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("stop").and_then(|s| s.as_bool()))
        .unwrap_or(false)
}
