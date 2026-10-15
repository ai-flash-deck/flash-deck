# Iteration 7A: cloud learning-history design

Status: approved and implemented through Iteration 7C. The SQL migration was
applied and its RLS behavior was verified in Iteration 7B. Schema-5 local
persistence, the remote repository, and synchronization coordination were
implemented in Iteration 7C. Production and cross-device verification remain for
Iteration 7D.

## Current architecture findings

The application is a dependency-free static PWA. `index.html` owns content,
study logic, progress selectors, and local persistence; `auth-service.js` owns
the Supabase Auth boundary; and `sw.js` caches only same-origin application
assets. Supabase network traffic is not service-worker cached.

The inspected implementation matches the stated baseline:

- 205 cards use unique immutable IDs `q_0001` through `q_0205`.
- Five stable topic IDs are authoritative: `ml_foundations`,
  `probability_stats`, `deep_learning`, `transformers_llms`, and
  `reinforcement_learning`.
- Local progress is schema 4/domain migration 3 at
  `aiml-interview-deck-progress`; the active or last session is a separate
  schema-4 record at `aiml-interview-deck-session`.
- `storageRepository` is the only direct `localStorage` boundary.
- `assessmentHistoryRepository.append` validates an event, rejects a duplicate
  ID, appends it to `progress.assessmentEvents`, and rolls back the in-memory
  append if the local write fails.
- `createAssessmentEvent` creates `{ id, questionId, sessionId, result,
  assessedAt }`. New IDs are `assessment_<random UUID>` when supported, with a
  timestamp/random fallback. Legacy migrations create deterministic IDs such as
  `migrated_progress_q_0001` and preserve their original timestamps.
- `deriveQuestionProgress`, overall progress, topic progress, and Weak Areas all
  derive from valid assessment events. No derived counters or weak list are
  persisted.
- `auth-service.js` exposes provider-neutral state and identity
  `{ userId, email?, displayName? }`. Sign-in and sign-out currently neither
  claim, partition, delete, nor synchronize learning history.
- The current persistence format has no durable pending-sync state and no safe
  per-account partition. Its unused top-level `userId` is not enough to assign
  ownership to individual events.

The principal migration risk is ownership ambiguity. Schema-4 data may be
anonymous practice, or it may have been produced while any previously signed-in
person used the browser. It must not be silently assigned to the next account.
Another risk is equal assessment timestamps: the current selector depends on
input order for a tie, but local/cloud merging needs an explicit tie-breaker.

## Proposed remote table

Use one table, `public.assessment_events`, containing only source events:

| Column | PostgreSQL type | Rule |
| --- | --- | --- |
| `user_id` | `uuid` | Required; defaults to `auth.uid()`; foreign key to `auth.users(id)` with account-deletion cascade |
| `id` | `text` | Required, non-empty; existing local event ID |
| `question_id` | `text` | Required, non-empty; application-owned immutable question ID |
| `session_id` | `text` | Nullable; originating local session ID |
| `result` | `text` | Required; check constrained to `known` or `needs_review` |
| `assessed_at` | `timestamptz` | Required; original assessment instant |

The composite primary key is `(user_id, id)`. UUID-based event IDs are globally
safe, but deterministic legacy IDs can be identical for two users. Scoping the
key by user preserves every existing ID while making retries idempotent for the
correct owner. Different assessments of one question have different event IDs
and remain separate rows. There is no unique constraint on question or session.

`timestamptz` preserves the assessment instant, although PostgreSQL may return a
different equivalent UTC string representation. Upload never substitutes the
current time. Question and answer content remain in the application. The table
does not contain status, counters, Known %, Weak Areas, card content, or active
sessions.

Generated and migrated IDs in the repository fit PostgreSQL `text` directly.
The current local validator technically accepts an arbitrarily long non-empty
ID; a pathologically oversized, manually altered ID could exceed PostgreSQL
index-entry limits. Iteration 7B should preserve such a record locally as
unmappable rather than rewrite its identity.

The proposed, unapplied migration is:

`supabase/migrations/202610140001_create_assessment_events.sql`

## Database access and RLS

The migration explicitly enables and forces RLS. It revokes all table privileges
from `PUBLIC`, `anon`, and `authenticated`, then gives `authenticated` only:

