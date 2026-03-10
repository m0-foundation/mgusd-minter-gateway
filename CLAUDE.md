# Project Instructions

## Git Worktree Workflow

When starting work on a new feature or significant change, **always use a git worktree**:

```bash
claude --worktree <feature-name>
```

This keeps the main working directory clean and allows parallel work without conflicts. Only skip worktrees for trivial one-file fixes that don't warrant isolation.
