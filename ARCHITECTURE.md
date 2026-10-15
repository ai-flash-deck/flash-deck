# AI/ML Interview Deck architecture

## Current application

The deck is a static Progressive Web App. There is no framework, router, package
manager, build step, or third-party test runner. When optional authentication is
configured, the browser loads the pinned Supabase JavaScript client at runtime.
`index.html` contains the HTML, CSS, question content, UI rendering, study-session
logic, and persistence composition. `learning-sync.js` owns schema-5 local
learning storage, merge rules, and synchronization coordination.
`remote-assessment-repository.js` owns Supabase assessment-table queries.
`auth-service.js` owns authentication and creates the one browser client shared
by the auth and remote-learning repositories. `sw.js` provides offline caching,
while `manifest.json` and `icons/` provide installable-PWA metadata and assets.

The application has one page and three user-visible states:

1. Browse the complete deck, optionally filtered by topic.
2. Run or resume a focused study session.
3. View the completed-session summary and start follow-up practice.

## Conceptual boundaries

The code remains in one file to avoid a risky module/build migration, but its
responsibilities are kept in recognizable sections:

- **Content:** `TOPICS`, `topicsById`, `CARDS`, and `cardId`.
- **Study:** `SESSION_TYPES`, session selection, creation, navigation, and summary
  calculation helpers.
- **Progress:** durable events in the active anonymous or account bucket, derived
  question progress, and active-session response snapshots in `session.responses`.
- **Identity:** `auth-service.js` exposes provider-neutral auth state and the
  minimum authenticated identity; Supabase-specific calls remain behind it.
- **Persistence:** `storageRepository`, the owner-aware local assessment
  repository, the Supabase assessment repository, and the synchronization
  coordinator.
- **UI:** DOM references, card rendering, view transitions, and event handlers.

JSDoc types in `index.html` document `Topic`, `Question`, `AssessmentEvent`,
`DerivedQuestionProgress`, `ProgressState`, and `StudySession` without adding a
compiler or dependency.

## State and persistence

Two versioned JSON documents are stored in browser `localStorage`:

- `aiml-interview-deck-progress`: schema-5 durable assessment history partitioned
  into anonymous and per-account buckets.
- `aiml-interview-deck-session`: the current or most recently completed session,
  including ordered card IDs, position, assessments, topic, and status.

All browser-storage access goes through `storageRepository`. Card rendering and
study logic never issue Supabase queries.

Learning persistence uses schema version 5 and domain migration version 4. The
active-session document remains schema version 4 because unfinished session
position and ordering are still local-only. All normal question references are
immutable IDs stored directly on the card, using `q_0001` through `q_0205`.
These IDs do not depend on content, category labels, or array order and are
suitable for future database references.

The schema-5 learning envelope is:

```text
{
  schemaVersion: 5,
  domainMigrationVersion: 4,
  anonymous: { revision, assessmentEvents, conflicts },
  users: {
    "<Supabase user ID>": { assessmentEvents, pendingEventIds, conflicts }
  },
  claimDecisions: {
    "<Supabase user ID>": { declinedRevision? | importedRevision?, decidedAt }
  },
  unmappedLegacyResponses?,
  unmappedAssessmentEvents?
}
```

`pendingEventIds` is delivery state rather than a second learning source.
Derived progress always receives the active owner's `assessmentEvents`.
Anonymous events never enter an account bucket without an explicit import.
Signing out switches back to the anonymous bucket and retains every account
bucket and pending marker on disk.

Schema 4 migrates through `aiml-interview-deck-progress-v5-staging`. The browser
constructs the schema-5 candidate in memory, writes and verifies staging, then
atomically replaces and verifies the normal key. Staging is removed only after
the final record validates. A failed staging or final write leaves the exact
schema-4 source untouched; the complete in-memory candidate remains available
for the current page, and a later load retries deterministically. A complete
schema-5 record is a no-op, making migration idempotent. Malformed source data is
left unchanged and reported as unsupported rather than replaced.

