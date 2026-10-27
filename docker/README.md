# Optional sandbox notes

The starter deliberately disables arbitrary shell commands. To run untrusted project code safely, use a separate disposable container or remote sandbox service.

Minimum hardening before enabling:
- Run each project in a fresh, non-root container with no host mounts except a per-job workspace.
- Disable network by default; use dependency allowlists if network access is required.
- Apply CPU, memory, process-count, disk, and wall-clock limits.
- Never mount the Docker socket into the app server.
- Destroy the container after each run.
- Validate archive paths and impose compressed/uncompressed size limits.
- Require authentication, per-user quotas, request rate limits, and audit logs.

Do not implement arbitrary shell execution in the main API process.
