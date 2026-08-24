//! S3 browser backend. Storage definitions live in ~/.remotepal/s3.json
//! (metadata only); secret keys go to the OS credential store. Transfers
//! wrap the local file in counting reader/writer adapters that emit
//! `s3-progress` events ({ transferId, done, total }).

use std::io;
use std::pin::Pin;
use std::sync::Mutex;
use std::task::{Context, Poll};

use s3::creds::Credentials;
use s3::{Bucket, Region};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::connections::vault_dir;

pub(crate) const KEYRING_SERVICE: &str = "RemotePal-S3";
const PROGRESS_STEP: u64 = 256 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Storage {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    #[serde(default)]
    pub path_style: bool,
}

#[derive(Default)]
pub struct S3StoreLock(pub Mutex<()>);

fn store_path() -> Result<std::path::PathBuf, String> {
    Ok(vault_dir()?.join("s3.json"))
}

pub(crate) fn load_all() -> Result<Vec<S3Storage>, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("corrupt s3.json: {e}"))
}

pub(crate) fn save_all(list: &[S3Storage]) -> Result<(), String> {
    std::fs::create_dir_all(vault_dir()?).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(store_path()?, text).map_err(|e| e.to_string())
}

pub fn region_creds(
    storage: &S3Storage,
    secret_key: &str,
) -> Result<(Region, Credentials), String> {
    let region = if storage.endpoint.is_empty() {
        storage
            .region
            .parse::<Region>()
            .map_err(|e| format!("bad region: {e}"))?
    } else {
        Region::Custom {
            region: if storage.region.is_empty() {
                "us-east-1".to_string()
            } else {
                storage.region.clone()
            },
            endpoint: storage.endpoint.trim_end_matches('/').to_string(),
        }
    };
    let creds = Credentials::new(
        Some(&storage.access_key),
        Some(secret_key),
        None,
        None,
        None,
    )
    .map_err(|e| e.to_string())?;
    Ok((region, creds))
}

/// Whether the endpoint's host already names the bucket. Providers that
/// give each account its own subdomain (Parspack, some MinIO setups) do
/// this, and virtual-host addressing would then ask for
/// `bucket.bucket.example.net`, which does not resolve.
fn endpoint_names_bucket(endpoint: &str, bucket: &str) -> bool {
    if endpoint.is_empty() || bucket.is_empty() {
        return false;
    }
    let host = endpoint
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    host == bucket || host.starts_with(&format!("{bucket}."))
}

/// Bucket handle for `bucket_name`, or the storage's pinned bucket
/// when None.
pub fn build_bucket(
    storage: &S3Storage,
    secret_key: &str,
    bucket_name: Option<&str>,
) -> Result<Box<Bucket>, String> {
    let name = bucket_name.unwrap_or(&storage.bucket);
    if name.is_empty() {
        return Err("no bucket selected".into());
    }
    let (region, creds) = region_creds(storage, secret_key)?;
    let bucket = Bucket::new(name, region, creds).map_err(|e| e.to_string())?;
    // honour the setting, but also fall into path style when virtual-host
    // addressing would double the bucket into the hostname
    Ok(
        if storage.path_style || endpoint_names_bucket(&storage.endpoint, name) {
            bucket.with_path_style()
        } else {
            bucket
        },
    )
}

/// Add a hint to transport failures, which otherwise surface as a bare
/// "error sending request" with no clue what to change.
pub(crate) fn explain(storage: &S3Storage, err: impl ToString) -> String {
    let msg = err.to_string();
    let unreachable = msg.contains("error sending request")
        || msg.contains("failed to lookup")
        || msg.contains("dns error")
        || msg.contains("ConnectError");
    if unreachable && !storage.path_style {
        format!(
            "{msg}

Could not reach the bucket's host. If your provider's endpoint already includes the bucket or account name, turn on path-style addressing for this storage."
        )
    } else {
        msg
    }
}

fn secret_for(id: &str) -> Result<String, String> {
    crate::secrets::get(KEYRING_SERVICE, id)
        .ok_or_else(|| "cannot read stored secret key".to_string())
}

/// Ids of every saved storage, for secret migration.
pub(crate) fn saved_ids() -> Result<Vec<String>, String> {
    Ok(load_all()?.into_iter().map(|s| s.id).collect())
}

