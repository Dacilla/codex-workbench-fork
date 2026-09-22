//! Compact MCP invocation summaries for everyday history.
//!
//! The execution flow retains complete arguments and results; only their
//! display is reduced. `Compact` shows `server.tool` plus status,
//! `Preview` adds an allowlisted argument summary, and `Full` restores the
//! complete JSON arguments. The Ctrl+T transcript and activity expansion
//! always keep full details, independent of this policy. Code-mode cells
//! (`node_repl` / `cua_repl`) keep their established title rendering in
//! every mode.

use super::McpInvocation;

/// Upper bound on argument pairs shown by the preview summary. Remaining
/// pairs collapse into a `+N more` suffix so bulky tools cannot flood history.
const MAX_PREVIEW_ARG_PAIRS: usize = 8;

/// Completed-call status suffix for compact and preview headers. Running
/// calls keep the `Calling` verb instead, and `Full` keeps the legacy header
/// byte-for-byte. Failures stay visible without echoing payloads.
pub(super) fn status_suffix(success: Option<bool>) -> Option<&'static str> {
    match success {
        Some(true) => Some(" · succeeded"),
        Some(false) => Some(" · failed"),
        None => None,
    }
}

/// Bare `server.tool` label shared by compact headers and preview fallbacks.
pub(super) fn compact_invocation_text(invocation: &McpInvocation) -> String {
    format!("{}.{}", invocation.server, invocation.tool)
}

/// Allowlisted argument summary, or `None` when the invocation carries no
/// object arguments to summarize. JSON numbers, booleans, and nulls render
/// verbatim; strings, arrays, and objects collapse to `<hidden: N chars>`
/// so secrets and bulky bodies never echo. Control characters in keys are
/// replaced so adversarial tool schemas cannot inject terminal escapes.
pub(super) fn preview_args_summary(invocation: &McpInvocation) -> Option<String> {
    let serde_json::Value::Object(map) = invocation.arguments.as_ref()? else {
        return None;
    };
    if map.is_empty() {
        return None;
    }
    let mut pairs = Vec::new();
    for (key, value) in map.iter().take(MAX_PREVIEW_ARG_PAIRS) {
        pairs.push(preview_pair(key, value));
    }
    let mut summary = pairs.join(" · ");
    if map.len() > MAX_PREVIEW_ARG_PAIRS {
        let hidden = map.len() - MAX_PREVIEW_ARG_PAIRS;
        summary.push_str(&format!(" · +{hidden} more"));
    }
    Some(summary)
}

fn preview_pair(key: &str, value: &serde_json::Value) -> String {
    let key = sanitize_preview_key(key);
    match value {
        serde_json::Value::Number(_) | serde_json::Value::Bool(_) | serde_json::Value::Null => {
            format!("{key}={value}")
        }
        serde_json::Value::String(text) => {
            format!("{key}=<hidden: {} chars>", text.chars().count())
        }
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            let chars = serde_json::to_string(value)
                .map(|rendered| rendered.chars().count())
                .unwrap_or_default();
            format!("{key}=<hidden: {chars} chars>")
        }
    }
}

fn sanitize_preview_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_control() { '�' } else { c })
        .collect()
}