### Topic identity

`TOPICS` defines five durable topic records with explicit slug IDs and display
names. Each question stores an authoritative `topicId`; its existing `cat` value
is retained only as display-data compatibility. Topic selection and study-session
filtering use `topicId`, so changing a topic name or ordering does not change its
identity. Sessions use `all` and `weak_areas` for their two non-topic scopes.

### Assessment history and semantics

Assessment history is the durable source of truth. Events use
`{ id, questionId, sessionId, result, assessedAt }`.
`result` has exactly two canonical values: `known` and `needs_review`. UI labels
map to these values through `data-result`, and business logic never reads the
visible label. `assessmentHistoryRepository` appends valid events through
`storageRepository`, rejects duplicate event IDs, and preserves prior-session
events when later sessions are completed.

`deriveQuestionProgress(events, questionId)` calculates current progress rather
than persisting competing counters. It returns the latest result as both
`latestResult` and `currentStatus`, the latest `assessedAt` as `lastReviewedAt`,
and counts for all assessments, `known`, and `needs_review`. Ordering uses valid
event timestamps followed by lexicographic event ID when timestamps are equal.
This makes merged results deterministic regardless of local/remote array order.
With 205 questions, deriving these values on demand keeps the source of truth
unambiguous and is inexpensive.

The card interaction requires answer reveal before creating an event. Repeating
the same choice for the same question presentation and session returns the prior
event instead of creating a duplicate. A changed choice appends a new event, and
the later event becomes current status.

### Weak Areas

Weak Areas has no separate persisted status or question list. `getWeakQuestions`
receives the content cards and `progress.assessmentEvents`, calls
`deriveQuestionProgress` for each candidate, and includes only questions whose
current status is `needs_review`. Questions with a newer `known` event and
unassessed questions are excluded.

The selector accepts an optional stable `topicId`; display names are never used
for weak eligibility. Starting weak practice passes the selected IDs into the
normal `createSessionState` and navigation flow. The completed session's requested
size is the cap, while a smaller eligible pool is used in full without duplicates
or filler.

An active weak session stores its ordered `cardIds` like every other session.
Assessments may change future eligibility, but they never mutate that active
snapshot, preserving navigation, resume, and session-specific results. When the
derived pool is empty, the completion screen shows a simple no-review message and
retains the existing Practice Again and Return to Deck actions.

### Overall and topic progress

`deriveOverallProgress(cards, assessmentEvents)` provides the read-only lifetime
summary. It counts valid unique content cards, derives each card's current status
with `deriveQuestionProgress`, and returns:

- `totalQuestions`: all valid cards in the supplied content set.
- `questionsPracticed`: unique questions with a current canonical status.
- `known`: practiced questions currently `known`.
- `needsReview`: practiced questions currently `needs_review`.
- `knownPercent`: `Math.round(known / questionsPracticed * 100)`, or `0` when no
  questions have been practiced.

Therefore `known + needsReview === questionsPracticed`. Historical attempts do
not increase the practiced count, and unassessed questions count only toward the
total. Invalid and unknown events are already excluded by the shared question
progress validation.

`deriveTopicProgress` applies the same rules after filtering cards by stable
`topicId`; `deriveProgressByTopic` returns summaries in authoritative `TOPICS`
order with their display names. No summary, percentage, or topic counter is
persisted. The compact deck view hides numeric metrics for a new user and shows
the neutral prompt to start practicing instead.

Session results remain separate: `calculateSessionResults` describes only the
responses stored in one `StudySession`, while overall and topic progress describe
the latest status across durable `progress.assessmentEvents`.

### Optional authentication

Supabase Auth is the managed identity provider. It is compatible with this static
application through its browser client, supports Google OAuth and passwordless
email magic links, restores its own browser session, and requires no custom authentication
backend. `auth-service.js` loads the pinned Supabase UMD client only when valid
public configuration exists, so missing configuration or network access never
prevents the local deck from loading.

