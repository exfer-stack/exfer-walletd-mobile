//! In-app CPU miner — lets the wallet agent self-fund by mining EXFER on the
//! device itself. iOS/Android sandboxes forbid downloading and exec'ing a
//! binary (the desktop path) and forbid spawning child processes, so mining has
//! to run IN-PROCESS. It does: this module drives the same Argon2id PoW +
//! stratum loop as `exfer-agent-miner`, but as a controllable handle
//! (start/stop/status) living in Tauri state, using only pure-Rust crates that
//! cross-compile to aarch64/armv7 Android (exfer-pow = Argon2id; exfer-stratum
//! = rustls TLS). No subprocess, no downloaded binary, GPU/CUDA off.
//!
//! Defaults to the SOLO pool: at EXFER's tiny network hashrate a wallet-scale
//! miner never reaches a shared pool's payout threshold, but solo pays the full
//! block reward straight to the address whenever a worker finds a block.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use exfer_pow::{compute_pow, BlockHeader};
use exfer_stratum::client::{connect_with_retry, StratumClient, StratumEvent};
use exfer_stratum::job::{Job, ShareSubmission};
use exfer_stratum::messages::NotifyParams;
use serde::Serialize;
use tauri::State;
use tokio::sync::{mpsc, watch};

/// Default payout target: the SOLO pool's TLS port (ninjaraider exfer-solo;
/// tcp :44914 / ssl :44915, mirroring exfer-pplns tcp :44912 / ssl :44913).
const DEFAULT_SOLO_POOL: &str = "ssl://ninjaraider.com:44915";
/// Argon2id is memory-hard (~64 MiB per concurrent hash), so cap CPU threads —
/// a phone with a handful of threads at 64 MiB each would OOM.
const MAX_THREADS: usize = 4;
const USER_AGENT: &str = "exfer-wallet-miner/1.0";

#[derive(Default)]
struct Stats {
    hashes: AtomicU64,
    jobs: AtomicU64,
    submitted: AtomicU64,
    accepted: AtomicU64,
    rejected: AtomicU64,
    authorized: AtomicBool,
    /// Most recent observed hashrate, as H/s * 100 (avoids a float atomic).
    hashrate_centi: AtomicU64,
}

/// A live mining run owned by the managed `MinerCtx`.
struct Running {
    stop: Arc<AtomicBool>,
    stats: Arc<Stats>,
    task: tauri::async_runtime::JoinHandle<()>,
    pool: String,
    address: String,
    threads: usize,
    started: Instant,
}

/// Managed Tauri state: at most one mining run at a time.
#[derive(Default)]
pub struct MinerCtx {
    inner: Arc<Mutex<Option<Running>>>,
}

impl MinerCtx {
    pub fn new() -> Self {
        Self::default()
    }
}

/// The status the UI / agent reads. `running=false` => a fresh, zeroed snapshot.
#[derive(Serialize)]
pub struct MineStatus {
    running: bool,
    pool: Option<String>,
    address: Option<String>,
    threads: usize,
    hashrate_hs: f64,
    authorized: bool,
    jobs: u64,
    submitted: u64,
    accepted: u64,
    rejected: u64,
    uptime_seconds: u64,
}

fn snapshot(inner: &Option<Running>) -> MineStatus {
    match inner {
        Some(r) => MineStatus {
            running: true,
            pool: Some(r.pool.clone()),
            address: Some(r.address.clone()),
            threads: r.threads,
            hashrate_hs: r.stats.hashrate_centi.load(Ordering::Relaxed) as f64 / 100.0,
            authorized: r.stats.authorized.load(Ordering::Relaxed),
            jobs: r.stats.jobs.load(Ordering::Relaxed),
            submitted: r.stats.submitted.load(Ordering::Relaxed),
            accepted: r.stats.accepted.load(Ordering::Relaxed),
            rejected: r.stats.rejected.load(Ordering::Relaxed),
            uptime_seconds: r.started.elapsed().as_secs(),
        },
        None => MineStatus {
            running: false,
            pool: None,
            address: None,
            threads: 0,
            hashrate_hs: 0.0,
            authorized: false,
            jobs: 0,
            submitted: 0,
            accepted: 0,
            rejected: 0,
            uptime_seconds: 0,
        },
    }
}

