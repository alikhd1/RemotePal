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

pub fn build_bucket(storage: &S3Storage, secret_key: &str) -> Result<Box<Bucket>, String> {
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
    let bucket = Bucket::new(&storage.bucket, region, creds).map_err(|e| e.to_string())?;
    Ok(if storage.path_style {
        bucket.with_path_style()
    } else {
        bucket
    })
}

fn secret_for(id: &str) -> Result<String, String> {
    keyring::Entry::new(KEYRING_SERVICE, id)
        .and_then(|e| e.get_password())
        .map_err(|e| format!("cannot read stored secret key: {e}"))
}

fn bucket_for(id: &str) -> Result<Box<Bucket>, String> {
    let storage = load_all()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("no such storage")?;
    let secret = secret_for(&storage.id)?;
    build_bucket(&storage, &secret)
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
        keyring::Entry::new(KEYRING_SERVICE, &storage.id)
            .and_then(|e| e.set_password(&secret))
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
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &id) {
        let _ = entry.delete_credential();
    }
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
pub async fn s3_list(id: String, prefix: String) -> Result<S3Listing, String> {
    let bucket = bucket_for(&id)?;
    list_dir(&bucket, &prefix).await
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
    local_path: String,
    key: String,
    transfer_id: String,
) -> Result<u64, String> {
    let bucket = bucket_for(&id)?;
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
    key: String,
    local_path: String,
    transfer_id: String,
) -> Result<u64, String> {
    let bucket = bucket_for(&id)?;
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
pub async fn s3_delete(id: String, key: String, is_prefix: bool) -> Result<(), String> {
    let bucket = bucket_for(&id)?;
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
pub async fn s3_rename(id: String, from: String, to: String) -> Result<(), String> {
    let bucket = bucket_for(&id)?;
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