The `authService` boundary has four states: `loading`, `anonymous`,
`authenticated`, and `error`. Provider user objects are reduced to the identity
contract `{ userId, email?, displayName? }`; `displayName` is optional provider
presentation metadata. Study, card, Weak Areas, and progress functions do
not receive the Supabase client or provider user. `onAuthStateChange` updates the
identity after redirect completion, token restoration, refresh, and sign-out.
Sign-out uses local scope and does not clear application learning storage.

Google uses Supabase's redirect OAuth flow. Email uses Supabase-managed magic
links through `signInWithOtp` with `shouldCreateUser: true`, so first-time and
returning users share one passwordless flow. Magic links return to the current
origin and pathname. That exact URL
must be allowed in Supabase Authentication URL Configuration for production and
local development. Google Cloud redirects to Supabase's provider callback, while
the application return URL is configured in Supabase. A production email flow
also requires a suitable SMTP provider; Supabase's default sender is limited and
intended for testing.

`auth-config.js` contains only the project URL and browser-safe publishable (or
legacy anon) key. Service-role keys, database credentials, and Google client
secrets must never be committed or sent to the browser. The Google secret belongs
in Supabase provider settings. The service worker caches the local auth service
and configuration files, but does not cache Supabase requests, responses, or
tokens. Supabase manages its own auth-session storage.

The account surface greets users with the first token of provider-supplied
`given_name`, `full_name`, or `name` metadata. When none is present it shows the
neutral `Signed in` label; it never guesses a name from an email address.

Authentication is optional and does not gate any study behavior. An auth error is
shown only in the account surface; local progress, active sessions, and offline
study continue.

### Release packaging, cache coherence, and recovery

Production hosting publishes the checked-in `dist/` directory declared by
`netlify.toml`. `scripts/package-release.ps1` recreates it from a ten-file runtime
allowlist, excluding tests, internal documentation, database migrations, development
scripts, local profiles, and Git metadata. The browser application remains a static,
dependency-free PWA; packaging is a deterministic copy step rather than a runtime
build system.

All local JavaScript tags and service-worker app-shell entries use the same explicit
asset version. Cache `aiml-deck-v24` requests `?v=24` scripts, so the existing v22
worker's unversioned cache entries cannot satisfy a new page's script requests. The
new worker pre-caches the coherent shell, activates immediately, deletes older named
caches, and claims clients. Cross-origin authentication and data traffic remains
outside the application cache.

The recovery packager creates `recovery-dist/` from the same schema-5 source. It
changes only the public authentication configuration and cache/asset namespace:
authentication and cloud sync remain off, while schema-5 persistence continues to
preserve anonymous events, account buckets, pending IDs, conflicts, and claim
decisions. This local artifact is intended for a same-origin emergency roll-forward,
not an ordinary release. It is excluded from Git and from the Netlify production
package.

The schema-4 production version is not a data-safe rollback after schema-5 migration.
It treats schema-5 storage as unsupported and can overwrite it after a new assessment.
Operational recovery therefore prefers a schema-5 hotfix, with the recovery artifact
available only when local practice in the normal build is unavailable. Detailed
release and dashboard checks are in `docs/production-release.md`.

### Cloud learning-history synchronization

The shared configured Supabase client is passed separately to `authService` and
`remote-assessment-repository.js`. The remote repository is the only component
that queries `public.assessment_events`. It fetches every page of the signed-in
user's RLS-filtered rows and inserts immutable event payloads without `user_id`.
It never performs update, delete, or blind upsert operations.

Authenticated assessments are local-first: append to that user's bucket, persist
the event ID as pending, then request synchronization. Insert success removes only
the pending marker. A `23505` response triggers an own-row fetch. An identical
payload is idempotent success; a different payload becomes a durable unresolved
conflict containing both complete versions. The remote version feeds active
derived progress, while the local version remains recoverable in the conflict.

