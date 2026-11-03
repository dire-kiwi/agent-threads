//! A Claude Code run whose files (its MCP config, its skills plugin) can't be written isn't started
//! without them: the turn fails. On its own, since it points TMPDIR, which is the whole process's,
//! somewhere that can't be written.

mod common;

use agent_threads::{
    AgentThreads, Capabilities, ClaudeCodeOptions, CreateOptions, McpServer, Options, PermissionPolicy, SendOptions,
    Skill,
};
use common::{items, mini_runs, settle};

#[test]
fn doesnt_start_claude_without_the_files_it_needs() {
    let dir = common::temp_dir();
    let log = dir.join("log.jsonl");
    // A file, so nothing can be made inside it.
    let not_a_dir = dir.join("not-a-dir");
    std::fs::write(&not_a_dir, "").unwrap();
    // The only test in this binary, and nothing else runs yet.
    unsafe { std::env::set_var("TMPDIR", &not_a_dir) };
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut claude = ClaudeCodeOptions {
                bin: common::mini("claude").to_string_lossy().into(),
                ..Default::default()
            };
            claude
                .env
                .insert("MINI_CLAUDE_LOG".into(), Some(log.to_string_lossy().into()));
            let sdk = AgentThreads::new(Options {
                harnesses: vec![agent_threads::claude_code(claude)],
                capabilities: Capabilities {
                    permissions: Some(PermissionPolicy::allow()),
                    ..Default::default()
                },
                on_error: Some(std::sync::Arc::new(|_| {})),
                ..Default::default()
            });
            let cases = [
                (
                    Capabilities {
                        mcp_servers: [("echo".to_string(), McpServer::stdio("node", ["echo.mjs"]))].into(),
                        ..Default::default()
                    },
                    "its MCP servers' config couldn't be written",
                ),
                (
                    Capabilities {
                        skills: vec![Skill::Inline {
                            name: "greet".into(),
                            content: "Say hi.".into(),
                        }],
                        ..Default::default()
                    },
                    "the app's skills couldn't be written",
                ),
            ];
            for (capabilities, why) in cases {
                let t = sdk
                    .create(CreateOptions {
                        cwd: Some(common::temp_dir()),
                        capabilities,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
                let s = settle(&sdk, &t.id).await;
                assert_eq!(s["thread"]["status"], "error");
                let error = s["thread"]["error"].as_str().unwrap();
                assert!(error.contains("couldn't be started") && error.contains(why), "{error}");
                assert_eq!(items(&s, "turn_result").len(), 1);
                // Claude was never started.
                assert!(mini_runs(&log).is_empty());
            }
            sdk.close(true).await.unwrap();
        });
}
