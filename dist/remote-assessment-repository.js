(function (global) {
  "use strict";

  const TABLE = "assessment_events";
  const COLUMNS = "id,question_id,session_id,result,assessed_at";

  function safeErrorCode(error) {
    return error && typeof error.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)
      ? error.code
      : "remote_request_failed";
  }

  function fromRemoteRow(row) {
    return global.AIMLLearningSync.normalizeEvent({
      id: row?.id,
      questionId: row?.question_id,
      sessionId: row?.session_id ?? null,
      result: row?.result,
      assessedAt: row?.assessed_at
    });
  }

  function toRemoteRow(event) {
    const normalized = global.AIMLLearningSync.normalizeEvent(event);
    if (!normalized) return null;
    return {
      id: normalized.id,
      question_id: normalized.questionId,
      session_id: normalized.sessionId,
      result: normalized.result,
      assessed_at: normalized.assessedAt
    };
  }

  function createRemoteAssessmentRepository(client, { pageSize = 500 } = {}) {
    if (!client || typeof client.from !== "function") throw new Error("An authenticated Supabase client is required.");
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 500, 1000));

    async function findOwnEvent(id) {
      const response = await client
        .from(TABLE)
        .select(COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (response.error) return { status: "failed", event: null, errorCode: safeErrorCode(response.error) };
      if (!response.data) return { status: "not_found", event: null };
      const event = fromRemoteRow(response.data);
      return event ? { status: "found", event } : { status: "failed", event: null, errorCode: "malformed_remote_event" };
    }

    async function insertOwnEvent(event) {
      const payload = toRemoteRow(event);
      if (!payload) return { status: "failed", errorCode: "invalid_local_event" };
      const response = await client
        .from(TABLE)
        .insert([payload], { defaultToNull: false });
      if (!response.error) return { status: "inserted" };
      if (safeErrorCode(response.error) !== "23505") {
        return { status: "failed", errorCode: safeErrorCode(response.error) };
      }
      const existing = await findOwnEvent(event.id);
      if (existing.status !== "found") {
        return { status: "failed", errorCode: existing.errorCode || "duplicate_not_readable" };
      }
      return global.AIMLLearningSync.sameEventPayload(event, existing.event)
        ? { status: "already_present", remoteEvent: existing.event }
        : { status: "conflict", remoteEvent: existing.event, errorCode: "same_id_different_payload" };
    }

    async function loadOwnEvents() {
      const events = [];
      let offset = 0;
      while (true) {
        const response = await client
          .from(TABLE)
          .select(COLUMNS)
          .order("assessed_at", { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + safePageSize - 1);
        if (response.error) return { status: "failed", events: [], errorCode: safeErrorCode(response.error) };
        const rows = Array.isArray(response.data) ? response.data : [];
        for (const row of rows) {
          const event = fromRemoteRow(row);
          if (event) events.push(event);
        }
        if (rows.length < safePageSize) break;
        offset += safePageSize;
      }
      return { status: "loaded", events };
    }

    return Object.freeze({ loadOwnEvents, insertOwnEvent, findOwnEvent });
  }

  global.AIMLRemoteAssessments = Object.freeze({
    TABLE,
    COLUMNS,
    fromRemoteRow,
    toRemoteRow,
    createRemoteAssessmentRepository
  });
})(window);
