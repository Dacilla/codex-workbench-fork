//! Compact MCP display policy: everyday history hides argument payloads while
//! the transcript and activity expansion retain full details on purpose.
//!
//! `Full` pins the legacy rendering byte-for-byte; `Compact` (the default)
//! shows `server.tool` plus status; `Preview` adds an allowlisted argument
//! summary. Execution data is never transformed, only its display.

use super::*;
use crate::test_support::PathBufExt;
use codex_app_server_protocol::McpToolCallResult;
use codex_app_server_protocol::McpToolCallStatus;
use codex_app_server_protocol::ThreadItem;
use codex_protocol::mcp::CallToolResult;
use pretty_assertions::assert_eq;
use serde_json::json;

fn invocation(arguments: Option<serde_json::Value>) -> McpInvocation {
    McpInvocation {
        server: "docs".into(),
        tool: "update".into(),
        arguments,
    }
}

fn text_result(text: &str) -> CallToolResult {
    CallToolResult {
        content: vec![json!({"type": "text", "text": text})],
        structured_content: None,
        is_error: None,
        meta: None,
    }
}

fn completed_cell(
    display: ToolCallDisplay,
    arguments: Option<serde_json::Value>,
) -> McpToolCallCell {
    let mut cell = new_active_mcp_tool_call(
        "call-policy".into(),
        invocation(arguments),
        /*animations_enabled*/ false,
        display,
    );
    cell.complete(Duration::ZERO, Ok(text_result("done")));
    cell
}

fn display_text(cell: &McpToolCallCell, width: u16) -> Vec<String> {
    cell.display_lines(width)
        .iter()
        .map(ToString::to_string)
        .collect()
}

fn small_args() -> serde_json::Value {
    json!({"count": 3, "verbose": false, "name": "abc"})
}

#[test]
fn compact_hides_arguments_and_reports_success() {
    let cell = completed_cell(ToolCallDisplay::Compact, Some(small_args()));
    assert_eq!(
        display_text(&cell, /*width*/ 80),
        vec![
            "• Called docs.update · succeeded".to_string(),
            "  └ done".to_string(),
        ]
    );
    assert_eq!(
        cell.raw_lines(),
        vec![
            Line::from("Called docs.update · succeeded"),
            Line::from("done"),
        ]
    );
}

#[test]
fn compact_running_call_has_no_status_suffix() {
    let cell = new_active_mcp_tool_call(
        "call-running".into(),
        invocation(Some(small_args())),
        /*animations_enabled*/ false,
        ToolCallDisplay::Compact,
    );
    assert_eq!(
        display_text(&cell, /*width*/ 80),
        vec!["• Calling docs.update".to_string()]
    );
    assert_eq!(cell.raw_lines(), vec![Line::from("Calling docs.update")]);
}

#[test]
fn compact_failed_call_reports_failure_and_bounded_diagnostic() {
    let mut cell = new_active_mcp_tool_call(
        "call-failed".into(),
        invocation(Some(small_args())),
        /*animations_enabled*/ false,
        ToolCallDisplay::Compact,
    );
    cell.complete(Duration::ZERO, Err("permission denied".to_string()));
    assert_eq!(
        display_text(&cell, /*width*/ 80),
        vec![
            "• Called docs.update · failed".to_string(),
            "  └ Error: permission denied".to_string(),
        ]
    );
    let header = &cell.display_hyperlink_lines(/*width*/ 80)[0].line;
    assert_eq!(header.spans[0].style, "•".red().bold().style);
}

#[test]
fn full_restores_legacy_rendering() {
    let cell = completed_cell(ToolCallDisplay::Full, Some(small_args()));
    assert_eq!(
        display_text(&cell, /*width*/ 200),
        vec![
            "• Called docs.update({\"count\":3,\"verbose\":false,\"name\":\"abc\"})".to_string(),
            "  └ done".to_string(),
        ]
    );
    assert_eq!(
        cell.raw_lines(),
        vec![
            Line::from("Called docs.update({\"count\":3,\"verbose\":false,\"name\":\"abc\"})"),
            Line::from("done"),
        ]
    );
}

