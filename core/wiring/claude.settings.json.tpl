{
  "permissions": {
    "allow": [
      "Bash(node .workplace/core/cli/wp.js *)",
      "Bash(node .workplace/core/cli/wp.js)",
      "Bash(node .claude/skills/cross-check/scripts/prepare-check.js *)",
      "Bash(node .claude/skills/cross-check/scripts/prepare-check.js)",
      "Bash(node .claude/skills/cross-check/scripts/run-check.js *)",
      "Bash(node .claude/skills/cross-check/scripts/run-check.js)",
      "Bash(node .claude/skills/cross-check/scripts/finalize-check.js *)",
      "Bash(node .claude/skills/cross-check/scripts/finalize-check.js)",
      "Bash(node .claude/skills/cross-check/scripts/selftest-setup.js *)",
      "Bash(node .claude/skills/cross-check/scripts/selftest-setup.js)"
    ]
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.workplace/core/hooks/session-start.js\"",
            "timeout": 15
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.workplace/core/hooks/human-message.js\"",
            "timeout": 10
          },
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.workplace/core/hooks/feedback-reminder.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.workplace/core/hooks/secret-guard.js\"",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.workplace/core/hooks/danger-guard.js\"",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Bash|PowerShell|mcp__.*|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.workplace/core/hooks/cross-check-guard.js\"",
            "timeout": 15
          }
        ]
      },
      {
        "matcher": "Agent|Task",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.workplace/core/hooks/model-guard.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
