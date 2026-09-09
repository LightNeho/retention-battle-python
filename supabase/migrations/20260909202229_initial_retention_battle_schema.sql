create table if not exists public.config (
  key text primary key,
  value text
);

create table if not exists public.users (
  user_id text primary key,
  name text,
  role text,
  team_id text,
  email text,
  pin_hash text,
  claimed integer
);

create table if not exists public.teams (
  team_id text primary key,
  name text,
  team_leader_id text,
  division text
);

create table if not exists public.agents (
  agent_id text primary key,
  name text,
  team_id text,
  status text,
  join_date text
);

create table if not exists public.team_leaders (
  leader_id text primary key,
  name text,
  team_id text
);

create table if not exists public.call_reviews (
  review_id text primary key,
  date text,
  time text,
  timestamp text,
  reviewer_id text,
  agent_id text,
  team_id text,
  leader_id text,
  customer_number text,
  tashaul double precision,
  hatamat_hatzaa double precision,
  eichut_sherut double precision,
  review_purpose text,
  round_id text,
  retention_success text,
  leave_reason text,
  offer_given text,
  excellent_call_bonus text,
  reviewer_note text,
  week_id text,
  status text
);

create table if not exists public.manager_tasks (
  task_id text primary key,
  name text,
  description text,
  points double precision,
  type text,
  condition_key text,
  target_value double precision,
  active integer
);

create table if not exists public.manager_task_results (
  result_id text primary key,
  task_id text,
  leader_id text,
  week_id text,
  status text,
  progress double precision,
  updated_at text,
  approved_by text
);

create table if not exists public.bonuses (
  bonus_id text primary key,
  target_type text,
  target_id text,
  points double precision,
  reason text,
  week_id text,
  given_by text,
  given_at text
);

create table if not exists public.badges (
  badge_id text primary key,
  name text,
  icon text,
  description text,
  condition_key text,
  minimum_sample integer,
  active integer
);

create table if not exists public.badge_awards (
  award_id text primary key,
  badge_id text,
  target_type text,
  target_id text,
  week_id text,
  awarded_at text,
  awarded_by text
);

create table if not exists public.weekly_results (
  week_id text primary key,
  closed_at text,
  closed_by text,
  snapshot_json text
);

create table if not exists public.hall_of_fame (
  record_id text primary key,
  week_id text,
  winning_teams_json text,
  mvp_agent_id text,
  winning_leader_id text,
  call_of_week_agent_id text
);

create table if not exists public.activity_log (
  event_id text primary key,
  message text,
  week_id text,
  timestamp text
);

create table if not exists public.audit_log (
  log_id text primary key,
  timestamp text,
  user_id text,
  user_name text,
  action text,
  entity_type text,
  entity_id text,
  old_value text,
  new_value text
);

create table if not exists public.leave_reasons (
  reason_id text primary key,
  value text,
  active integer
);

create table if not exists public.offers (
  offer_id text primary key,
  value text,
  active integer
);

create index if not exists call_reviews_agent_week_idx
  on public.call_reviews (agent_id, week_id);
create index if not exists call_reviews_team_week_idx
  on public.call_reviews (team_id, week_id);
create index if not exists users_team_idx on public.users (team_id);
create index if not exists agents_team_idx on public.agents (team_id);

alter table public.config enable row level security;
alter table public.users enable row level security;
alter table public.teams enable row level security;
alter table public.agents enable row level security;
alter table public.team_leaders enable row level security;
alter table public.call_reviews enable row level security;
alter table public.manager_tasks enable row level security;
alter table public.manager_task_results enable row level security;
alter table public.bonuses enable row level security;
alter table public.badges enable row level security;
alter table public.badge_awards enable row level security;
alter table public.weekly_results enable row level security;
alter table public.hall_of_fame enable row level security;
alter table public.activity_log enable row level security;
alter table public.audit_log enable row level security;
alter table public.leave_reasons enable row level security;
alter table public.offers enable row level security;
