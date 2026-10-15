-- Iteration 7A proposal only. Do not apply until the design is approved.
-- The browser inserts immutable assessment events; derived progress stays client-side.

begin;

create table public.assessment_events (
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  id text not null check (length(id) > 0),
  question_id text not null check (length(question_id) > 0),
  session_id text null check (session_id is null or length(session_id) > 0),
  result text not null
    check (result in ('known', 'needs_review')),
  assessed_at timestamptz not null,
  primary key (user_id, id)
);

comment on table public.assessment_events is
  'Immutable user-owned AI/ML Interview Deck assessment events.';
comment on column public.assessment_events.id is
  'Existing client event ID; unique within one authenticated user.';
comment on column public.assessment_events.assessed_at is
  'Original assessment instant supplied by the client; never regenerated during sync.';

create index assessment_events_user_assessed_idx
  on public.assessment_events (user_id, assessed_at, id);

alter table public.assessment_events enable row level security;
alter table public.assessment_events force row level security;

revoke all on table public.assessment_events from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select on table public.assessment_events to authenticated;
-- The Data API client must omit user_id and request missing-column defaults.
-- PostgreSQL then evaluates auth.uid() for user_id; this grant prevents a
-- browser payload from naming or changing an owner.
grant insert (id, question_id, session_id, result, assessed_at)
  on table public.assessment_events to authenticated;

create policy assessment_events_select_own
  on public.assessment_events
  for select
  to authenticated
  using (
    (select auth.uid()) is not null
    and user_id = (select auth.uid())
  );

create policy assessment_events_insert_own
  on public.assessment_events
  for insert
  to authenticated
  with check (
    (select auth.uid()) is not null
    and user_id = (select auth.uid())
  );

-- There are deliberately no UPDATE or DELETE grants or policies. Events are immutable.

commit;
