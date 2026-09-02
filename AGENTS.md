# Mia release policy

When the user asks to push or deploy Mia to production:

1. Verify the change locally, commit it, and push `main` to GitHub first.
2. Run `pnpm deploy:production`; the production server must fetch and build that exact GitHub SHA.
3. Never deploy Mia by copying a local `dist/` directory unless the user explicitly requests an emergency direct upload.
4. Report the Git SHA, release directory, deployment duration, health result, and rollback target.

The production deploy keeps exactly three runnable server releases. Secrets remain in `/etc/mia/mia.env` and must never be committed or printed.
