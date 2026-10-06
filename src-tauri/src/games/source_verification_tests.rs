use super::*;

#[test]
fn cancellations_are_bound_and_win_before_or_after_start() {
    let mut state = State::default(); let now = Instant::now();
    state.cancel("one", "first", now);
    assert!(matches!(state.reserve("one", "first", now), Err("source_verify_canceled")));
    let token = state.reserve("one", "second", now).unwrap();
    assert!(matches!(state.reserve("two", "third", now), Err("source_verify_busy")));
    state.cancel("two", "second", now);
    assert!(!token.is_cancelled()); assert!(matches(&state.active, "one", "second"));
    state.cancel("one", "second", now); assert!(token.is_cancelled());
    let newer = state.reserve("two", "third", now).unwrap();
    state.cancel("one", "second", now); assert!(!newer.is_cancelled());
    assert!(matches(&state.active, "two", "third"));
    assert_ne!(label("one", "same"), label("two", "same"));
}

#[test]
fn cancellation_history_is_bounded_and_expires() {
    let mut state = State::default(); let now = Instant::now();
    for i in 0..100 { state.cancel("one", &i.to_string(), now); }
    assert_eq!(state.canceled.len(), 32);
    assert!(state.reserve("one", "99", now + WAIT).is_ok());
    assert!(state.canceled.is_empty());
}

async fn response(wire: &'static [u8]) -> reqwest::Response {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = server.local_addr().unwrap();
    tokio::spawn(async move { let (mut stream, _) = server.accept().await.unwrap(); let mut request = [0; 2048];
        let _ = stream.read(&mut request).await; let _ = stream.write_all(wire).await; });
    // Loopback exists only in this reader fixture. Production uses DNS-pinned public_http_client.
    crate::http_fetch::http_client_builder().build().unwrap().get(format!("http://{address}/feed")).send().await.unwrap()
}

#[tokio::test]
async fn body_limit_applies_to_declared_and_chunked_responses() {
    let url = policy::source("https://catalog.example/feed").unwrap();
    let declared = response(b"HTTP/1.1 200 OK\r\nContent-Length: 500\r\nConnection: close\r\n\r\nx").await;
    assert!(matches!(read_response(declared, 10, &url).await, Err("source_limit")));
    let chunked = response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n6\r\n123456\r\n6\r\n789012\r\n0\r\n\r\n").await;
    assert!(matches!(read_response(chunked, 10, &url).await, Err("source_limit")));
}

#[tokio::test]
async fn valid_bodies_keep_catalog_headers_and_never_return_cookie_headers() {
    let url = policy::source("https://catalog.example/feed").unwrap();
    let response = response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nSet-Cookie: cf_clearance=secret\r\nX-WP-TotalPages: 5\r\nConnection: close\r\n\r\n{}").await;
    let value = read_response(response, 2, &url).await.unwrap();
    assert_eq!(value.body, "e30="); assert!(value.ok);
    assert_eq!(value.headers.get("x-wp-totalpages").unwrap(), "5");
    assert!(!value.headers.contains_key("set-cookie"));
    assert!(!serde_json::to_string(&value).unwrap().contains("secret"));
}

#[tokio::test]
async fn redirects_are_not_followed_and_absent_grants_do_not_fetch() {
    let response = response(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
    assert_eq!(response.status(), reqwest::StatusCode::FOUND);
    assert!(fetch("unverified-profile".into(), "https://catalog.invalid/feed".into(), 1024).await.unwrap().is_none());
    assert!(fetch("unverified-profile".into(), "http://catalog.example/feed".into(), 1024).await.unwrap().is_none());
    assert!(matches!(fetch("one".into(), "https://catalog.example/feed".into(), policy::MAX_BYTES + 1).await, Err("source_limit")));
}
