# Production release and recovery

This document applies to the schema-5 local-first cloud synchronization release.
It does not authorize a production deployment by itself.

## Production package

Run from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 -Mode Production
```

The command recreates `dist/` from an explicit allowlist. The output contains only:

- `index.html`
- `auth-config.js`
- `auth-service.js`
- `learning-sync.js`
- `remote-assessment-repository.js`
- `sw.js`
- `manifest.json`
- the three required files in `icons/`

Tests, SQL migrations, internal documentation, packaging scripts, Git metadata, and
local browser profiles are not copied. `netlify.toml` sets `dist` as the publish
directory. The generated production files are checked in because Netlify performs
no dependency installation or application build.

Before committing a release, regenerate the package, run the full test suite, and
confirm `git diff --check` passes. A changed source runtime file must have a matching
change in `dist/`.

## Service-worker upgrade behavior

The schema-5 release uses cache `aiml-deck-v25`. Every local JavaScript request in
`index.html` and every corresponding service-worker app-shell entry uses the same
`?v=25` URL.

The production v22 worker cached unversioned script URLs. Cache matching includes
the query string, so v22 cannot answer the new v25 requests with an old authentication
or synchronization script. It must fetch the coherent v25 files. The v25 worker then
pre-caches that set, calls `skipWaiting()`, deletes caches with other names during
activation, and claims open clients. Navigation remains network-first with the
cached `index.html` as its offline fallback; same-origin app-shell files remain
available offline. Supabase, OAuth, and other cross-origin traffic is never added to
the app-shell cache.

Whenever a cached runtime asset changes, advance both the script URL version and
`CACHE_VERSION` together and update the release regression tests.

## Emergency schema-5 recovery artifact

Create the recovery artifact before a production release:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 -Mode Recovery
```

This creates ignored local directory `recovery-dist/`. It uses the production
schema-5 application and persistence implementation unchanged, replaces the public
authentication configuration with an empty configuration, and uses isolated
`v=25-recovery-2` asset URLs plus cache `aiml-deck-recovery-v2`.

Use this artifact only as an emergency roll-forward deployment when the schema-5
production application is unusable and a normal hotfix cannot be published quickly.
It must be published on the same production origin; browser localStorage is scoped
to the origin and is unavailable from an unrelated preview URL.

The recovery build intentionally disables sign-in and cloud synchronization. It:

- reads and writes schema 5 only;
- retains anonymous assessment history;
- retains every account bucket;
- retains pending event IDs and unresolved conflict payloads;
- leaves claim decisions intact;
- never converts storage back to schema 4.

While recovery is active, the deck operates anonymously. Existing account history
remains stored but is not displayed until the normal schema-5 application returns
and the user signs into that account. New recovery assessments enter the anonymous
bucket. Deploy a corrected schema-5 application as soon as possible and allow its
normal synchronization pipeline to resume.

Do not restore the old schema-4 application after a browser has opened schema 5. It
cannot read schema-5 state and can overwrite the storage key with a new schema-4
record. A Netlify rollback also does not revert browser localStorage or Supabase
rows. Prefer a normal schema-5 hotfix; use the recovery artifact only to preserve
local study while that hotfix is prepared.

## Netlify verification

Before pushing the release, verify in the Netlify dashboard:

1. The connected repository is `ai-flash-deck/flash-deck`.
2. The production branch is `main`.
3. Automatic publishing is enabled and deploys are not locked.
4. The base directory is the repository root.
5. The publish directory resolves to `dist`, as declared by `netlify.toml`.
6. There is no dashboard build or publish override that supersedes the repository
   configuration.
7. The primary production URL is `https://exquisite-malabi-dd2138.netlify.app/`.

After deployment, confirm the published commit, verify cache `aiml-deck-v25`, and
confirm `/tests/`, `/docs/`, `/supabase/`, and `/scripts/` return 404.

## Supabase authentication verification

Before production validation, verify without changing database schema or RLS:

- Site URL is `https://exquisite-malabi-dd2138.netlify.app/`.
- Redirect URLs contain the exact production URL and `http://localhost:8000/`.
- Google authentication is enabled.
- Google Cloud accepts the production origin and uses
  `https://qgrkhsxzzuyiddglvhkb.supabase.co/auth/v1/callback` as the OAuth redirect.
- Email magic-link authentication and new-user creation remain enabled.
- Production email delivery/SMTP is configured appropriately.
- The Google client secret remains only in Supabase and no privileged credential is
  present in frontend files.

## Incident procedure

For a failure discovered after schema-5 migration:

1. Lock automatic production deploys while diagnosing the incident.
2. Preserve the failing deployment and logs.
3. Prefer a tested hotfix based on the current schema-5 commit.
4. If local practice itself is unavailable, publish the already-tested
   `recovery-dist/` output to the same production origin.
5. Do not publish the old schema-4 deploy as a general rollback.
6. Run the full regression suite before restoring the normal schema-5 build.
7. Validate authentication, anonymous import, synchronization, account isolation,
   offline retry, and cross-browser restoration with a fresh test account.

The intentional Iteration 7D-1 conflict remains in its test account. Use a fresh
account and isolated browser profile for production validation so it does not cause
an expected synchronization warning.
