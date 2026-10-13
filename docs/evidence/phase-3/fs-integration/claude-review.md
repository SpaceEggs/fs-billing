I found one real blocker in commit 8800cda: `install.sh` doesn't give server A a working service setup, even though the docs say it does. Nothing else rises to blocker level. The Lua integer fix is correct, the token handling is clean, and the CI skip logic does what it should. I only read code and ran read-only `docker run` checks against the local `fs-billing-freeswitch:local` image. No files were changed.

## Blocker

**1. `install.sh` installs no systemd unit, but `docs/freeswitch.md:110` says the package install keeps "systemd integration".**

- **Where:** `freeswitch/install/install.sh:57-63`, where the packages are listed and installed with `--no-install-recommends`.
- **What I saw in the image:** `freeswitch` only depends on `libfreeswitch1`, `libc6`, `libedit2` and perl. `freeswitch-systemd` isn't installed, and there's no `freeswitch.service` under `/lib/systemd/system`.
- **Impact on server A:** the script finishes with nothing that starts or supervises FreeSWITCH and nothing that brings it back after a reboot. Ops will believe it's a managed service when it isn't.
- **What gets installed instead:** the vanilla config from `freeswitch-conf-vanilla`. Its event socket listens on `::` with password `ClueCon`, and its `vars.xml` sets `default_password=1234`. The docs never say this has to be replaced before the first start. The test overlay hides the problem because `entrypoint.sh` deletes those directories.
- **Fix:**
  - Add `freeswitch-systemd` to `packages=(…)`, pinned to `$FS_VERSION` like the rest.
  - Right after install, run `systemctl disable --now freeswitch` (only if systemd is running, so the Docker build still works). That way the vanilla config never comes up on a public interface.
  - Add a server-A step to `docs/freeswitch.md` §6 and `freeswitch/README.md`: replace `event_socket.conf.xml` (loopback, new password), `vars.xml` (`default_password`) and the vanilla `sip_profiles`, `directory` and `dialplan`. Only then run `systemctl enable --now freeswitch`.
  - The smaller alternative is to fix the docs claim and document how to start FreeSWITCH by hand. That leaves server A without supervision.

## Checked, no problem found

- **Lua fix** (`billing_authorize.lua:13-22`): `math.tointeger` only runs after a `type == 'number'` guard. Values like 60.5, NaN or ±inf return nil and fall through to the invalid-response fallback. One correction to the commit's framing: the old `sip_codes[402.0]` lookup already worked, because Lua 5.3 treats float keys with integer values as integer keys. The real bug was only the `+60.0` / `402.0` text in the generated commands. The fix covers that, and the harness tests both cases.
- **Token handling:**
  - The token is passed as a BuildKit secret, never a build arg.
  - It's written with the shell's built-in `printf`, so it doesn't show up in the process list.
  - The auth file is created with `umask 077` and removed on every exit path.
  - curl reads it through `--netrc-file`.
  - In the image, `auth.conf.d` is empty and the SignalWire repo list is gone.
- **CI:**
  - `e2e` runs after `image` whether `image` succeeded or was skipped.
  - When the token is missing, the `image` job still succeeds, and `e2e` then pulls, fails and skips with a notice.
  - Both jobs compute the image tag from the same `hashFiles` input, which covers everything the Dockerfile copies in.
- **Phase-2 rules** (`seed.sql`):
  - Balances are restored by appending adjustment ledger entries; the balance projection is never written directly.
  - Every idempotency key includes the run id, so reruns don't collide.
  - `lock_tenants` is called before any write.

## Non-blocking nits

- **PRs never test `install.sh` changes** (`freeswitch.yml:88-102`): a PR that edits `freeswitch/install/**` or `freeswitch/docker/**` changes the tag hash, so the pull fails and e2e skips quietly. Consider making the notice say "image for this hash not built yet; run workflow_dispatch on main after merge", or allow `workflow_dispatch` on any ref.
- **Fork PRs:** if the GHCR package grants this repo read access, fork PRs could pull the private image, which contains SignalWire-gated binaries. Gate `e2e` on `github.event.pull_request.head.repo.full_name == github.repository`, or on not being a PR.
- **Concurrency** (`freeswitch.yml:23-25`): the nightly schedule and pushes to main share one concurrency group with `cancel-in-progress`, so a scheduled run can cancel a push's image build halfway. Add `${{ github.event_name }}` to the group.
- **Build record artifact:** `build-push-action@v6` uploads one by default, and it includes the build logs. No token is printed today. Setting `DOCKER_BUILD_RECORD_UPLOAD: false` on the build step removes one possible future leak.
- **Leftover build tools** (`install.sh:79`): purging only the direct build packages leaves `gcc` and the rest of the toolchain installed (`gcc` is `ii` in the image). Run `apt-get autoremove -y` afterwards; `libcurl4` is already marked manual, so it stays.
- **Unpinned inputs:**
  - `debian:bookworm` isn't pinned to a digest.
  - `libcurl4` and `lua5.3` aren't version-pinned.
  - The Lua-cURL build is fetched from luarocks.org with no checksum.
  - Since the nightly schedule rebuilds and overwrites the same hash tag, the image under that tag can change without any repo change. Pin the base image digest, or skip the push when the tag already exists.
- **Cleanup order** (`install.sh:21`): `rm -f "$auth_file" "$source_file"` runs before the root check. Run as non-root it can fail with a confusing error. Move it after line 22.
- **Vanilla `modules.conf.xml`** loads many modules that aren't installed. This only affects production, since the test overlay replaces the file. Expect a lot of load errors on server A unless the overlay is applied.