Remote restoration merges by event ID within one account. Remote-only events are
cached locally, matching events deduplicate, local-only eligible events remain
pending, and an empty or failed remote response never clears local history.
Unknown question IDs, including RLS test records, remain preserved but are
excluded by the existing content-aware Progress and Weak Areas selectors and are
not automatically uploaded.

The coordinator retries on authentication restoration, a new assessment, and the
browser `online` event. It has a single-flight guard and no polling loop. Network
or provider failures retain pending events. Each account change increments a
generation; responses from an earlier account are ignored before any local merge
or UI update. Sign-out cancels the active generation, keeps account data and
pending work, and restores the anonymous view.

When eligible anonymous history exists after sign-in, the UI asks before import.
Import copies events into the account bucket, keeps the anonymous copy, marks new
account copies pending, and records `importedRevision`. “Not now” records
`declinedRevision`. Either decision suppresses repeat prompts for the same
anonymous revision; a later anonymous assessment advances the revision and makes
the choice available again. Event-ID deduplication makes import retryable.

### Legacy question-ID migration

Persistence schema version 1 used hashes derived from category and question text.
`LEGACY_QUESTION_ID_MAP` is a frozen 205-entry compatibility map generated from
the unchanged pre-migration content. The legacy content migrations run before
progress or session state is loaded:

- Progress response keys are changed to immutable IDs. When legacy and immutable
  records target the same question, the newest assessment timestamp wins, with an
  immutable-keyed record winning a timestamp tie.
- Unknown progress references are retained in `unmappedLegacyResponses` and
  reported in the console rather than discarded.
- Session `cardIds` and response keys are migrated together. If any reference is
  unknown or the mapping would create duplicate ordered cards, the original v1
  session is left untouched and the problem is reported.
- Schema-2 topic display names migrate deterministically to topic IDs.
- Legacy `knew_it` becomes `known`; `didnt_know` and `almost` become
  `needs_review`, retaining both former weak-area states.
- Schema-3 progress contains only the latest known assessment per question. Each
  valid record becomes exactly one deterministic migration event. Earlier attempts
  cannot be recovered and are not invented. Schema-3 active-session responses are
  converted to the event shape for resume and result calculation.
- Invalid or unknown schema-4 events are excluded from derived progress and kept
  in `unmappedAssessmentEvents` when the record is loaded, preventing a crash or
  an incorrect status.
- `aiml-interview-deck-migrations` records the migration version and last result.

Schema checks make every migration idempotent. Legacy ID lookup is confined to
the migration boundary; new progress and sessions use immutable IDs exclusively.

Answer reveal is intentionally transient UI state. Every newly rendered question
starts with its answer hidden; reveal state is not persisted.

## Known risks

- `index.html` is large because all 205 answers, equations, and diagrams are
  embedded with the application code.
- The checked-in browser regression suite covers content identity, session
  selection, result calculation, persistence migration, and corrupted storage.
  User-interface workflows still require the documented browser smoke test.
- Only one active/completed session record is retained locally. Assessment events
  survive across sessions, but session-history metadata and analytics remain out
  of scope.
- Live Google and email authentication require external Supabase, Google OAuth,
  redirect URL, and SMTP configuration. Fake-provider tests verify the code
  boundary, but cannot prove that project-owned external settings are correct.
- Browser-local history is unencrypted and visible to anyone with access to that
  browser profile. Owner buckets prevent accidental application-level mixing;
  they are not device access control.
- Same-ID conflicts are preserved safely and reported as a sync failure, but a
  user-facing export or resolution workflow is outside this iteration.
- Cross-device restoration and real network-failure recovery still require the
  controlled live validation planned for Iteration 7D.

## Recommended next structural step

Iteration 7D should validate configured Google and email sessions, refresh,
sign-out, anonymous import, account switching, offline retry, and cross-device
restore against the live Supabase project before production deployment. It should
not change the schema or synchronization semantics unless that validation finds a
concrete defect.

