# Verification of saved work

`workflow:verify` accepts only a task id. The main process runs the existing
project's `npm run verify` using Node and npm's CLI, not a shell command supplied
by the renderer. It does not invoke an implementation or review model. Scripts
are trusted repository code: this is not a sandbox or a guarantee of no writes.
Missing Node/npm or a missing `scripts.verify` is a refusal, not a fallback.
The existing process timeout and bounded/redacted run logging apply.

An approved specification and an existing task worktree are required. The
operation shares the orchestrator's task exclusion. It records a system
`verification` run and uses explicit `VERIFYING` workflow transitions, without
incrementing the round counter. A new review after a completed review still
consumes the next round and cannot exceed the budget. Success moves to `READY_FOR_REVIEW`; failure or
interruption returns to `READY_FOR_IMPLEMENTATION`. Previous review approval is
cleared. Startup recovery never invents a pass or automatically starts a process.
An implementation security denial cannot be cleared by running tests.

## What the identity proves

Two full content passes establish each snapshot. The input set is every tracked
file plus non-ignored untracked files, including executable modes, contents and
paths; missing tracked files are absent from the content set. Symlinks, submodules,
unreadable files and unstable captures fail closed. Limits are 20,000 file names
and 256 MiB of content per pass. Checkout common directory, root, branch, base
commit, specification, approval and provider revision are bound too.

The pre-command and post-command snapshots must agree. Review checks identity
before dispatch and after the reviewer returns. Publication checks it again.
A commit of identical content does not invalidate proof: HEAD and index staging
are deliberately not identity inputs. A code edit, deletion or addition does.
Ignored artifacts and the external runtime/environment are not attested. This
is not a hermetic build or protection against an adversarial concurrent writer
changing and restoring files between observations; users must stop editing
while verification runs. No source lock is claimed.

The newest verification after the latest implementation is authoritative. Failed,
missing or malformed verification cannot fall back to an older success. Historical
results remain visible with command, exit code, duration and snapshot digest.
They are not displayed as proof that the current files still match.

## UI

Run → Actions → Writes local files → **Run verification**. While the request is
pending the button is disabled; repeated clicks do not submit another request.
The main-process exclusion is authoritative. Result and output are under
Relay Timeline → **Verification · npm run verify**. After a pass use **Run review**.
No additional Claude permission or Coai setting is required for this fixed
command. This path does not grant publication approval or run Coai.
