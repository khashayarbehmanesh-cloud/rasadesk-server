#!/usr/bin/env node
// اعمال وصله‌ی سهمیه‌ی ترافیک روی سورس rustdesk-server (تگ 1.1.16)
//   node apply-relay-patch.js <rustdesk-server-root>
// مجوز: AGPL-3.0 مثل rustdesk-server. اگر الگویی پیدا نشود، با خطا متوقف می‌شود.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
let failed = 0;

function edit(rel, fn, label) {
  const f = path.join(root, rel);
  if (!fs.existsSync(f)) { console.error(`✗ ${label}: ${rel} not found`); failed++; return; }
  const raw = fs.readFileSync(f, 'utf8');
  const crlf = raw.includes('\r\n');
  let s = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  try { s = fn(s); } catch (e) { console.error(`✗ ${label}: ${e.message}`); failed++; return; }
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
  console.log(`✓ ${label}`);
}
function once(s, from, to) {
  if (s.includes(to) && !from.includes(to)) return s; // قبلاً اعمال شده
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, found ${n}: ${from.slice(0, 60).replace(/\n/g, '⏎')}`);
  return s.replace(from, () => to);
}

fs.copyFileSync(path.join(__dirname, 'quota.rs'), path.join(root, 'src', 'quota.rs'));
console.log('✓ src/quota.rs');

edit('src/lib.rs', (s) => (s.includes('mod quota;') ? s : s + 'mod quota;\n'), 'lib.rs: mod quota');
edit('src/hbbr.rs', (s) => once(s, 'mod common;\n', 'mod common;\nmod quota;\n'), 'hbbr.rs: mod quota');

edit('src/rendezvous_server.rs', (s) => {
  // 0) تابع کمکی: کلید حساب «کسی که وصل می‌شود» (ادعای rasa:<ID> فقط با IP یکسان پذیرفته می‌شود)
  s = once(s, '    #[inline]\n    async fn handle_online_request(',
`    async fn quota_controller(&self, token: &str, addr: SocketAddr) -> String {
        let req_ip = try_into_v4(addr).ip().to_string();
        let mut claimed_ip = None;
        if let Some(cid) = token.strip_prefix("rasa:") {
            if let Some(p) = self.pm.get_in_memory(cid).await {
                claimed_ip = Some(try_into_v4(p.read().await.socket_addr).ip().to_string());
            }
        }
        crate::quota::controller_key(token, claimed_ip, &req_ip)
    }

    #[inline]
    async fn handle_online_request(`);
  // 1) مسیر PunchHoleRequest: اگر «کسی که وصل می‌شود» محدود است، پیام محدودیت به کلاینت برگردد
  s = once(s, '        let id = ph.id;\n        // punch hole request from A, relay to B,',
`        let controller = self.quota_controller(&ph.token, addr).await;
        crate::quota::remember_controller(&try_into_v4(addr).to_string(), &controller);
        if let Some(msg) = crate::quota::blocked_message(&controller) {
            let mut msg_out = RendezvousMessage::new();
            msg_out.set_punch_hole_response(PunchHoleResponse {
                other_failure: msg,
                ..Default::default()
            });
            return Ok((msg_out, None));
        }
        let id = ph.id;
        // punch hole request from A, relay to B,`);
  // 2) مسیر RequestRelay (TCP): بررسی سهمیه و ثبت نشست
  s = once(s, '                    if let Some(peer) = self.pm.get_in_memory(&rf.id).await {\n                        let mut msg_out = RendezvousMessage::new();\n                        rf.socket_addr',
`                    let controller = self.quota_controller(&rf.token, addr).await;
                    if let Some(msg) = crate::quota::blocked_message(&controller) {
                        let mut msg_out = RendezvousMessage::new();
                        msg_out.set_relay_response(RelayResponse {
                            refuse_reason: msg,
                            ..Default::default()
                        });
                        allow_err!(self.send_to_tcp_sync(msg_out, addr).await);
                        return true;
                    }
                    crate::quota::report_session(&rf.uuid, &controller, &rf.id, &try_into_v4(addr).ip().to_string());
                    if let Some(peer) = self.pm.get_in_memory(&rf.id).await {
                        let mut msg_out = RendezvousMessage::new();
                        rf.socket_addr`);
  // 3) مسیر RelayResponse (پاسخ دستگاه مقصد): ثبت نشست uuid -> حساب کنترل‌کننده
  s = once(s, '                    let addr_b = AddrMangle::decode(&rr.socket_addr);\n                    rr.socket_addr = Default::default();\n',
`                    let addr_b = AddrMangle::decode(&rr.socket_addr);
                    rr.socket_addr = Default::default();
                    {
                        let ip_b = addr_b.ip().to_string();
                        let ctrl = crate::quota::controller_for(&try_into_v4(addr_b).to_string(), &ip_b);
                        crate::quota::report_session(&rr.uuid, &ctrl, rr.id(), &ip_b);
                    }
`);
  return s;
}, 'rendezvous_server.rs: quota checks + session report');
edit('src/relay_server.rs', (s) => {
  s = once(s, '    sync::atomic::{AtomicUsize, Ordering},\n};',
              '    sync::{\n        atomic::{AtomicBool, AtomicUsize, Ordering},\n        Arc,\n    },\n};');
  s = once(s, 'relay(addr, &mut stream, peer, limiter, id.clone()).await',
              'relay(addr, &mut stream, peer, limiter, id.clone(), rf.uuid.clone()).await');
  s = once(s, 'async fn relay(\n    addr: SocketAddr,\n    stream: &mut impl StreamTrait,\n    peer: &mut Box<dyn StreamTrait>,\n    total_limiter: Limiter,\n    id: String,\n) -> ResultType<()> {\n',
`// پوشش relay: مصرف نشست را هر ۱۰ ثانیه به سرور سهمیه گزارش می‌دهد و در صورت تمام شدن سقف، نشست را قطع می‌کند
async fn relay(
    addr: SocketAddr,
    stream: &mut impl StreamTrait,
    peer: &mut Box<dyn StreamTrait>,
    total_limiter: Limiter,
    id: String,
    uuid: String,
) -> ResultType<()> {
    let counter = Arc::new(AtomicUsize::new(0)); // بیت
    let stop = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    {
        let (counter, stop, done, uuid) = (counter.clone(), stop.clone(), done.clone(), uuid);
        tokio::spawn(async move {
            let mut reported = 0usize;
            loop {
                sleep(10.).await;
                let finished = done.load(Ordering::SeqCst);
                let cur = counter.load(Ordering::Relaxed);
                let delta = (cur - reported) / 8; // بایت
                reported += delta * 8;
                if delta > 0 && crate::quota::report_usage(&uuid, delta as u64).await {
                    stop.store(true, Ordering::SeqCst);
                }
                if finished {
                    break;
                }
            }
        });
    }
    let res = relay_(addr, stream, peer, total_limiter, id, counter, stop).await;
    done.store(true, Ordering::SeqCst);
    res
}

async fn relay_(
    addr: SocketAddr,
    stream: &mut impl StreamTrait,
    peer: &mut Box<dyn StreamTrait>,
    total_limiter: Limiter,
    id: String,
    counter: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
) -> ResultType<()> {
`);
  if (!s.includes('counter.fetch_add')) {
    const n = s.split('                    total += nb;\n').length - 1;
    if (n !== 2) throw new Error(`expected 2 'total += nb', found ${n}`);
    s = s.split('                    total += nb;\n').join('                    total += nb;\n                    counter.fetch_add(nb, Ordering::Relaxed);\n');
  }
  s = once(s, '    loop {\n        tokio::select! {\n            res = peer.recv() => {',
              '    loop {\n        if stop.load(Ordering::SeqCst) {\n            bail!("traffic quota exceeded");\n        }\n        tokio::select! {\n            res = peer.recv() => {');
  return s;
}, 'relay_server.rs: usage metering + cut-off');

if (failed) { console.error(`\n${failed} step(s) failed.`); process.exit(1); }
console.log('\nDone.');
