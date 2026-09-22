//! M1 acceptance: prove a large MCP request reaches the fixture stdio server
//! byte-for-byte unchanged through the real transport stack.
//!
//! Transport path under test: [`RmcpClient`] with default protocol handling
//! (via [`RmcpClient::new_stdio_client`], which selects the default legacy
//! stdio policy — no lenient/experimental mode is forced) -> real
//! child-process stdio transport -> `test_stdio_server` `echo` tool ->
//! structured `{"echo": "ECHOING: {message}", ...}` result. Nothing is
//! mocked: every byte crosses the real JSON-RPC pipes in both directions.
//!
//! Byte-equivalence proof: each round-trip test asserts full string equality
//! between the sent message and the echoed message, plus a sha256 comparison
//! of both sides (digests are printed for the log).

use std::sync::Arc;
use std::time::Duration;

use codex_rmcp_client::ElicitationAction;
use codex_rmcp_client::ElicitationResponse;
use codex_rmcp_client::LocalStdioServerLauncher;
use codex_rmcp_client::RmcpClient;
use futures::FutureExt;
use pretty_assertions::assert_eq;
use rmcp::model::ClientCapabilities;
use rmcp::model::Implementation;
use rmcp::model::InitializeRequestParams;
use rmcp::model::ProtocolVersion;
use sha2::Digest;
use sha2::Sha256;

const ONE_MIB: usize = 1024 * 1024;
const TWENTY_FIVE_MIB: usize = 25 * 1024 * 1024;

/// Unicode trailer appended (inside the JSON body, outside the filler) so the
/// payload exercises multi-byte UTF-8 across the transport. Fixed content, so
/// exact byte sizing stays deterministic.
const UNICODE_TRAILER: &str = "日本語テスト🎉🔥✓✓-العربية-עברית-éèü-✓-日本語-🎉";

