{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"{{ROOT}}/.workplace/core/hooks/session-start.js\"",
            "commandWindows": "node \"{{ROOT}}/.workplace/core/hooks/session-start.js\"",
            "timeout": 15,
            "statusMessage": "Читаю память и задачи"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"{{ROOT}}/.workplace/core/hooks/human-message.js\"",
            "commandWindows": "node \"{{ROOT}}/.workplace/core/hooks/human-message.js\"",
            "timeout": 10,
            "statusMessage": "Запоминаю ответ человека"
          },
          {
            "type": "command",
            "command": "node \"{{ROOT}}/.workplace/core/hooks/feedback-reminder.js\"",
            "commandWindows": "node \"{{ROOT}}/.workplace/core/hooks/feedback-reminder.js\"",
            "timeout": 10,
            "statusMessage": "Проверяю, не поправка ли это"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|apply_patch",
        "hooks": [
          {
            "type": "command",
            "command": "node \"{{ROOT}}/.workplace/core/hooks/secret-guard.js\"",
            "commandWindows": "node \"{{ROOT}}/.workplace/core/hooks/secret-guard.js\"",
            "timeout": 10,
            "statusMessage": "Сторож секретов"
          }
        ]
      },
      {
        "matcher": "Bash|apply_patch",
        "hooks": [
          {
            "type": "command",
            "command": "node \"{{ROOT}}/.workplace/core/hooks/danger-guard.js\"",
            "commandWindows": "node \"{{ROOT}}/.workplace/core/hooks/danger-guard.js\"",
            "timeout": 10,
            "statusMessage": "Сторож опасных команд"
          }
        ]
      },
      {
        "matcher": "Bash|apply_patch|mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"{{ROOT}}/.workplace/core/hooks/cross-check-guard.js\"",
            "commandWindows": "node \"{{ROOT}}/.workplace/core/hooks/cross-check-guard.js\"",
            "timeout": 15,
            "statusMessage": "Сторож кросс-проверки"
          }
        ]
      }
    ]
  }
}
