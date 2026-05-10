# ConnectAI Company Session File Actions

## Problem

Corporate agents run from the ConnectAI company folder, not from this source-code workspace.

The active company folder is configured by `connectAiLab.localBrainPath`; the company runtime data lives under:

```text
<localBrainPath>/_company
```

Session artifacts must therefore be written under:

```text
<localBrainPath>/_company/sessions/<session-id>
```

They must not be written under the repository workspace:

```text
~/Documents/connect-ai/sessions
```

## Required Behavior

When a specialist agent emits file action tags during corporate dispatch:

```xml
<create_file path="writer_emails.md">...</create_file>
<read_file path="business_proposal.md"/>
<create_file path="sessions/2026-05-10T15-21/writer_emails.md">...</create_file>
```

the extension resolves them as follows:

- Bare relative paths such as `writer_emails.md` resolve to the current company session directory.
- `sessions/<session-id>/...` resolves under the company folder, never under the code workspace.
- If the agent uses a stale or local-time session id that does not exist, the path is corrected to the current active session directory.
- Company-level paths such as `_shared/...`, `_agents/...`, `approvals/...`, `site/...`, and `logs/...` remain company-root relative.
- Absolute paths, `~/...`, and `$HOME/...` are respected, subject to system path protections.

## Guardrail

The corporate dispatch path must call `_executeActions()` with:

```ts
rootOverride: getCompanyDir()
sessionDir
```

Do not use `vscode.workspace.workspaceFolders?.[0]` for corporate file actions. The workspace may be the source repo, while business session artifacts belong to the Google Drive knowledge/company folder.

## Verification Checklist

Before shipping changes in this area:

1. Run `npm run compile`.
2. Confirm a bare file action writes to `<company>/sessions/<current-session>/filename.md`.
3. Confirm `sessions/<wrong-session>/filename.md` is corrected to the current session when the explicit session directory does not exist.
4. Confirm no new files appear under `~/Documents/connect-ai/sessions`.
5. Package and reinstall the VSIX when the change must affect Antigravity.