fn parse_pool(raw: &str) -> Result<(String, u16), String> {
    let rest = raw
        .strip_prefix("ssl://")
        .or_else(|| raw.strip_prefix("tcp://"))
        .or_else(|| raw.strip_prefix("stratum+ssl://"))
        .or_else(|| raw.strip_prefix("stratum+tcp://"))
        .unwrap_or(raw);
    let (h, p) = rest.rsplit_once(':').ok_or_else(|| format!("pool url missing port: {raw}"))?;
    let port: u16 = p.parse().map_err(|_| format!("bad pool port: {p}"))?;
    Ok((h.to_string(), port))
}

/// Start mining `address` against `pool` (default: the solo pool) with
/// `threads` CPU workers (default 1, capped at MAX_THREADS). Errors if already
/// mining — call `mine_stop` first.
#[tauri::command]
pub async fn mine_start(
    miner: State<'_, MinerCtx>,
    pool: Option<String>,
    address: String,
    threads: Option<usize>,
) -> Result<MineStatus, String> {
    let addr = address.trim().to_lowercase();
    if addr.len() != 64 || !addr.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("address must be 64 hex chars — generate one with exfer_generate_address".into());
    }
    let pool = pool.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).unwrap_or_else(|| DEFAULT_SOLO_POOL.to_string());
    let (host, port) = parse_pool(&pool)?;
    let threads = threads.unwrap_or(1).clamp(1, MAX_THREADS);

    let mut guard = miner.inner.lock().map_err(|_| "miner lock poisoned".to_string())?;
    if guard.is_some() {
        return Err("already mining — call mine_stop first".into());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stats = Arc::new(Stats::default());
    let username = format!("{addr}.agent");
    let task = {
        let stop = stop.clone();
        let stats = stats.clone();
        let host = host.clone();
        let user = username.clone();
        tauri::async_runtime::spawn(async move {
            run(host, port, user, threads, stats, stop).await;
        })
    };

    *guard = Some(Running {
        stop,
        stats,
        task,
        pool,
        address: addr,
        threads,
        started: Instant::now(),
    });
    Ok(snapshot(&guard))
}

/// Stop the current run (idempotent — fine to call when not mining).
#[tauri::command]
pub async fn mine_stop(miner: State<'_, MinerCtx>) -> Result<MineStatus, String> {
    let mut guard = miner.inner.lock().map_err(|_| "miner lock poisoned".to_string())?;
    if let Some(r) = guard.take() {
        r.stop.store(true, Ordering::Relaxed);
        r.task.abort();
    }
    Ok(snapshot(&guard))
}

/// Current mining status (hashrate, shares, authorization).
#[tauri::command]
pub async fn mine_status(miner: State<'_, MinerCtx>) -> Result<MineStatus, String> {
    let guard = miner.inner.lock().map_err(|_| "miner lock poisoned".to_string())?;
    Ok(snapshot(&guard))
}

