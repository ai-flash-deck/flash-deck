(function (global) {
  "use strict";

  const LOCAL_SCHEMA_VERSION = 5;
  const DOMAIN_MIGRATION_VERSION = 4;
  const ANONYMOUS_OWNER = "anonymous";
  const ASSESSMENT_RESULTS = new Set(["known", "needs_review"]);

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isStoredAssessmentEvent(event) {
    return Boolean(event
      && typeof event.id === "string" && event.id
      && typeof event.questionId === "string" && event.questionId
      && (event.sessionId === null || event.sessionId === undefined || (typeof event.sessionId === "string" && event.sessionId))
      && ASSESSMENT_RESULTS.has(event.result)
      && typeof event.assessedAt === "string"
      && !Number.isNaN(Date.parse(event.assessedAt)));
  }

  function normalizeEvent(event) {
    if (!isStoredAssessmentEvent(event)) return null;
    return {
      id: event.id,
      questionId: event.questionId,
      sessionId: event.sessionId || null,
      result: event.result,
      assessedAt: event.assessedAt
    };
  }

  function compareAssessmentEvents(left, right) {
    const timeDifference = Date.parse(left?.assessedAt || "") - Date.parse(right?.assessedAt || "");
    if (timeDifference) return timeDifference;
    const leftId = typeof left?.id === "string" ? left.id : "";
    const rightId = typeof right?.id === "string" ? right.id : "";
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  }

  function sameEventPayload(left, right) {
    if (!isStoredAssessmentEvent(left) || !isStoredAssessmentEvent(right)) return false;
    return left.id === right.id
      && left.questionId === right.questionId
      && (left.sessionId || null) === (right.sessionId || null)
      && left.result === right.result
      && Date.parse(left.assessedAt) === Date.parse(right.assessedAt);
  }

  function createEmptyBucket() {
    return { assessmentEvents: [], pendingEventIds: [], conflicts: {} };
  }

  function createEmptyLocalState() {
    return {
      schemaVersion: LOCAL_SCHEMA_VERSION,
      domainMigrationVersion: DOMAIN_MIGRATION_VERSION,
      anonymous: { revision: 0, assessmentEvents: [], conflicts: {} },
      users: {},
      claimDecisions: {}
    };
  }

  function validateConflict(conflict) {
    return isObject(conflict)
      && conflict.reason === "same_id_different_payload"
      && conflict.status === "unresolved"
      && isStoredAssessmentEvent(conflict.localEvent)
      && isStoredAssessmentEvent(conflict.remoteEvent)
      && conflict.localEvent.id === conflict.remoteEvent.id
      && typeof conflict.detectedAt === "string"
      && !Number.isNaN(Date.parse(conflict.detectedAt));
  }

  function validateEventList(events) {
    if (!Array.isArray(events)) return false;
    const ids = new Set();
    return events.every(event => {
      if (!isStoredAssessmentEvent(event) || ids.has(event.id)) return false;
      ids.add(event.id);
      return true;
    });
  }

  function validateConflicts(conflicts) {
    return isObject(conflicts) && Object.entries(conflicts).every(([id, conflict]) => id && validateConflict(conflict) && conflict.localEvent.id === id);
  }

  function validateUserBucket(bucket) {
    if (!isObject(bucket) || !validateEventList(bucket.assessmentEvents) || !Array.isArray(bucket.pendingEventIds) || !validateConflicts(bucket.conflicts)) return false;
    const eventIds = new Set(bucket.assessmentEvents.map(event => event.id));
    const pendingIds = new Set();
    return bucket.pendingEventIds.every(id => typeof id === "string" && id && eventIds.has(id) && !pendingIds.has(id) && !bucket.conflicts[id] && (pendingIds.add(id) || true));
  }

  function validateLocalState(state) {
    if (!isObject(state) || state.schemaVersion !== LOCAL_SCHEMA_VERSION || state.domainMigrationVersion !== DOMAIN_MIGRATION_VERSION) return false;
    if (!isObject(state.anonymous) || !Number.isInteger(state.anonymous.revision) || state.anonymous.revision < 0
        || !validateEventList(state.anonymous.assessmentEvents) || !validateConflicts(state.anonymous.conflicts)) return false;
    if (!isObject(state.users) || !Object.entries(state.users).every(([id, bucket]) => id && validateUserBucket(bucket))) return false;
    if (!isObject(state.claimDecisions)) return false;
    return Object.entries(state.claimDecisions).every(([id, decision]) => id && isObject(decision)
      && [decision.declinedRevision, decision.importedRevision].filter(value => value !== undefined)
        .every(value => Number.isInteger(value) && value >= 0)
      && (decision.decidedAt === undefined || (typeof decision.decidedAt === "string" && !Number.isNaN(Date.parse(decision.decidedAt)))));
  }

  function deduplicateEvents(events) {
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    (Array.isArray(events) ? events : []).forEach(event => {
      const normalized = normalizeEvent(event);
      if (!normalized || seen.has(normalized.id)) {
        rejected.push(event);
        return;
      }
      seen.add(normalized.id);
      accepted.push(normalized);
    });
    return { accepted, rejected };
  }

  function buildSchema5FromSchema4(source) {
    if (!isObject(source) || source.schemaVersion !== 4 || !Array.isArray(source.assessmentEvents)) return null;
    const { accepted, rejected } = deduplicateEvents(source.assessmentEvents);
    const state = createEmptyLocalState();
    state.anonymous.revision = accepted.length ? 1 : 0;
    state.anonymous.assessmentEvents = accepted;
    if (source.questionIdMigrationVersion !== undefined) state.questionIdMigrationVersion = source.questionIdMigrationVersion;
    if (source.unmappedLegacyResponses !== undefined) state.unmappedLegacyResponses = clone(source.unmappedLegacyResponses);
    const preservedUnmapped = [
      ...(Array.isArray(source.unmappedAssessmentEvents) ? source.unmappedAssessmentEvents : []),
      ...rejected
    ];
    if (preservedUnmapped.length) state.unmappedAssessmentEvents = clone(preservedUnmapped);
    return state;
  }

  function safeParse(raw) {
    try { return { ok: true, value: JSON.parse(raw) }; }
    catch (_error) { return { ok: false, value: null }; }
  }

  function verifiedWrite(storage, key, value) {
    const raw = JSON.stringify(value);
    if (!storage.writeRaw(key, raw)) return false;
    const written = storage.readRaw(key);
    if (written !== raw) return false;
    const parsed = safeParse(written);
    return parsed.ok && validateLocalState(parsed.value);
  }

  function migrateSchema4To5({ storage, progressKey, stagingKey, sourceRecord = null }) {
    const sourceRaw = storage.readRaw(progressKey);
    if (sourceRaw === null) return { status: "not_found", state: createEmptyLocalState(), preserved: true };
    const parsed = safeParse(sourceRaw);
    if (parsed.ok && validateLocalState(parsed.value)) {
      storage.remove(stagingKey);
      return { status: "current", state: parsed.value, preserved: true };
    }
    const source = sourceRecord || (parsed.ok ? parsed.value : null);
    const candidate = buildSchema5FromSchema4(source);
    if (!candidate) return { status: "unsupported_or_malformed", state: null, preserved: true };

    if (!verifiedWrite(storage, stagingKey, candidate)) {
      return { status: "staging_write_failed", state: candidate, preserved: storage.readRaw(progressKey) === sourceRaw };
    }
    if (!verifiedWrite(storage, progressKey, candidate)) {
      return { status: "final_write_failed", state: candidate, preserved: storage.readRaw(stagingKey) === JSON.stringify(candidate) };
    }
    const finalRaw = storage.readRaw(progressKey);
    const finalParsed = finalRaw === null ? { ok: false } : safeParse(finalRaw);
    if (!finalParsed.ok || !validateLocalState(finalParsed.value)) {
      return { status: "final_verification_failed", state: candidate, preserved: storage.readRaw(stagingKey) === JSON.stringify(candidate) };
    }
    storage.remove(stagingKey);
    return { status: "migrated", state: finalParsed.value, preserved: true };
  }

  function createLocalAssessmentRepository({ storage, progressKey, initialState, isSyncEligibleEvent = isStoredAssessmentEvent, now = () => new Date().toISOString() }) {
    let state = validateLocalState(initialState) ? clone(initialState) : createEmptyLocalState();

    function persist(candidate) {
      if (!validateLocalState(candidate) || !verifiedWrite(storage, progressKey, candidate)) return false;
      state = candidate;
      return true;
    }

    function ensureUser(candidate, userId) {
      if (!candidate.users[userId]) candidate.users[userId] = createEmptyBucket();
      return candidate.users[userId];
    }

    function bucketFor(candidate, ownerKey, create = false) {
      if (ownerKey === ANONYMOUS_OWNER || ownerKey === null) return candidate.anonymous;
      return create ? ensureUser(candidate, ownerKey) : candidate.users[ownerKey] || createEmptyBucket();
    }

    function list(ownerKey) {
      return clone(bucketFor(state, ownerKey).assessmentEvents);
    }

    function append(ownerKey, event, { pending = false } = {}) {
      const normalized = normalizeEvent(event);
      if (!normalized || (ownerKey !== ANONYMOUS_OWNER && (typeof ownerKey !== "string" || !ownerKey))) return false;
      const candidate = clone(state);
      const bucket = bucketFor(candidate, ownerKey, true);
      if (bucket.assessmentEvents.some(existing => existing.id === normalized.id)) return false;
      bucket.assessmentEvents.push(normalized);
      if (ownerKey === ANONYMOUS_OWNER) bucket.revision++;
      else if (pending && isSyncEligibleEvent(normalized)) bucket.pendingEventIds.push(normalized.id);
      return persist(candidate);
    }

    function pending(userId) {
      const bucket = bucketFor(state, userId);
      const ids = new Set(bucket.pendingEventIds);
      return clone(bucket.assessmentEvents.filter(event => ids.has(event.id) && !bucket.conflicts[event.id] && isSyncEligibleEvent(event)));
    }

    function markSynced(userId, eventIds) {
      const candidate = clone(state);
      const bucket = ensureUser(candidate, userId);
      const completed = new Set(eventIds);
      bucket.pendingEventIds = bucket.pendingEventIds.filter(id => !completed.has(id));
      return persist(candidate);
    }

    function recordConflict(userId, localEvent, remoteEvent) {
      if (!sameEventPayload(localEvent, localEvent) || !sameEventPayload(remoteEvent, remoteEvent) || localEvent.id !== remoteEvent.id) return false;
      const candidate = clone(state);
      const bucket = ensureUser(candidate, userId);
      if (!bucket.conflicts[localEvent.id]) {
        bucket.conflicts[localEvent.id] = {
          reason: "same_id_different_payload",
          status: "unresolved",
          localEvent: normalizeEvent(localEvent),
          remoteEvent: normalizeEvent(remoteEvent),
          detectedAt: now()
        };
      }
      const index = bucket.assessmentEvents.findIndex(event => event.id === remoteEvent.id);
      if (index >= 0) bucket.assessmentEvents[index] = normalizeEvent(remoteEvent);
      else bucket.assessmentEvents.push(normalizeEvent(remoteEvent));
      bucket.pendingEventIds = bucket.pendingEventIds.filter(id => id !== localEvent.id);
      return persist(candidate);
    }

    function mergeRemote(userId, remoteEvents) {
      const candidate = clone(state);
      const bucket = ensureUser(candidate, userId);
      const byId = new Map(bucket.assessmentEvents.map(event => [event.id, event]));
      const summary = { ok: true, added: 0, matched: 0, conflicts: 0, invalid: 0 };
      (Array.isArray(remoteEvents) ? remoteEvents : []).forEach(remoteValue => {
        const remoteEvent = normalizeEvent(remoteValue);
        if (!remoteEvent) { summary.invalid++; return; }
        const localEvent = byId.get(remoteEvent.id);
        if (!localEvent) {
          bucket.assessmentEvents.push(remoteEvent);
          byId.set(remoteEvent.id, remoteEvent);
          summary.added++;
          return;
        }
        if (sameEventPayload(localEvent, remoteEvent)) {
          bucket.pendingEventIds = bucket.pendingEventIds.filter(id => id !== remoteEvent.id);
          summary.matched++;
          return;
        }
        if (!bucket.conflicts[remoteEvent.id]) {
          bucket.conflicts[remoteEvent.id] = {
            reason: "same_id_different_payload",
            status: "unresolved",
            localEvent: clone(localEvent),
            remoteEvent: clone(remoteEvent),
            detectedAt: now()
          };
        }
        const index = bucket.assessmentEvents.findIndex(event => event.id === remoteEvent.id);
        bucket.assessmentEvents[index] = remoteEvent;
        byId.set(remoteEvent.id, remoteEvent);
        bucket.pendingEventIds = bucket.pendingEventIds.filter(id => id !== remoteEvent.id);
        summary.conflicts++;
      });
      summary.ok = persist(candidate);
      return summary;
    }

    function shouldPromptClaim(userId) {
      if (!userId || !state.anonymous.assessmentEvents.some(isSyncEligibleEvent)) return false;
      const decision = state.claimDecisions[userId] || {};
      return decision.declinedRevision !== state.anonymous.revision && decision.importedRevision !== state.anonymous.revision;
    }

    function declineAnonymous(userId) {
      if (!userId) return false;
      const candidate = clone(state);
      candidate.claimDecisions[userId] = { declinedRevision: candidate.anonymous.revision, decidedAt: now() };
      return persist(candidate);
    }

    function claimAnonymous(userId, eventIds = null) {
      if (!userId) return { ok: false, claimed: 0, conflicts: 0 };
      const candidate = clone(state);
      const bucket = ensureUser(candidate, userId);
      const selected = eventIds ? new Set(eventIds) : null;
      let claimed = 0;
      let conflicts = 0;
      candidate.anonymous.assessmentEvents.forEach(event => {
        if ((selected && !selected.has(event.id)) || !isSyncEligibleEvent(event)) return;
        const current = bucket.assessmentEvents.find(existing => existing.id === event.id);
        if (!current) {
          bucket.assessmentEvents.push(clone(event));
          if (!bucket.pendingEventIds.includes(event.id)) bucket.pendingEventIds.push(event.id);
          claimed++;
        } else if (!sameEventPayload(current, event)) {
          if (!bucket.conflicts[event.id]) {
            bucket.conflicts[event.id] = {
              reason: "same_id_different_payload",
              status: "unresolved",
              localEvent: clone(event),
              remoteEvent: clone(current),
              detectedAt: now()
            };
          }
          bucket.pendingEventIds = bucket.pendingEventIds.filter(id => id !== event.id);
          conflicts++;
        }
      });
      candidate.claimDecisions[userId] = { importedRevision: candidate.anonymous.revision, decidedAt: now() };
      const ok = persist(candidate);
      return { ok, claimed: ok ? claimed : 0, conflicts: ok ? conflicts : 0 };
    }

    function conflictCount(userId) {
      return Object.keys(bucketFor(state, userId).conflicts || {}).length;
    }

    return Object.freeze({
      list,
      append,
      pending,
      markSynced,
      recordConflict,
      mergeRemote,
      shouldPromptClaim,
      declineAnonymous,
      claimAnonymous,
      conflictCount,
      snapshot: () => clone(state)
    });
  }

  function createSyncCoordinator({ localRepository, remoteRepository, onStatus = () => {}, onHistoryChanged = () => {} }) {
    let activeUserId = null;
    let generation = 0;
    let syncFlight = null;
    let restoreFlight = null;

    function isCurrent(userId, capturedGeneration) {
      return Boolean(userId) && activeUserId === userId && generation === capturedGeneration;
    }

    function activate(userId) {
      activeUserId = userId || null;
      generation++;
      syncFlight = null;
      restoreFlight = null;
      onStatus(activeUserId ? "loading" : "idle");
      return generation;
    }

    async function syncPending(userId = activeUserId) {
      if (!userId || userId !== activeUserId) return { status: "stale", attempted: 0 };
      if (syncFlight) return syncFlight;
      const capturedGeneration = generation;
      syncFlight = (async () => {
        const events = localRepository.pending(userId);
        if (!events.length) {
          const conflicts = localRepository.conflictCount(userId);
          onStatus(conflicts ? "failed" : "saved");
          return { status: conflicts ? "conflict" : "saved", attempted: 0, failed: 0, conflicts };
        }
        onStatus("saving");
        let failed = 0;
        let conflicts = 0;
        let completed = 0;
        for (const event of events) {
          const result = await remoteRepository.insertOwnEvent(event);
          if (!isCurrent(userId, capturedGeneration)) return { status: "stale", attempted: completed + failed + conflicts };
          if (result.status === "inserted" || result.status === "already_present") {
            if (!localRepository.markSynced(userId, [event.id])) { failed++; continue; }
            completed++;
          } else if (result.status === "conflict" && result.remoteEvent) {
            if (!localRepository.recordConflict(userId, event, result.remoteEvent)) failed++;
            else conflicts++;
          } else {
            failed++;
          }
        }
        if (isCurrent(userId, capturedGeneration)) {
          onHistoryChanged(userId);
          onStatus(failed ? "waiting" : conflicts || localRepository.conflictCount(userId) ? "failed" : "saved");
        }
        return { status: failed ? "waiting" : conflicts ? "conflict" : "saved", attempted: events.length, completed, failed, conflicts };
      })();
      try { return await syncFlight; }
      finally { if (isCurrent(userId, capturedGeneration)) syncFlight = null; }
    }

    async function restoreForUser(userId) {
      if (!userId || userId !== activeUserId) return { status: "stale" };
      if (restoreFlight) return restoreFlight;
      const capturedGeneration = generation;
      restoreFlight = (async () => {
        onStatus("loading");
        const loaded = await remoteRepository.loadOwnEvents();
        if (!isCurrent(userId, capturedGeneration)) return { status: "stale" };
        if (loaded.status !== "loaded") {
          onStatus(localRepository.pending(userId).length ? "waiting" : "failed");
          return { status: "failed", errorCode: loaded.errorCode };
        }
        const merged = localRepository.mergeRemote(userId, loaded.events);
        if (!merged.ok) {
          onStatus("failed");
          return { status: "failed", errorCode: "local_write_failed" };
        }
        onHistoryChanged(userId);
        const synchronized = await syncPending(userId);
        return { status: synchronized.status, merged, synchronized };
      })();
      try { return await restoreFlight; }
      finally { if (isCurrent(userId, capturedGeneration)) restoreFlight = null; }
    }

    async function claimAndSyncAnonymous(userId, eventIds = null) {
      if (!userId || userId !== activeUserId) return { status: "stale" };
      const claimed = localRepository.claimAnonymous(userId, eventIds);
      if (!claimed.ok) {
        onStatus("failed");
        return { status: "failed", errorCode: "local_write_failed" };
      }
      onHistoryChanged(userId);
      const synchronized = await syncPending(userId);
      return { status: synchronized.status, claimed, synchronized };
    }

    return Object.freeze({
      activate,
      restoreForUser,
      syncPending,
      claimAndSyncAnonymous,
      getActiveUserId: () => activeUserId,
      getGeneration: () => generation
    });
  }

  global.AIMLLearningSync = Object.freeze({
    LOCAL_SCHEMA_VERSION,
    DOMAIN_MIGRATION_VERSION,
    ANONYMOUS_OWNER,
    isStoredAssessmentEvent,
    normalizeEvent,
    compareAssessmentEvents,
    sameEventPayload,
    createEmptyLocalState,
    validateLocalState,
    buildSchema5FromSchema4,
    migrateSchema4To5,
    createLocalAssessmentRepository,
    createSyncCoordinator
  });
})(window);