- schema `USAGE`;
- table `SELECT`;
- column-level `INSERT` for `id`, `question_id`, `session_id`, `result`, and
  `assessed_at`.

The browser cannot insert `user_id`; PostgreSQL supplies `auth.uid()`. The
Iteration 7B repository must omit `user_id` and use a one-row array insert with
`{ defaultToNull: false }`. In the pinned Supabase/PostgREST client this sends
`Prefer: missing=default`, so the omitted non-null column evaluates its database
default instead of becoming `null`:

```js
client.from("assessment_events").insert([{
  id: event.id,
  question_id: event.questionId,
  session_id: event.sessionId,
  result: event.result,
  assessed_at: event.assessedAt
}], { defaultToNull: false });
```

Column-level INSERT permission excludes `user_id`, so a payload that names it is
rejected before it can assign ownership. The RLS INSERT policy independently
requires a non-null `auth.uid()` equal to the resulting `user_id`. The SELECT
policy has the same explicit non-null ownership check. There are no client UPDATE
or DELETE grants or policies, so those operations are denied even for an owned
row. `anon` has no table privileges. The service-role key is neither required nor
permitted in frontend code.

This matches current platform behavior: `public` is an exposed Data API schema,
but projects with automatic exposure disabled require an explicit table grant.
The migration's SELECT and column-level INSERT grants opt in only this table and
only these operations. Schema `USAGE` alone exposes no rows. Supabase documents
the independent grant and RLS layers in its [RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security),
the new explicit-grant behavior in its [Data API exposure change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically),
and column restrictions in its [column-level security guide](https://supabase.com/docs/guides/database/postgres/column-level-security).

One index supplements the composite primary key: `(user_id, assessed_at, id)`
supports loading a user's complete ordered history. The application loads that
history once and derives per-question progress locally, so a second
question-specific database index would add write/storage cost without serving a
current query. RLS, rather than frontend filtering, enforces isolation.

### Migration preflight and Data API exposure

Before applying the migration, run this read-only query in the Supabase SQL
Editor for project reference `qgrkhsxzzuyiddglvhkb`:

```sql
select to_regclass('public.assessment_events') as existing_relation;
```

If it returns `null`, the table does not exist and the reviewed migration can be
run after explicit approval. If it returns `assessment_events`, stop before
running `CREATE TABLE` and inspect the existing object instead:

```sql
select c.relname, pg_get_userbyid(c.relowner) as owner,
       c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'assessment_events';

select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'assessment_events'
order by ordinal_position;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.assessment_events'::regclass
order by conname;

select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'assessment_events'
order by indexname;
```

The table should be owned by the privileged migration role (`postgres` when run
through the Supabase SQL Editor), never by `anon` or `authenticated`. The
migration contains no owner change because the creating privileged role already
owns the new table.

The live anonymous Data API currently returns `404 PGRST205` for this table. That
means it is not in the accessible `public` schema cache, but with automatic table
exposure disabled this alone cannot distinguish an absent table from an existing
ungranted one; the `to_regclass` query is authoritative. `public` must remain in
**Project Settings → Data API → Exposed schemas**. No additional schema should be
exposed. Automatic exposure of new tables can remain disabled because this
migration explicitly grants SELECT and column-limited INSERT to `authenticated`.

After a successful migration, refresh the schema cache if the project does not
recognize the table promptly, then run the grant/policy audits and two-user tests
below. Do not disable RLS or enable automatic exposure as a workaround.

### Practical two-user RLS verification

Run this only after the reviewed migration is applied in Iteration 7B. Use two
separate browser profiles signed in as disposable User A and User B. In each
profile create a Supabase client with the public project URL and publishable key;
never print or copy its session tokens. Let `clientA` and `clientB` denote those
separately authenticated clients and let `anonClient` have no restored session.

Use one payload in both authenticated profiles:

```js
const testEvent = {
  id: "rls_verification_same_id",
  question_id: "q_0001",
  session_id: "rls_verification",
  result: "known",
  assessed_at: "2026-10-14T12:00:00.000Z"
};
const insertResult = await clientA
  .from("assessment_events")
  .insert([testEvent], { defaultToNull: false })
  .select();
```

Perform and record these checks without logging credentials:

| Check | Expected result |
| --- | --- |
| A inserts `testEvent` without `user_id` | Success; returned `user_id` is A |
| B inserts the same `id` without `user_id` | Success; returned `user_id` is B |
| A and B each run `.select("*")` | Each sees only their own rows |
| B runs `.select("*").eq("user_id", A_ID)` | Empty data, no A row |
| B inserts `{ ...testEvent, user_id: A_ID }` | Rejected, normally SQLSTATE `42501` |
| A updates its own row | Rejected because UPDATE is not granted/policy-backed |
| A deletes its own row | Rejected because DELETE is not granted/policy-backed |
| B updates or deletes A's row | Rejected; no privilege and no cross-user policy |
| Anonymous client selects | Rejected, normally `42501` |
| Anonymous client inserts | Rejected, normally `42501` |
| A repeats its identical insert | Primary-key conflict; repository verifies existing payload as idempotent |
| A repeats the ID with a changed payload | Primary-key conflict; original remote row remains unchanged |
| A inserts `result: "invalid"` under a new test ID | Rejected by the result check constraint, normally `23514` |

Also audit the database from the SQL editor:

```sql
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'assessment_events'
order by grantee, privilege_type;

select grantee, privilege_type, column_name
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'assessment_events'
order by grantee, privilege_type, column_name;

select relrowsecurity, relforcerowsecurity
from pg_class
where oid = 'public.assessment_events'::regclass;

select policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'assessment_events'
order by policyname;
```

Expected grants are authenticated SELECT plus INSERT on the five event payload
columns. No `anon`, authenticated UPDATE, or authenticated DELETE grant should
appear. Both RLS flags must be true and only the own-row SELECT and INSERT
policies should exist.

## Event identity, retries, and conflicts

Remote identity is `(authenticated user ID, existing event ID)`. Iteration 7B
must not generate a new ID or timestamp while uploading.

A retry follows this contract:

1. Insert the immutable row without a client-supplied `user_id`.
2. On success, mark the local event synchronized.
3. On a primary-key conflict, read the existing own row by `id`.
4. Compare `questionId`, normalized nullable `sessionId`, canonical `result`, and
   the timestamp instant.
5. Treat an exact match as successful idempotency.
6. If payloads differ, first persist an unresolved conflict record containing
   both complete payloads. Use the remote row in active merged history, but never
   mark the local payload synchronized or discard it.

Blind upsert is intentionally avoided because it could silently change immutable
history or hide an ID collision.

Conflicts live in the same durable owner bucket, keyed by event ID:

```text
conflicts: {
  "<event ID>": {
    reason: "same_id_different_payload",
    status: "unresolved",
    localEvent: { ...original local event... },
    remoteEvent: { ...existing remote event... },
    detectedAt: "<ISO timestamp>"
  }
}
```

The local event moves from ordinary pending delivery to unresolved conflict only
after the updated owner bucket is written successfully. This avoids futile retry
loops while remaining clearly different from synchronization success. Repeated
conflict detection reuses the existing record rather than replacing its original
local payload or detection time. Recovery can later export the local payload or,
after an explicit resolution decision, create a new event with a new ID. No new
ID is generated automatically during synchronization.

## Proposed local ownership format

Iteration 7B should introduce local schema 5 as an account-partitioned envelope.
The event itself remains unchanged:

```text
{
  schemaVersion: 5,
  domainMigrationVersion: 4,
  anonymous: { revision, assessmentEvents, conflicts },
  users: {
    "<Supabase user UUID>": { assessmentEvents, pendingEventIds, conflicts }
  },
  claimDecisions: {
    "<Supabase user UUID>": { declinedRevision? | importedRevision?, decidedAt }
  },
  unmappedLegacyResponses?,
  unmappedAssessmentEvents?
}
```

`pendingEventIds` is delivery state, not another learning source. Progress and
Weak Areas always receive one active owner's `assessmentEvents`. A remote event
merged into a user bucket remains cached locally; successful upload removes only
its pending marker, never the event.

On schema-4 migration, validated existing events enter the anonymous/unclaimed
bucket. Unmapped legacy data remains preserved outside derived progress exactly
as it is now. The migration advances persistence schema 4 to 5 and domain
migration 3 to 4. It uses this two-phase procedure:

1. Read and retain the exact schema-4 source string. If JSON parsing or structural
   validation fails, report the problem and leave the source key untouched.
2. Construct schema 5 entirely in memory. Valid events retain their complete
   payloads, IDs, array order, and timestamps. Duplicate IDs use the existing
   deterministic first-valid-record rule; rejected data remains in the existing
   unmapped collections.
3. Write the candidate to the separate
   `aiml-interview-deck-progress-v5-staging` key, then read it back, parse it,
   and validate event counts, IDs, timestamps, unmapped collections, schema 5,
   and domain migration 4.
4. Only after staging validation succeeds, replace the normal progress key using
   one `localStorage.setItem`. `setItem` replacement is atomic from application
   code's perspective: failure leaves the old schema-4 value unchanged.
5. Read back and validate the normal key before changing in-memory application
   state or writing the migration-complete report.
6. Remove staging only after final validation. If interruption occurs after the
   final write, the schema-5 record is recognized as complete and staging cleanup
   is safe on retry.

Interruption before staging leaves schema 4; interruption after staging leaves
schema 4 plus a recoverable candidate; interruption after the final write leaves
a complete schema-5 source. A valid schema-5 record is a no-op on subsequent
runs. If storage quota prevents staging or final replacement, the existing source
remains active and migration retries later. The migration never clears or mutates
the in-memory schema-4 history before a verified final write.

### Anonymous-to-account claim

Because legacy ownership cannot be inferred, sign-in must not automatically give
the anonymous bucket to that account. When unclaimed events exist, show a small
confirmation such as “Add the practice history saved on this browser to this
account?” The proposed algorithm is:

1. Restore the authenticated identity and its existing user bucket.
2. Load remote history for that user without changing anonymous history.
3. If the user accepts the claim, create one new schema-5 document in memory:
   copy anonymous events into that user's bucket by event ID, mark newly copied
   eligible IDs pending, keep the anonymous bucket unchanged, and record the
   account's `importedRevision`. Persist this complete document with one
   `localStorage.setItem`.
4. Only after that durable local write succeeds, attempt remote synchronization.
   The event still exists locally in the user bucket, so interruption cannot lose
   it even though its ownership moved.
5. Exact duplicate IDs are deduplicated. A same-ID/different-payload collision is
   preserved as a conflict and is not automatically uploaded.
6. Failed or partial uploads leave their IDs pending. Confirmed rows lose only
   their pending markers.
7. Declining leaves anonymous data separate and unchanged. It writes only
   `claimDecisions[userId]` with the current anonymous `revision`.

This process can be retried after refresh without duplicating remote rows. It
never invents historical events or deletes the only local copy.

The claim prompt appears only when anonymous events exist and their current
`revision` differs from both that user's persisted `declinedRevision` and
`importedRevision`. Either decision is therefore remembered across refreshes and
later sign-ins. Adding a new anonymous event increments `revision`, allowing a
future prompt about newly changed browser history. Neither decision removes,
hides, or silently reassigns anonymous events.

### Account switching

- Anonymous assessments go only to the anonymous bucket.
- Authenticated assessments go only to the current user's bucket and are marked
  pending before any network request.
- Sign-out retains the signed-in user's bucket on disk but switches selectors to
  the anonymous bucket. It must not expose that user's history to a later user.
- User B loads only User B's local bucket plus rows allowed by User B's RLS token.
  User A's bucket remains present but inactive.
- Every repository and coordinator call takes an explicit owner ID captured from
  the current auth identity. It may read or modify only that matching bucket.
  Pending IDs are stored inside the same bucket, so User B can never upload User
  A's pending events.
- Sign-out or account change invalidates the current synchronization generation.
  A request already sent for A may complete under A's server session, but its
  result can update only A's named bucket and cannot render into anonymous or B
  state.
- Anonymous history is offered for claim, never silently assigned. This explicit
  choice is necessary on a shared browser because ownership is otherwise
  unknowable.

## Local/cloud merge rules

Merging operates within one user bucket only:

1. Validate event shape and canonical result. Known cards are eligible for
   progress; unknown/unmapped question IDs remain preserved but excluded from
   selectors and automatic upload until the content recognizes them.
2. Key by event ID, not question ID. Multiple attempts at one question remain.
3. Local-only eligible events remain local and pending.
4. Remote-only events are added to the local user cache as synchronized.
5. Identical IDs and payloads become one event.
6. Conflicting payloads with one ID use the immutable remote row for active
   progress. Before replacing the active copy, atomically preserve the local
   payload and remote payload as an unresolved conflict. Remove its normal
   pending marker only as part of that successful conflict write; never classify
   it as synchronized.
7. Compare `assessedAt` as an instant. For equal valid timestamps, the
   lexicographically greater event ID is later. This makes current-status
   derivation deterministic across browsers without changing normal timestamped
   behavior.

The merged event array feeds the existing `deriveQuestionProgress`,
`deriveOverallProgress`, topic progress, and `getWeakQuestions` selectors. No new
progress rules or persisted counters are introduced. Verification found that the
current `deriveQuestionProgress` sort compares timestamps only, so equal-time
results still depend on input order today. Iteration 7B must add one shared
`compareAssessmentEvents` helper that compares parsed timestamp and then event ID,
and `deriveQuestionProgress` must use it. Overall Progress, topic Progress, and
Weak Areas already call `deriveQuestionProgress`, so this single production
boundary makes all selectors deterministic. Tests must run the same equal-time
events in opposite input orders and assert identical current status and weak-set
results.

## Offline and retry behavior

Every assessment follows local-first durability:

1. Create the event once.
2. Append it to the correct local owner bucket and persist its pending ID.
3. Update the study UI from local history.
4. If authenticated and online, ask the synchronization coordinator to send it.
5. Remove the pending marker only after insert success or verification of an
   identical existing remote row.

Retries occur on app load after authentication restoration, successful sign-in,
the browser `online` event, and a later assessment. A single-flight guard prevents
overlapping syncs. There is no polling loop. Provider/network errors retain all
events and pending markers and leave anonymous study operational.

## Loading and restoration

For an authenticated user:

1. Restore auth through the existing `authService`.
2. Select the local bucket for `identity.userId`.
3. Start a remote load for that authenticated account.
4. Reconcile remote rows with that user's local events and persist the merge.
5. Retry pending rows.
6. Re-run the existing Progress and Weak Areas render path with the merged list.

While remote history loads, local practice can continue. A failed remote load is
a degraded/unknown cloud state, not an empty history: it must not clear local
events, mark them synchronized, or replace progress with zero. The UI may show a
small sync-status message, but authentication and study remain usable. A later
retry re-renders progress without requiring a page reload.

## Repository design for Iteration 7B

Keep three boundaries:

### Owner-aware local assessment repository

Evolves the existing repository and remains the only learning `localStorage`
caller.

```text
list(ownerKey) -> AssessmentEvent[]
append(ownerKey, event, { pending }) -> boolean
pending(userId) -> AssessmentEvent[]
markSynced(userId, eventIds) -> boolean
recordConflict(userId, conflict) -> boolean
claimAnonymous(userId, eventIds) -> ClaimResult
```

### Supabase assessment repository

A small new `remote-assessment-repository.js` wraps all table queries and maps
snake_case rows to the existing camelCase event model.

```text
loadOwnEvents() -> Promise<AssessmentEvent[]>
insertOwnEvent(event) -> Promise<"inserted" | "already_present">
findOwnEvent(id) -> Promise<AssessmentEvent | null>
```

It omits `user_id`, inserts a one-row array with `defaultToNull: false`, and relies
on the database default plus RLS. It does not expose update/delete. The shared
Supabase client should be created in a small composition boundary and passed
separately to `authService` and this repository; card/UI code never issues
Supabase queries.

### Synchronization coordinator

```text
restoreForUser(userId) -> Promise<SyncResult>
syncPending(userId) -> Promise<SyncResult>
claimAndSyncAnonymous(userId, eventIds) -> Promise<SyncResult>
```

It owns merge, retry, single-flight, and status notification. It obtains the
current identity from the existing auth boundary and never alters active-session
persistence. The study engine only appends locally and optionally signals that
sync work is available.

## Test strategy

Ordinary tests remain offline and use production functions with fake local and
remote repositories. Add coverage for:

- snake_case/camelCase remote serialization and timestamp preservation;
- remote insert and load;
- exact duplicate success and conflicting-ID quarantine, including proof that a
  conflict is durable, unresolved, not pending, not synchronized, and recoverable;
- schema-4 to schema-5 migration, staging/final write failures, interruption at
  every phase, source preservation, and repeat-run idempotency;
- explicit anonymous claim and decline, persisted decline suppression for the
  same anonymous revision, a new-revision prompt, refresh interruption, and
  partial upload;
- persisted pending rows and every retry trigger with a single-flight guard;
- User A/User B/anonymous bucket isolation and sign-out switching;
- local-only, remote-only, and mixed merge ordering, including reversed arrays of
  equal-timestamp events producing identical Progress and Weak Areas results;
- offline assessment durability and recovery;
- malformed events, unknown questions, oversized/unrepresentable IDs, and remote
  failures;
- auth restoration before remote loading;
- unchanged Progress, Weak Areas, session results, and local active session.

Live Supabase is reserved for a separate manual RLS check with two disposable
accounts:

1. Sign in Client A and Client B separately with the publishable key.
2. Let each insert the same event ID; both should succeed because the primary key
   is user-scoped.
3. Verify each client selects only its own row.
4. From B, filter for A's UUID; the result must be empty.
5. Attempt to insert with a supplied `user_id`; column permissions must reject it.
6. Attempt UPDATE and DELETE as either user; privileges/policies must reject them.
7. Attempt anonymous SELECT and INSERT; both must be rejected.
8. Repeat A's same insert: the repository must verify the matching duplicate as
   idempotent. Repeat with different payload under the same ID: it must report a
   conflict and leave the original row unchanged.
9. Clean up only from the Supabase dashboard/admin context. Never expose an admin
   or service-role credential to the browser, source, test output, or logs.

## Security risks and controls

- RLS and restricted grants are the real isolation control; frontend filters are
  presentation only.
- Browser local history is unencrypted and visible to anyone with that browser
  profile. Owner buckets prevent accidental app-level mixing but are not device
  access control.
- XSS could access the Supabase session and local history. Continue avoiding
  untrusted HTML and consider a Content Security Policy separately.
- Client clocks can be wrong. Original assessment time is intentionally retained;
  deterministic ID tie-breaking prevents device ordering ambiguity but does not
  establish trusted time.
- Same-ID/different-payload conflicts must be surfaced and retained, never solved
  by overwrite.
- `on delete cascade` removes cloud history when an Auth user is administratively
  deleted. Local browser copies require a later explicit account-data policy.
- The publishable key is browser-safe. Service-role keys, secret keys, database
  credentials, OAuth client secrets, and access/refresh tokens must never be
  committed or logged.

## Iteration 7B implementation sequence

1. Approve this schema, RLS, ownership model, conflict rule, and claim behavior.
2. Apply the reviewed SQL manually to the intended Supabase project and perform
   the two-account RLS verification.
3. Implement and test schema-5 owner buckets and the idempotent schema-4 migration.
4. Add the Supabase remote repository and synchronization coordinator.
5. Wire auth restoration/sign-in/sign-out and local assessment append to the
   coordinator without changing the study engine.
6. Add the minimal claim and sync-status UI; preserve anonymous operation.
7. Run the full offline suite and manual multi-browser, offline, and account-switch
   tests before any deployment.

Remote active sessions, cross-device unfinished-session resume, profiles, and all
Iteration 8 work remain excluded.

## Decisions requiring approval

1. Approve the one-table schema and composite `(user_id, id)` primary key.
2. Approve immutable events: browser clients receive SELECT and column-limited
   INSERT only, with no UPDATE or DELETE.
3. Approve schema-5 account buckets and switching to the anonymous bucket on
   sign-out while retaining each user's local bucket on disk.
4. Approve an explicit claim prompt before moving anonymous/legacy history into
   an authenticated account.
5. Approve the same-ID conflict rule: use the remote row for active progress,
   preserve the local row in conflicts, and never overwrite automatically.
6. Approve event-ID lexical ordering as the tie-breaker for identical assessment
   timestamps.
7. Approve account-deletion cascade for cloud assessment events.