/// The stratum event loop: connect (reconnecting on drop), turn pool jobs into
/// work for the CPU workers, forward found shares back. Returns when `stop` is
/// set (the spawning task is also `abort()`ed by mine_stop so a mid-retry
/// connect cannot strand the loop).
async fn run(host: String, port: u16, username: String, cpu_threads: usize, stats: Arc<Stats>, stop: Arc<AtomicBool>) {
    let (job_tx, job_rx) = watch::channel::<Option<Arc<Job>>>(None);
    let (share_tx, mut share_rx) = mpsc::unbounded_channel::<ShareSubmission>();

    let total_workers = cpu_threads as u32;
    for slot in 0..total_workers {
        let job_rx = job_rx.clone();
        let share_tx = share_tx.clone();
        let stats = stats.clone();
        let stop = stop.clone();
        let user = username.clone();
        std::thread::spawn(move || cpu_worker(slot, total_workers, job_rx, share_tx, user, stats, stop));
    }

    let mut submit_id: u64 = 0;
    let mut last_hashes: u64 = 0;
    let mut last_tick = Instant::now();
    let mut ticker = tokio::time::interval(Duration::from_secs(5));

    while !stop.load(Ordering::Relaxed) {
        let mut client: StratumClient =
            connect_with_retry(&host, port, &username, USER_AGENT, Duration::from_secs(1), Duration::from_secs(30)).await;
        let mut diff = 1.0_f64;
        let mut diff_established = false;
        let mut ext1: Vec<u8> = Vec::new();
        let mut latest: Option<NotifyParams> = None;

        let reconnect = loop {
            tokio::select! {
                ev = client.events.recv() => match ev {
                    Some(StratumEvent::Connected { extranonce1, .. }) => ext1 = extranonce1,
                    Some(StratumEvent::Authorized { ok }) => stats.authorized.store(ok, Ordering::Relaxed),
                    Some(StratumEvent::Difficulty(d)) => {
                        diff = d;
                        diff_established = true;
                        if let Some(n) = latest.as_ref() {
                            let _ = job_tx.send(Some(Arc::new(Job::from_notify(n, d, &ext1))));
                        }
                    }
                    Some(StratumEvent::Notify(n)) => {
                        stats.jobs.fetch_add(1, Ordering::Relaxed);
                        // Only mine once the share target is real (a per-job
                        // override or an applied difficulty); the default diff=1
                        // target is all-0xFF and every hash would submit garbage.
                        if diff_established || n.share_target_override.is_some() {
                            let _ = job_tx.send(Some(Arc::new(Job::from_notify(&n, diff, &ext1))));
                        }
                        latest = Some(n);
                    }
                    Some(StratumEvent::SubmitResult { accepted, .. }) => {
                        if accepted {
                            stats.accepted.fetch_add(1, Ordering::Relaxed);
                        } else {
                            stats.rejected.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Some(StratumEvent::Disconnected(_)) => break true,
                    None => break true,
                },
                Some(share) = share_rx.recv() => {
                    submit_id += 1;
                    stats.submitted.fetch_add(1, Ordering::Relaxed);
                    let _ = client.submit(submit_id, &username, share);
                }
                _ = ticker.tick() => {
                    let now = Instant::now();
                    let h = stats.hashes.load(Ordering::Relaxed);
                    let hps = (h.saturating_sub(last_hashes)) as f64 / now.duration_since(last_tick).as_secs_f64().max(0.001);
                    last_hashes = h;
                    last_tick = now;
                    stats.hashrate_centi.store((hps * 100.0).round() as u64, Ordering::Relaxed);
                }
            }
            if stop.load(Ordering::Relaxed) {
                break false;
            }
        };
        if !reconnect {
            break;
        }
    }
    stop.store(true, Ordering::Relaxed);
}

/// One CPU worker: own a slice of the extranonce2 space, hash candidate headers
/// against the pool's share target, forward any hit. Exits when `stop` is set.
fn cpu_worker(
    slot: u32,
    total: u32,
    mut job_rx: watch::Receiver<Option<Arc<Job>>>,
    share_tx: mpsc::UnboundedSender<ShareSubmission>,
    username: String,
    stats: Arc<Stats>,
    stop: Arc<AtomicBool>,
) {
    let mut cur: Option<Arc<Job>> = None;
    let range = u32::MAX / total.max(1);
    let mut ext2: u32 = slot.wrapping_mul(range);
    let end_initial: u32 = ext2.wrapping_add(range);

    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let new_job = job_rx.borrow_and_update().clone();
        let job_changed = match (&cur, &new_job) {
            (None, Some(_)) => true,
            (Some(a), Some(b)) => !Arc::ptr_eq(a, b) && a.job_id != b.job_id,
            _ => false,
        };
        if job_changed {
            ext2 = slot.wrapping_mul(range);
        }
        cur = new_job;
        let Some(job) = cur.clone() else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };

        for _ in 0..32 {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            if job_rx.has_changed().unwrap_or(false) {
                break;
            }
            let header_bytes = job.assemble_header_with_ext2(ext2);
            let header = BlockHeader::deserialize(&header_bytes);
            let pow = compute_pow(&header);
            stats.hashes.fetch_add(1, Ordering::Relaxed);
            if pow.as_slice() < job.share_target.as_slice() {
                let share = ShareSubmission::from_winning_header(&job.job_id, &username, &header_bytes, job.nonce_offset);
                let _ = share_tx.send(share);
            }
            ext2 = ext2.wrapping_add(1);
            if ext2 == end_initial {
                ext2 = slot.wrapping_mul(range);
            }
        }
    }
}