#[test]
fn preview_allowlists_scalars_and_hides_payloads() {
    let cell = completed_cell(
        ToolCallDisplay::Preview,
        Some(json!({
            "pageId": 204341250,
            "notify": true,
            "missing": null,
            "body": "confidential document contents",
            "token": "sk-live-secret",
            "nested": {"a": [1, 2, {"b": "deep"}]},
        })),
    );
    let lines = display_text(&cell, /*width*/ 200);
    assert_eq!(lines.len(), 2);
    assert!(lines[0].starts_with("• Called docs.update("));
    assert!(lines[0].ends_with(") · succeeded"));
    for expected in [
        "pageId=204341250",
        "notify=true",
        "missing=null",
        "body=<hidden: 30 chars>",
        "token=<hidden: 14 chars>",
        "nested=<hidden: 24 chars>",
    ] {
        assert!(lines[0].contains(expected), "missing {expected}");
    }
    for leaked in ["confidential", "sk-live", "deep"] {
        assert!(!lines[0].contains(leaked), "leaked {leaked}");
    }
}

#[test]
fn preview_caps_argument_pairs() {
    let mut args = serde_json::Map::new();
    for index in 0..10 {
        args.insert(format!("k{index:02}"), json!(index));
    }
    let cell = completed_cell(
        ToolCallDisplay::Preview,
        Some(serde_json::Value::Object(args)),
    );
    let lines = display_text(&cell, /*width*/ 200);
    assert!(lines[0].contains("k07=7"));
    assert!(lines[0].contains("+2 more"));
    assert!(!lines[0].contains("k08"));
    assert!(!lines[0].contains("k09"));
}

#[test]
fn preview_sanitizes_control_characters_in_keys() {
    let mut args = serde_json::Map::new();
    args.insert("\u{1b}[31mkey\nx".to_string(), json!(1));
    let cell = completed_cell(
        ToolCallDisplay::Preview,
        Some(serde_json::Value::Object(args)),
    );
    let lines = display_text(&cell, /*width*/ 200);
    assert!(lines[0].contains("�[31mkey�x=1"));
    assert!(!lines.join("\n").contains('\u{1b}'));
}

#[test]
fn preview_hides_ansi_payloads_and_counts_unicode() {
    let cell = completed_cell(
        ToolCallDisplay::Preview,
        Some(json!({
            "count": 1,
            "token": "\u{1b}[31mred-secret\u{1b}[0m",
            "emoji": "🦀🦀🦀",
        })),
    );
    let lines = display_text(&cell, /*width*/ 200);
    assert!(lines[0].contains("count=1"));
    assert!(lines[0].contains("token=<hidden: 19 chars>"));
    assert!(lines[0].contains("emoji=<hidden: 3 chars>"));
    assert!(!lines.join("\n").contains('\u{1b}'));
}

#[test]
fn preview_without_object_arguments_falls_back_to_bare_tool() {
    for arguments in [None, Some(json!({})), Some(json!(["a", "b"]))] {
        let cell = completed_cell(ToolCallDisplay::Preview, arguments);
        assert_eq!(
            display_text(&cell, /*width*/ 80)[0],
            "• Called docs.update · succeeded"
        );
    }
}

#[test]
fn compact_and_preview_never_emit_payloads_across_widths() {
    let secret = "top-secret-body";
    let arguments = Some(json!({"body": secret, "nested": {"deep": [secret]}}));
    for display in [ToolCallDisplay::Compact, ToolCallDisplay::Preview] {
        let cell = completed_cell(display, arguments.clone());
        for width in [16, 24, 40, 80, 120] {
            let lines = cell.display_lines(width);
            assert!(
                lines.iter().all(|line| line.width() <= usize::from(width)),
                "width {width}"
            );
            let text = lines
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n");
            assert!(!text.contains(secret), "width {width}");
            let raw = cell
                .raw_lines()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n");
            assert!(!raw.contains(secret), "raw width {width}");
        }
    }
}

#[test]
fn transcript_and_expansion_keep_full_details_on_purpose() {
    let secret = "intentional-details-secret";
    let cell = completed_cell(ToolCallDisplay::Compact, Some(json!({"body": secret})));
    let transcript = cell
        .transcript_lines(/*width*/ 80)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(transcript.contains(secret));
    let expanded = visible_lines(cell.expanded_hyperlink_lines(/*width*/ 80))
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(expanded.contains(secret));
    assert!(cell.has_hidden_activity_details(/*width*/ 80));
}

