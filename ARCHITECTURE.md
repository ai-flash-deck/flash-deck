# AI/ML Interview Deck architecture

## Current application

The deck is a dependency-free Progressive Web App. There is no framework, router,
package manager, build step, or third-party test runner. `index.html` contains the
HTML, CSS, question content, UI rendering, study-session logic, and browser
persistence integration. `sw.js` provides offline caching, while `manifest.json`
and `icons/` provide installable-PWA metadata and assets.

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
- **Progress:** durable events in `progress.assessmentEvents`, derived question
  progress, and active-session response snapshots in `session.responses`.
- **Identity:** represented only by the nullable `userId` field. Authentication is
  intentionally absent.
- **Persistence:** `storageRepository`, plus progress/session validation and schema
  version checks.
- **UI:** DOM references, card rendering, view transitions, and event handlers.

JSDoc types in `index.html` document `Topic`, `Question`, `AssessmentEvent`,
`DerivedQuestionProgress`, `ProgressState`, and `StudySession` without adding a
compiler or dependency.

## State and persistence

Two versioned JSON documents are stored in browser `localStorage`:

- `aiml-interview-deck-progress`: durable assessment-event history.
- `aiml-interview-deck-session`: the current or most recently completed session,
  including ordered card IDs, position, assessments, topic, and status.

All browser-storage access goes through `storageRepository`. This boundary can
later be supplemented or replaced by a remote repository without coupling an
authentication client to card rendering.

Both documents use persistence schema version 4. All normal question references
are immutable IDs stored directly on the card, using `q_0001` through `q_0205`.
These IDs do not depend on content, category labels, or array order and are
suitable for future database references.

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
event timestamps. With 205 questions, deriving these values on demand keeps the
source of truth unambiguous and is inexpensive.

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

### Legacy question-ID migration

Persistence schema version 1 used hashes derived from category and question text.
`LEGACY_QUESTION_ID_MAP` is a frozen 205-entry compatibility map generated from
the unchanged pre-migration content. Domain migration version 3 runs before
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

Schema checks make the migration idempotent: schema-v4 records are recognized as
current and are not transformed again. Legacy ID lookup is confined to this
migration boundary; new progress and sessions use immutable IDs exclusively.

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

## Recommended next structural step

Before introducing remote persistence, define how locally generated event IDs and
conflicting offline histories merge across devices. Authentication should remain
above the persistence boundary so `makeCard` remains unaware of the provider.

