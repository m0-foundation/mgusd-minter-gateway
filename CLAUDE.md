# Project Instructions

## Git Worktree Workflow

When starting work on a new feature or significant change, **always use a git worktree**:

```bash
claude --worktree <feature-name>
```

This keeps the main working directory clean and allows parallel work without conflicts. Only skip worktrees for trivial one-file fixes that don't warrant isolation.

## Pull Request Guidelines

**Never mention Claude, AI, or automated generation in PR titles, descriptions, or comments.** No "Generated with Claude Code" footers, no AI attribution lines. PRs should read as human-authored.