/// Build a Confluence-shaped JSON document (page metadata, nested
/// sections/table/items maps and arrays, unicode text, no credentials)
/// serialized to exactly `target_bytes` bytes.
///
/// Exact sizing comes from a single ASCII `filler` field: every `x` adds
/// exactly one byte to the serialized form (no JSON escaping applies), so
/// `filler_len = target_bytes - serialized_len_with_empty_filler`.
fn confluence_shaped_message(target_bytes: usize) -> String {
    let mut value = serde_json::json!({
        "pageId": "CONF-99999",
        "spaceKey": "SYNTH",
        "title": "Synthetic transport probe — 検証ページ 🎉",
        "status": "current",
        "version": {
            "number": 7,
            "minorEdit": true,
            "message": "probe révision ✓"
        },
        "body": {
            "storage": {
                "representation": "storage",
                "sections": [
                    {
                        "heading": "概要 🎉",
                        "paragraphs": [
                            "First paragraph with unicode: 日本語テスト ✓.",
                            "Second paragraph: العربية ועברית mélangé 🔥."
                        ],
                        "table": {
                            "rows": [
                                [{"cell": "a1 ✓"}, {"cell": "b1 🎉"}],
                                [{"cell": "a2 日本語"}, {"cell": "b2 🔥"}]
                            ]
                        }
                    },
                    {
                        "heading": "Details",
                        "items": [1, 2, 3, {"nested": ["x", "y✓", {"deep": "🎉"}]}]
                    }
                ]
            }
        },
        "labels": ["probe", "transport✓", "日本語"],
        "note": "Synthetic fixture. Contains no credentials; any token-like value is REDACTED.",
        "filler": "",
        "unicode_trailer": UNICODE_TRAILER,
    });
    let base_len = serde_json::to_string(&value)
        .expect("confluence-shaped fixture serializes")
        .len();
    assert!(
        target_bytes > base_len,
        "target {target_bytes} must exceed fixture base size {base_len}"
    );
    let filler_len = target_bytes - base_len;
    value["filler"] = serde_json::Value::String("x".repeat(filler_len));
    let message = serde_json::to_string(&value).expect("confluence-shaped fixture serializes");
    assert_eq!(message.len(), target_bytes);
    message
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

async fn spawn_client(implementation_name: &'static str) -> anyhow::Result<RmcpClient> {
    let server = codex_utils_cargo_bin::cargo_bin("test_stdio_server")?;
    let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
    let client = RmcpClient::new_stdio_client(
        server.into(),
        Vec::new(),
        /*env*/ None,
        &[],
        Some(cwd),
        Arc::new(LocalStdioServerLauncher::new(std::env::current_dir()?)),
    )
    .await?;
    client
        .initialize(
            InitializeRequestParams::new(
                ClientCapabilities::default(),
                Implementation::new(implementation_name, "1.0.0"),
            )
            .with_protocol_version(ProtocolVersion::V_2025_06_18),
            Some(Duration::from_secs(30)),
            Box::new(|_, _| {
                async {
                    Ok(ElicitationResponse {
                        action: ElicitationAction::Decline,
                        content: None,
                        meta: None,
                    })
                }
                .boxed()
            }),
        )
        .await?;
    Ok(client)
}

/// Invoke the fixture `echo` tool and return the structured `echo` text.
async fn call_echo(
    client: &RmcpClient,
    message: &str,
    timeout: Duration,
) -> anyhow::Result<String> {
    let result = client
        .call_tool(
            "echo".to_string(),
            Some(serde_json::json!({"message": message})),
            /*meta*/ None,
            Some(timeout),
        )
        .await?;
    let echo = result
        .structured_content
        .as_ref()
        .and_then(|value| value.get("echo"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("echo tool returned no structured echo text"))?
        .to_owned();
    Ok(echo)
}

/// Assert a message round-trips byte-for-byte: full string equality plus an
/// independent sha256 comparison. `expected_prefix` is the server's fixed
/// "ECHOING: " prefix, asserted separately so a prefix change cannot mask a
/// payload mismatch.
fn assert_echo_is_byte_identical(echo: &str, message: &str) {
    let expected = format!("ECHOING: {message}");
    assert_eq!(echo, expected);
    assert_eq!(sha256_hex(echo), sha256_hex(&expected));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_mib_confluence_shaped_echo_round_trip_is_byte_identical() -> anyhow::Result<()> {
    let message = confluence_shaped_message(ONE_MIB);
    assert_eq!(message.len(), ONE_MIB);
    let sent_digest = sha256_hex(&message);

    let client = spawn_client("large-payload-1mib").await?;
    let echo = call_echo(&client, &message, Duration::from_secs(120)).await?;
    client.shutdown().await;

    assert_echo_is_byte_identical(&echo, &message);
    eprintln!(
        "1MiB round trip OK: message_bytes={} echo_bytes={} sha256(message)={sent_digest}",
        message.len(),
        echo.len(),
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn twenty_five_mib_echo_documents_upper_bound_behavior() -> anyhow::Result<()> {
    // Upper-bound probe: the default legacy local stdio path preserves the
    // existing unbounded native codec (see `modern_local_and_executor_stdio_
    // reject_oversized_lines`, where only modern/executor modes reject lines
    // over 8MiB), so a 25MiB echo call is expected to succeed byte-identical.
    // If the stack instead rejects it, the panic below surfaces the explicit
    // rejection verbatim — success-by-truncation can never pass because the
    // byte-identity assertions below would fail first.
    let message = confluence_shaped_message(TWENTY_FIVE_MIB);
    assert_eq!(message.len(), TWENTY_FIVE_MIB);
    let sent_digest = sha256_hex(&message);

    let client = spawn_client("large-payload-25mib").await?;
    let outcome = client
        .call_tool(
            "echo".to_string(),
            Some(serde_json::json!({"message": &message})),
            /*meta*/ None,
            Some(Duration::from_secs(300)),
        )
        .await;
    match outcome {
        Ok(result) => {
            client.shutdown().await;
            let echo = result
                .structured_content
                .as_ref()
                .and_then(|value| value.get("echo"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!("25MiB echo succeeded but returned no structured echo text")
                })?;
            assert_echo_is_byte_identical(echo, &message);
            eprintln!(
                "25MiB round trip OK: message_bytes={} echo_bytes={} sha256(message)={sent_digest}",
                message.len(),
                echo.len(),
            );
        }
        Err(error) => {
            client.shutdown().await;
            panic!("25MiB echo was explicitly rejected by the stack: {error:#}");
        }
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn echo_rejects_malformed_and_edge_arguments_explicitly() -> anyhow::Result<()> {
    let client = spawn_client("large-payload-edge-args").await?;

    // Missing required `message` field: the echo schema requires it.
    let error = client
        .call_tool(
            "echo".to_string(),
            Some(serde_json::json!({})),
            /*meta*/ None,
            Some(Duration::from_secs(30)),
        )
        .await
        .expect_err("empty object must be rejected, not silently echoed");
    eprintln!("missing message rejected explicitly: {error:#}");

    // Wrong type for `message` (the echo schema requires a string).
    let error = client
        .call_tool(
            "echo".to_string(),
            Some(serde_json::json!({"message": 123})),
            /*meta*/ None,
            Some(Duration::from_secs(30)),
        )
        .await
        .expect_err("non-string message must be rejected, not silently echoed");
    eprintln!("non-string message rejected explicitly: {error:#}");

    // Non-object arguments are rejected client-side before touching the transport.
    let error = client
        .call_tool(
            "echo".to_string(),
            Some(serde_json::json!("just a string")),
            /*meta*/ None,
            Some(Duration::from_secs(30)),
        )
        .await
        .expect_err("non-object arguments must be rejected, not silently echoed");
    eprintln!("non-object arguments rejected explicitly: {error:#}");

    // Empty string is valid and round-trips exactly.
    let echo = call_echo(&client, "", Duration::from_secs(30)).await?;
    assert_eq!(echo, "ECHOING: ");

    client.shutdown().await;
    Ok(())
}
