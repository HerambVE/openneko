-- An optional git remote that administrators publish the org context to.
-- The token is stored encrypted (enc:v1).
create table if not exists context_remote (
  org_id text primary key references organization(id) on delete cascade,
  url text not null,
  mode text not null default 'push' check (mode in ('push', 'pull_request')),
  branch text not null default 'main',
  kinds jsonb not null default '["skills", "skill-overlays", "workflows"]'::jsonb,
  username text,
  token text,
  -- Each skill's tree id at its last sync with the remote.
  skill_bases jsonb not null default '{}'::jsonb,
  last_published_at timestamptz,
  last_publish_status text check (last_publish_status is null or last_publish_status in ('ok', 'failed')),
  last_publish_detail text,
  last_publish_link text,
  updated_by_user_id text references app_user(id) on delete set null,
  updated_at timestamptz not null default now()
);
