# ключи и секреты
.env
.env.*
!.env.example
*.pem
*.key

# служебное рабочего места: копии файлов, пути, запросы и вердикты проверок, состояние установки, отчёт
checks/
selftest/
.workplace/state.json
.workplace/recon-before.json
.workplace/snapshots/
.workplace/backup-update/
.workplace/npm-cache/
install-report.md
.claude/settings.local.json
.claude/*.bak-*
.codex/*.bak-*
.DS_Store

# данные и результаты задач (могут содержать персональные данные)
workspaces/*/data/
workspaces/*/out/

# проекты внутри корня ведут собственный git
projects/