#[test]
fn large_payload_stays_compact_and_bit_identical() {
    let body = "sensitive ".repeat(100_000);
    let args = json!({"pageId": 204341250, "body": body});
    let before = serde_json::to_string(&args).expect("serialize args");
    assert!(before.len() > 1_000_000);

    for display in [
        ToolCallDisplay::Compact,
        ToolCallDisplay::Preview,
        ToolCallDisplay::Full,
    ] {
        let cell = completed_cell(display, Some(args.clone()));
        let lines = display_text(&cell, /*width*/ 80);
        if display == ToolCallDisplay::Full {
            assert!(lines.len() > 1_000, "full restores the payload");
        } else {
            assert!(lines.len() <= 4, "compact stays small: {lines:?}");
        }
        assert!(!lines.join("\n").contains("sensitive") || display == ToolCallDisplay::Full);
        // Rendering is pure: the retained arguments are untouched.
        assert_eq!(
            serde_json::to_string(
                &cell
                    .invocation
                    .arguments
                    .as_ref()
                    .expect("retained arguments")
            )
            .expect("serialize retained arguments"),
            before
        );
    }
}

fn replay_item(arguments: serde_json::Value) -> ThreadItem {
    ThreadItem::McpToolCall {
        id: "call-replay".to_string(),
        server: "docs".to_string(),
        tool: "update".to_string(),
        status: McpToolCallStatus::Completed,
        arguments,
        app_context: None,
        mcp_app_resource_uri: None,
        mcp_app_ui: None,
        plugin_id: None,
        read_only_hint: None,
        result: Some(Box::new(McpToolCallResult {
            content: vec![json!({"type": "text", "text": "done"})],
            structured_content: None,
            meta: None,
        })),
        error: None,
        duration_ms: Some(7),
    }
}

#[test]
fn replay_preserves_arguments_and_renders_compact() {
    let secret = "replay-secret-body";
    let args = json!({"body": secret, "pageId": 1});
    let before = serde_json::to_string(&args).expect("serialize args");

    let history = crate::thread_transcript::tools::McpHistory::from_item(replay_item(args.clone()))
        .expect("replay history");
    let cell = history.into_cell(ToolCallDisplay::Compact);
    assert_eq!(
        serde_json::to_string(cell.invocation.arguments.as_ref().expect("args"))
            .expect("serialize replayed args"),
        before
    );
    let text = display_text(&cell, /*width*/ 80).join("\n");
    assert!(!text.contains(secret));
    assert!(text.starts_with("• Called docs.update · succeeded"));

    // The persisted-transcript path also defaults to compact and keeps data.
    let cwd = crate::test_support::test_path_buf("/workspace").abs();
    let replayed = crate::thread_transcript::thread_items_to_transcript_cells(
        /*thread_id*/ None,
        &cwd,
        [replay_item(args)],
        crate::thread_transcript::RawReasoningVisibility::Hidden,
        /*config*/ None,
    );
    assert_eq!(replayed.len(), 1);
    let replayed_text = replayed[0]
        .display_lines(/*width*/ 80)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!replayed_text.contains(secret));
    let replayed_cell = replayed[0]
        .as_any()
        .downcast_ref::<McpToolCallCell>()
        .expect("replayed MCP cell");
    assert_eq!(
        serde_json::to_string(
            replayed_cell
                .invocation
                .arguments
                .as_ref()
                .expect("replayed args")
        )
        .expect("serialize replayed args"),
        before
    );
}

#[test]
fn compact_preview_and_full_presentations_snapshot() {
    let arguments = Some(json!({
        "pageId": 204341250,
        "body": "confidential document contents",
    }));
    let mut sections = Vec::new();
    for display in [
        ToolCallDisplay::Compact,
        ToolCallDisplay::Preview,
        ToolCallDisplay::Full,
    ] {
        let cell = completed_cell(display, arguments.clone());
        let label = match display {
            ToolCallDisplay::Compact => "compact",
            ToolCallDisplay::Preview => "preview",
            ToolCallDisplay::Full => "full",
        };
        sections.push(format!(
            "{label}:\n{}",
            display_text(&cell, /*width*/ 80).join("\n")
        ));
    }
    insta::assert_snapshot!(sections.join("\n\n"));
}
