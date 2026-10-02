# AI/ML Interview Deck architecture

## Current application

The deck is a dependency-free Progressive Web App. There is no framework, router,
package manager, build step, or automated test runner. `index.html` contains the
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

- **Content:** `CARDS`, `CAT_ORDER`, `catClass`, and `cardId`.
- **Study:** `SESSION_TYPES`, session selection, creation, navigation, and summary
  calculation helpers.
- **Progress:** assessment records in `progress.responses` and active-session
  responses in `session.responses`.
- **Identity:** represented only by the nullable `userId` field. Authentication is
  intentionally absent.
- **Persistence:** `storageRepository`, plus progress/session validation and schema
  version checks.
- **UI:** DOM references, card rendering, view transitions, and event handlers.

JSDoc types in `index.html` document `Question`, `AssessmentRecord`,
`ProgressState`, and `StudySession` without adding a compiler or dependency.

## State and persistence

Two versioned JSON documents are stored in browser `localStorage`:

- `aiml-interview-deck-progress`: the latest assessment for each question.
- `aiml-interview-deck-session`: the current or most recently completed session,
  including ordered card IDs, position, assessments, topic, and status.

All browser-storage access goes through `storageRepository`. This boundary can
later be supplemented or replaced by a remote repository without coupling an
authentication client to card rendering.

Both documents use persistence schema version 2. All normal question references
are immutable IDs stored directly on the card, using `q_0001` through `q_0205`.
These IDs do not depend on content, category labels, or array order and are
suitable for future database references.

### Legacy question-ID migration

Persistence schema version 1 used hashes derived from category and question text.
`LEGACY_QUESTION_ID_MAP` is a frozen 205-entry compatibility map generated from
the unchanged pre-migration content. Migration version 1 runs before progress or
session state is loaded:

- Progress response keys are changed to immutable IDs. When legacy and immutable
  records target the same question, the newest `updatedAt` record wins, with an
  immutable-keyed record winning a timestamp tie.
- Unknown progress references are retained in `unmappedLegacyResponses` and
  reported in the console rather than discarded.
- Session `cardIds` and response keys are migrated together. If any reference is
  unknown or the mapping would create duplicate ordered cards, the original v1
  session is left untouched and the problem is reported.
- `aiml-interview-deck-migrations` records the migration version and last result.

Schema checks make the migration idempotent: schema-v2 records are recognized as
current and are not transformed again. Legacy ID lookup is confined to this
migration boundary; new progress and sessions use immutable IDs exclusively.

Answer reveal is intentionally transient UI state. Every newly rendered question
starts with its answer hidden; reveal state is not persisted.

## Known risks

- `index.html` is large because all 205 answers, equations, and diagrams are
  embedded with the application code.
- The test coverage is browser-driven validation rather than a checked-in
  automated suite.
- Only one active/completed session is retained locally. Historical analytics are
  intentionally out of scope.
- Weak-area practice uses the most recently completed session rather than a full
  cross-session history.
- Topic identity still uses display strings. Question identity was the priority
  for this migration; stable topic IDs should be introduced before remotely
  persisting topic-level statistics.

## Recommended next structural step

Add focused automated coverage for immutable-ID uniqueness, persistence migration,
session selection, and result calculation before introducing remote persistence.
Authentication should be introduced above the persistence boundary: resolve a
user identity, choose local or remote repositories, and keep `makeCard` unaware of
the authentication provider.

