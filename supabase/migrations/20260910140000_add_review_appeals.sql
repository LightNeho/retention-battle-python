create table if not exists public.review_appeals (
  appeal_id text primary key,
  review_id text not null unique references public.call_reviews(review_id) on delete cascade,
  agent_id text not null references public.agents(agent_id),
  team_id text not null references public.teams(team_id),
  submitted_by text not null references public.users(user_id),
  reason text not null,
  status text not null default 'PENDING',
  submitted_at text not null,
  resolved_by text,
  resolved_at text,
  resolution_note text
);

create index if not exists review_appeals_agent_idx on public.review_appeals (agent_id);
create index if not exists review_appeals_team_status_idx on public.review_appeals (team_id, status);

alter table public.review_appeals enable row level security;