fn storage_for(id: &str) -> Result<(S3Storage, String), String> {
    let storage = load_all()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("no such storage")?;
    let secret = secret_for(&storage.id)?;
    Ok((storage, secret))
}

fn bucket_for(id: &str, bucket_name: Option<&str>) -> Result<Box<Bucket>, String> {
    let (storage, secret) = storage_for(id)?;
    build_bucket(&storage, &secret, bucket_name)
}

#[tauri::command]
pub async fn s3_list_buckets(id: String) -> Result<Vec<String>, String> {
    let (storage, secret) = storage_for(&id)?;
    let (region, creds) = region_creds(&storage, &secret)?;
    let response = Bucket::list_buckets(region, creds)
        .await
        .map_err(|e| explain(&storage, e))?;
    let mut names: Vec<String> = response.bucket_names().collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn s3_create_bucket(id: String, name: String) -> Result<(), String> {
    let (storage, secret) = storage_for(&id)?;
    let (region, creds) = region_creds(&storage, &secret)?;
    // S3 (and moto) reject an explicit us-east-1 LocationConstraint —
    // the default region must be requested with an empty configuration
    if region.to_string() == "us-east-1" {
        std::env::set_var("RUST_S3_SKIP_LOCATION_CONSTRAINT", "true");
    }
    let config = s3::BucketConfiguration::default();
    let result = if storage.path_style {
        Bucket::create_with_path_style(name.trim(), region, creds, config).await
    } else {
        Bucket::create(name.trim(), region, creds, config).await
    };
    std::env::remove_var("RUST_S3_SKIP_LOCATION_CONSTRAINT");
    let response = result.map_err(|e| e.to_string())?;
    if !response.success() {
        return Err(format!(
            "create bucket failed (HTTP {}): {}",
            response.response_code,
            response.response_text.trim()
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn s3_list_storages(lock: State<'_, S3StoreLock>) -> Result<Vec<S3Storage>, String> {
    let _guard = lock.0.lock().unwrap();
    load_all()
}

/// `secret` semantics mirror connection_save: Some(non-empty) stores,
/// None keeps the stored one.
#[tauri::command]
pub fn s3_save_storage(
    lock: State<'_, S3StoreLock>,
    mut storage: S3Storage,
    secret: Option<String>,
) -> Result<S3Storage, String> {
    let _guard = lock.0.lock().unwrap();
    let mut list = load_all()?;
    if storage.id.is_empty() {
        storage.id = uuid::Uuid::new_v4().to_string();
    }
    if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        crate::secrets::set(KEYRING_SERVICE, &storage.id, &secret)
            .map_err(|e| format!("cannot store secret key: {e}"))?;
    }
    match list.iter().position(|s| s.id == storage.id) {
        Some(i) => list[i] = storage.clone(),
        None => list.push(storage.clone()),
    }
    save_all(&list)?;
    Ok(storage)
}

#[tauri::command]
pub fn s3_delete_storage(lock: State<'_, S3StoreLock>, id: String) -> Result<(), String> {
    let _guard = lock.0.lock().unwrap();
    let mut list = load_all()?;
    list.retain(|s| s.id != id);
    save_all(&list)?;
    crate::secrets::delete(KEYRING_SERVICE, &id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Listing {
    pub folders: Vec<String>,
    pub objects: Vec<S3Object>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Object {
    pub key: String,
    pub name: String,
    pub size: u64,
    pub last_modified: String,
}

pub async fn list_dir(bucket: &Bucket, prefix: &str) -> Result<S3Listing, String> {
    let results = bucket
        .list(prefix.to_string(), Some("/".to_string()))
        .await
        .map_err(|e| e.to_string())?;
    let mut folders = Vec::new();
    let mut objects = Vec::new();
    for page in results {
        for cp in page.common_prefixes.unwrap_or_default() {
            folders.push(cp.prefix);
        }
        for obj in page.contents {
            if obj.key == prefix {
                continue; // the "directory marker" object itself
            }
            let name = obj
                .key
                .rsplit('/')
                .next()
                .unwrap_or(&obj.key)
                .to_string();
            objects.push(S3Object {
                key: obj.key,
                name,
                size: obj.size,
                last_modified: obj.last_modified,
            });
        }
    }
    folders.sort();
    objects.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(S3Listing { folders, objects })
}

#[tauri::command]
pub async fn s3_list(id: String, bucket: Option<String>, prefix: String) -> Result<S3Listing, String> {
    let (storage, _) = storage_for(&id)?;
    let handle = bucket_for(&id, bucket.as_deref())?;
    list_dir(&handle, &prefix)
        .await
        .map_err(|e| explain(&storage, e))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    transfer_id: &'a str,
    done: u64,
    total: u64,
}

fn emit_progress(app: &AppHandle, transfer_id: &str, done: u64, total: u64) {
    let _ = app.emit(
        "s3-progress",
        Progress {
            transfer_id,
            done,
            total,
        },
    );
}

/// Wraps an AsyncRead/AsyncWrite and emits progress as bytes move.
struct Counting<T> {
    inner: T,
    app: AppHandle,
    transfer_id: String,
    total: u64,
    done: u64,
    last: u64,
}

impl<T> Counting<T> {
    fn new(inner: T, app: AppHandle, transfer_id: String, total: u64) -> Self {
        Self {
            inner,
            app,
            transfer_id,
            total,
            done: 0,
            last: 0,
        }
    }

    fn bump(&mut self, n: u64) {
        self.done += n;
        if self.done - self.last >= PROGRESS_STEP {
            self.last = self.done;
            emit_progress(
                &self.app,
                &self.transfer_id,
                self.done,
                self.total.max(self.done),
            );
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for Counting<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let me = &mut *self;
        match Pin::new(&mut me.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                let n = (buf.filled().len() - before) as u64;
                me.bump(n);
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Counting<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let me = &mut *self;
        match Pin::new(&mut me.inner).poll_write(cx, buf) {
            Poll::Ready(Ok(n)) => {
                me.bump(n as u64);
                Poll::Ready(Ok(n))
            }
            other => other,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[tauri::command]
pub async fn s3_upload(
    app: AppHandle,
    id: String,
    bucket: Option<String>,
    local_path: String,
    key: String,
    transfer_id: String,
) -> Result<u64, String> {
    let bucket = bucket_for(&id, bucket.as_deref())?;
    let meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("directories cannot be uploaded — drop files instead".into());
    }
    let file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut reader = Counting::new(file, app.clone(), transfer_id.clone(), meta.len());
    bucket
        .put_object_stream(&mut reader, &key)
        .await
        .map_err(|e| e.to_string())?;
    emit_progress(&app, &transfer_id, meta.len(), meta.len());
    Ok(meta.len())
}

#[tauri::command]
pub async fn s3_download(
    app: AppHandle,
    id: String,
    bucket: Option<String>,
    key: String,
    local_path: String,
    transfer_id: String,
) -> Result<u64, String> {
    let bucket = bucket_for(&id, bucket.as_deref())?;
    let total = bucket
        .head_object(&key)
        .await
        .ok()
        .and_then(|(h, _)| h.content_length)
        .unwrap_or(0)
        .max(0) as u64;
    let file = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut writer = Counting::new(file, app.clone(), transfer_id.clone(), total);
    bucket
        .get_object_to_writer(&key, &mut writer)
        .await
        .map_err(|e| e.to_string())?;
    let done = writer.done;
    emit_progress(&app, &transfer_id, done, done);
    Ok(done)
}

/// Delete one object, or everything under a prefix when `is_prefix`.
#[tauri::command]
pub async fn s3_delete(id: String, bucket: Option<String>, key: String, is_prefix: bool) -> Result<(), String> {
    let bucket = bucket_for(&id, bucket.as_deref())?;
    if is_prefix {
        let pages = bucket
            .list(key.clone(), None)
            .await
            .map_err(|e| e.to_string())?;
        for page in pages {
            for obj in page.contents {
                bucket
                    .delete_object(&obj.key)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    } else {
        bucket
            .delete_object(&key)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub async fn s3_rename(id: String, bucket: Option<String>, from: String, to: String) -> Result<(), String> {
    let bucket = bucket_for(&id, bucket.as_deref())?;
    bucket
        .copy_object_internal(&from, &to)
        .await
        .map_err(|e| e.to_string())?;
    bucket
        .delete_object(&from)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy (or move) objects and prefixes into `dest_prefix`. S3 copies
/// server-side, so nothing travels via this machine. A prefix source
/// ends in `/` and is walked; the folder name is kept at the
/// destination.
#[tauri::command]
pub async fn s3_copy(
    id: String,
    bucket: Option<String>,
    sources: Vec<String>,
    dest_prefix: String,
    move_items: bool,
) -> Result<u32, String> {
    let bucket = bucket_for(&id, bucket.as_deref())?;
    let mut copied = 0u32;

    for src in &sources {
        if src.ends_with('/') {
            // pasting a folder inside itself would nest forever
            if dest_prefix.starts_with(src.as_str()) {
                return Err(format!("cannot copy {src} into itself"));
            }
            let base = src.trim_end_matches('/');
            let name = base.rsplit('/').next().unwrap_or(base);
            let pages = bucket
                .list(src.clone(), None)
                .await
                .map_err(|e| e.to_string())?;
            for page in pages {
                for obj in page.contents {
                    let rel = obj.key.strip_prefix(src.as_str()).unwrap_or(&obj.key);
                    let to = format!("{dest_prefix}{name}/{rel}");
                    if to == obj.key {
                        continue;
                    }
                    bucket
                        .copy_object_internal(&obj.key, &to)
                        .await
                        .map_err(|e| e.to_string())?;
                    if move_items {
                        bucket
                            .delete_object(&obj.key)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    copied += 1;
                }
            }
        } else {
            let name = src.rsplit('/').next().unwrap_or(src);
            let to = format!("{dest_prefix}{name}");
            if &to == src {
                continue; // already here
            }
            bucket
                .copy_object_internal(src, &to)
                .await
                .map_err(|e| e.to_string())?;
            if move_items {
                bucket
                    .delete_object(src)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            copied += 1;
        }
    }
    Ok(copied)
}

/// Pack objects into one .tar.gz and put it back in the bucket.
///
/// Unlike the SFTP equivalent this cannot happen server-side — S3 has no
/// notion of compressing objects — so the data is pulled down, packed in
/// a temp directory and pushed back. That costs bandwidth both ways, so
/// the UI warns before starting.
#[tauri::command]
pub async fn s3_archive(
    id: String,
    bucket: Option<String>,
    sources: Vec<String>,
    dest_prefix: String,
    archive: String,
) -> Result<String, String> {
    if sources.is_empty() {
        return Err("nothing selected".to_string());
    }
    let b = bucket_for(&id, bucket.as_deref())?;

    let work = std::env::temp_dir().join(format!("remotepal-zip-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;

    // clean the temp tree up whichever way this ends
    let result = build_archive(&b, &sources, &work, &archive).await;
    let packed = match result {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&work);
            return Err(e);
        }
    };

    let key = format!("{dest_prefix}{archive}.tar.gz");
    let upload = async {
        let mut file = tokio::fs::File::open(&packed)
            .await
            .map_err(|e| e.to_string())?;
        b.put_object_stream(&mut file, &key)
            .await
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }
    .await;
    let _ = std::fs::remove_dir_all(&work);
    upload?;
    Ok(key)
}

/// Download every source into `work` and tar.gz it. Split out so the
/// caller can always remove the temp tree.
async fn build_archive(
    b: &Bucket,
    sources: &[String],
    work: &std::path::Path,
    archive: &str,
) -> Result<std::path::PathBuf, String> {
    let staged = work.join("staged");
    std::fs::create_dir_all(&staged).map_err(|e| e.to_string())?;

    // keys to fetch, with the path each should take inside the archive
    let mut wanted: Vec<(String, String)> = Vec::new();
    for src in sources {
        if src.ends_with('/') {
            let base = src.trim_end_matches('/');
            let folder = base.rsplit('/').next().unwrap_or(base).to_string();
            let pages = b.list(src.clone(), None).await.map_err(|e| e.to_string())?;
            for page in pages {
                for obj in page.contents {
                    let rel = obj.key.strip_prefix(src.as_str()).unwrap_or(&obj.key);
                    wanted.push((obj.key.clone(), format!("{folder}/{rel}")));
                }
            }
        } else {
            let name = src.rsplit('/').next().unwrap_or(src).to_string();
            wanted.push((src.clone(), name));
        }
    }
    if wanted.is_empty() {
        return Err("nothing to archive".to_string());
    }

    for (key, rel) in &wanted {
        let target = staged.join(rel);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let mut file = tokio::fs::File::create(&target)
            .await
            .map_err(|e| e.to_string())?;
        b.get_object_to_writer(key, &mut file)
            .await
            .map_err(|e| format!("{key}: {e}"))?;
    }

    let out = work.join(format!("{archive}.tar.gz"));
    let file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
    let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut builder = tar::Builder::new(enc);
    for (_, rel) in &wanted {
        builder
            .append_path_with_name(staged.join(rel), rel)
            .map_err(|e| e.to_string())?;
    }
    builder
        .into_inner()
        .map_err(|e| e.to_string())?
        .finish()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

// ---------------------------------------------------- presigned links

#[tauri::command]
pub async fn s3_presign(
    id: String,
    bucket: Option<String>,
    key: String,
    expiry_secs: u32,
) -> Result<String, String> {
    let bucket = bucket_for(&id, bucket.as_deref())?;
    bucket
        .presign_get(&key, expiry_secs, None)
        .await
        .map_err(|e| e.to_string())
}

// ------------------------------------------------------- folder sync

/// "2026-08-21T12:34:56.000Z" -> unix epoch (days-from-civil).
pub(crate) fn rfc3339_epoch(s: &str) -> i64 {
    if s.len() < 19 {
        return 0;
    }
    let num = |r: std::ops::Range<usize>| s[r].parse::<i64>().unwrap_or(0);
    let (y, m, d) = (num(0..4), num(5..7), num(8..10));
    let (hh, mm, ss) = (num(11..13), num(14..16), num(17..19));
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    days * 86400 + hh * 3600 + mm * 60 + ss
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncSummary {
    uploaded: usize,
    deleted: usize,
    skipped: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncProgress<'a> {
    transfer_id: &'a str,
    current: &'a str,
    index: usize,
    total: usize,
}

/// Push-sync a local directory into an S3 prefix, same plan as the
/// SFTP sync: upload missing/changed (size differs or local mtime
/// newer +1s), optionally delete remote extras.
#[tauri::command]
pub async fn s3_sync(
    app: AppHandle,
    id: String,
    bucket: Option<String>,
    local_dir: String,
    prefix: String,
    delete_extra: bool,
    transfer_id: String,
) -> Result<S3SyncSummary, String> {
    let bucket = bucket_for(&id, bucket.as_deref())?;
    let local_root = std::path::PathBuf::from(&local_dir);
    if !local_root.is_dir() {
        return Err(format!("{local_dir} is not a directory"));
    }
    let local = crate::sftp::collect_local(&local_root)?;

    let mut remote = crate::sftp::FileMap::new();
    let pages = bucket
        .list(prefix.clone(), None)
        .await
        .map_err(|e| e.to_string())?;
    for page in pages {
        for obj in page.contents {
            let rel = obj.key[prefix.len()..].to_string();
            if rel.is_empty() || rel.ends_with('/') {
                continue;
            }
            remote.insert(rel, (obj.size, rfc3339_epoch(&obj.last_modified)));
        }
    }

    let to_copy = crate::sftp::plan_copies(&local, &remote);
    let total = to_copy.len();
    for (index, rel) in to_copy.iter().enumerate() {
        let _ = app.emit(
            "sync-progress",
            SyncProgress {
                transfer_id: &transfer_id,
                current: rel,
                index,
                total,
            },
        );
        let local_path = local_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let mut file = tokio::fs::File::open(&local_path)
            .await
            .map_err(|e| e.to_string())?;
        bucket
            .put_object_stream(&mut file, format!("{prefix}{rel}"))
            .await
            .map_err(|e| format!("{rel}: {e}"))?;
    }

    let mut deleted = 0;
    if delete_extra {
        let mut extras: Vec<&String> = remote
            .keys()
            .filter(|rel| !local.contains_key(*rel))
            .collect();
        extras.sort();
        for rel in extras {
            bucket
                .delete_object(format!("{prefix}{rel}"))
                .await
                .map_err(|e| format!("delete {rel}: {e}"))?;
            deleted += 1;
        }
    }

    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            transfer_id: &transfer_id,
            current: "done",
            index: total,
            total,
        },
    );
    Ok(S3SyncSummary {
        uploaded: total,
        deleted,
        skipped: local.len() - total,
    })
}

// ------------------------------------------------------ edit-on-save

/// Live edit-on-save watchers for S3 objects, keyed by storage id.
#[derive(Default)]
pub struct S3EditState(pub Mutex<Vec<notify::RecommendedWatcher>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct S3EditEvent {
    storage_id: String,
    name: String,
    message: Option<String>,
}

/// Download the object to a temp dir, open it in the default local
/// app, and re-upload (debounced) every time it changes on disk.
#[tauri::command]
pub async fn s3_edit(
    app: AppHandle,
    edits: State<'_, S3EditState>,
    id: String,
    bucket: Option<String>,
    key: String,
) -> Result<String, String> {
    use notify::Watcher;

    let bucket_handle = bucket_for(&id, bucket.as_deref())?;
    let name = key.rsplit('/').next().unwrap_or("object").to_string();
    let dir = std::env::temp_dir().join("remotepal-s3-edit").join(&id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let local = dir.join(&name);
    let mut file = tokio::fs::File::create(&local)
        .await
        .map_err(|e| e.to_string())?;
    bucket_handle
        .get_object_to_writer(&key, &mut file)
        .await
        .map_err(|e| e.to_string())?;
    drop(file);

    tauri_plugin_opener::open_path(&local, None::<&str>)
        .map_err(|e| format!("cannot open editor: {e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let watch_name = name.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let relevant = matches!(
                event.kind,
                notify::EventKind::Modify(_) | notify::EventKind::Create(_)
            ) && event
                .paths
                .iter()
                .any(|p| p.file_name().is_some_and(|f| f == watch_name.as_str()));
            if relevant {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, notify::RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let event_name = name.clone();
    let storage_id = id.clone();
    let local_path = local.clone();
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            while let Ok(Some(_)) =
                tokio::time::timeout(std::time::Duration::from_millis(400), rx.recv()).await
            {}
            let result = match tokio::fs::File::open(&local_path).await {
                Ok(mut file) => bucket_handle
                    .put_object_stream(&mut file, &key)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            };
            let (event, message) = match result {
                Ok(()) => ("s3-edit-uploaded", None),
                Err(e) => ("s3-edit-error", Some(e)),
            };
            let _ = app.emit(
                event,
                S3EditEvent {
                    storage_id: storage_id.clone(),
                    name: event_name.clone(),
                    message,
                },
            );
        }
    });

    edits.0.lock().unwrap().push(watcher);
    Ok(local.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_already_naming_the_bucket_is_detected() {
        // the case from the field: the account subdomain is the bucket, so
        // virtual-host addressing asked for c280148.c280148.parspack.net
        assert!(endpoint_names_bucket(
            "https://c280148.parspack.net",
            "c280148"
        ));
        // bare host, no scheme, and with a port
        assert!(endpoint_names_bucket("c280148.parspack.net", "c280148"));
        assert!(endpoint_names_bucket("http://data.local:9000", "data"));
        // the endpoint being exactly the bucket counts too
        assert!(endpoint_names_bucket("https://c280148", "c280148"));

        // ordinary providers keep virtual-host addressing
        assert!(!endpoint_names_bucket("https://s3.amazonaws.com", "photos"));
        assert!(!endpoint_names_bucket("https://minio.local:9000", "backups"));
        // a prefix match must not count: "datastore." is not "data."
        assert!(!endpoint_names_bucket("https://datastore.example.net", "data"));
        assert!(!endpoint_names_bucket("", "data"));
    }

    #[test]
    fn rfc3339_epoch_matches_known_values() {
        assert_eq!(rfc3339_epoch("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(rfc3339_epoch("2000-01-01T00:00:00Z"), 946_684_800);
        assert_eq!(rfc3339_epoch("2026-08-21T12:34:56.789Z"), 1_787_315_696);
        assert_eq!(rfc3339_epoch("bogus"), 0);
    }
}
