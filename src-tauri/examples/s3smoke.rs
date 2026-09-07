//! Headless S3 smoke test against a local moto server:
//! `cargo run --example s3smoke -- <port>`. Exercises build_bucket,
//! list_dir with delimiter, put/get round-trip, rename, and delete.

use remotepal_lib::s3::{build_bucket, list_dir, upload_file, S3Storage};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .expect("usage: s3smoke <port>")
        .parse()
        .expect("bad port");

    let storage = S3Storage {
        id: "smoke".into(),
        name: "smoke".into(),
        endpoint: format!("http://127.0.0.1:{port}"),
        region: "us-east-1".into(),
        bucket: "smoke-bucket".into(),
        access_key: "testing".into(),
        path_style: true,
    };
    let bucket = build_bucket(&storage, "testing", None).expect("build bucket");

    bucket
        .put_object("docs/readme.txt", b"hello from remotepal")
        .await
        .expect("put nested");
    bucket
        .put_object("top.txt", b"top level")
        .await
        .expect("put top");

    let listing = list_dir(&bucket, "").await.expect("list root");
    assert!(
        listing.folders.contains(&"docs/".to_string()),
        "folders: {:?}",
        listing.folders
    );
    assert!(
        listing.objects.iter().any(|o| o.key == "top.txt"),
        "objects: {:?}",
        listing.objects.iter().map(|o| &o.key).collect::<Vec<_>>()
    );

    let nested = list_dir(&bucket, "docs/").await.expect("list docs/");
    assert!(
        nested.objects.iter().any(|o| o.name == "readme.txt"),
        "nested objects missing readme.txt"
    );

    let data = bucket.get_object("docs/readme.txt").await.expect("get");
    assert_eq!(data.bytes().as_ref(), b"hello from remotepal");

    bucket
        .copy_object_internal("top.txt", "renamed.txt")
        .await
        .expect("copy");
    bucket.delete_object("top.txt").await.expect("delete orig");
    let after = list_dir(&bucket, "").await.expect("list after rename");
    assert!(after.objects.iter().any(|o| o.key == "renamed.txt"));
    assert!(!after.objects.iter().any(|o| o.key == "top.txt"));

    bucket.delete_object("renamed.txt").await.expect("cleanup");
    bucket
        .delete_object("docs/readme.txt")
        .await
        .expect("cleanup nested");

    // bucket-level operations (unpinned storages browse all buckets)
    let (region, creds) =
        remotepal_lib::s3::region_creds(&storage, "testing").expect("region");
    let names: Vec<String> = s3::Bucket::list_buckets(region.clone(), creds.clone())
        .await
        .expect("list buckets")
        .bucket_names()
        .collect();
    assert!(
        names.contains(&"smoke-bucket".to_string()),
        "bucket list: {names:?}"
    );
    std::env::set_var("RUST_S3_SKIP_LOCATION_CONSTRAINT", "true");
    let created = s3::Bucket::create_with_path_style(
        "smoke-bucket-2",
        region.clone(),
        creds.clone(),
        s3::BucketConfiguration::default(),
    )
    .await
    .expect("create bucket");
    std::env::remove_var("RUST_S3_SKIP_LOCATION_CONSTRAINT");
    assert!(
        created.success(),
        "create bucket HTTP {}: {}",
        created.response_code,
        created.response_text
    );
    let names: Vec<String> = s3::Bucket::list_buckets(region, creds)
        .await
        .expect("list buckets again")
        .bucket_names()
        .collect();
    assert!(
        names.contains(&"smoke-bucket-2".to_string()),
        "created bucket missing: {names:?}"
    );

    // presigned link contains the bucket and a signature
    let url = bucket
        .presign_get("docs/readme.txt", 3600, None)
        .await
        .expect("presign");
    assert!(
        url.contains("smoke-bucket") && url.contains("X-Amz-Signature"),
        "odd presigned url: {url}"
    );

    // uploads: a small file goes up in one PUT, a big one in parts, and
    // an empty one must not trip over a zero-length body
    let work =
        std::env::temp_dir().join(format!("remotepal-s3smoke-{}", std::process::id()));
    std::fs::create_dir_all(&work).expect("temp dir");
    let big = work.join("big.bin");
    let big_bytes = pseudo_random(20 * 1024 * 1024 + 12_345);
    std::fs::write(&big, &big_bytes).expect("write big");
    let small = work.join("small.txt");
    std::fs::write(&small, b"just a few bytes").expect("write small");
    let empty = work.join("empty.bin");
    std::fs::write(&empty, b"").expect("write empty");

    let n = upload_file(&bucket, &big, "up/big.bin", None)
        .await
        .expect("multipart upload");
    assert_eq!(n, big_bytes.len() as u64);
    let got = bucket.get_object("up/big.bin").await.expect("get big");
    assert_eq!(got.bytes().len(), big_bytes.len(), "big object size");
    assert!(
        got.bytes().as_ref() == big_bytes.as_slice(),
        "big object content"
    );

    upload_file(&bucket, &small, "up/small.txt", None)
        .await
        .expect("small upload");
    let got = bucket.get_object("up/small.txt").await.expect("get small");
    assert_eq!(got.bytes().as_ref(), b"just a few bytes");

    upload_file(&bucket, &empty, "up/empty.bin", None)
        .await
        .expect("empty upload");
    let got = bucket.get_object("up/empty.bin").await.expect("get empty");
    assert!(got.bytes().is_empty());

    let missing = upload_file(&bucket, &work.join("nope.bin"), "up/nope", None).await;
    assert!(missing.is_err(), "missing file must fail");
    let _ = std::fs::remove_dir_all(&work);

    println!("S3 SMOKE OK");
}

/// Deterministic noise so the multipart round-trip checks real content,
/// not zeros.
fn pseudo_random(len: usize) -> Vec<u8> {
    let mut state: u64 = 0x2545_F491_4F6C_DD1D;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}
