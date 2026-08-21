//! Headless S3 smoke test against a local moto server:
//! `cargo run --example s3smoke -- <port>`. Exercises build_bucket,
//! list_dir with delimiter, put/get round-trip, rename, and delete.

use remotepal_lib::s3::{build_bucket, list_dir, S3Storage};

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
    let bucket = build_bucket(&storage, "testing").expect("build bucket");

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
    println!("S3 SMOKE OK");
}
