-- The Full Count · Supabase database setup
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
--
-- How it works
--   * One row per team. The team's game data (roster, coins, stats, tendencies) lives in `data` (JSON).
--   * PINs are stored as bcrypt hashes and never leave the database.
--   * The browser can't read or write the tables directly (row-level security is on with no policies).
--     Everything goes through the functions below, which check the PIN or a session token.
--   * 5 wrong PINs in a row lock the team for 10 minutes, so a 4-digit PIN can't be guessed quickly.

create extension if not exists pgcrypto;

create table if not exists public.fc_teams (
  name_key      text primary key,                 -- lowercase team name
  name          text not null,                    -- team name as typed
  pin_hash      text not null,                    -- bcrypt hash of the 4-digit PIN
  data          jsonb not null default '{}'::jsonb,
  wins          int not null default 0,
  losses        int not null default 0,
  ties          int not null default 0,
  ladder_best   int not null default 0,
  at_bats       int not null default 0,
  hits          int not null default 0,
  failed_logins int not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.fc_sessions (
  token_hash  text primary key,                   -- sha256 of the session token
  name_key    text not null references public.fc_teams(name_key) on delete cascade,
  created_at  timestamptz not null default now()
);

alter table public.fc_teams    enable row level security;
alter table public.fc_sessions enable row level security;
revoke all on public.fc_teams, public.fc_sessions from anon, authenticated;

-- helpers ------------------------------------------------------------------
create or replace function public.fc_key(p_name text) returns text
language sql immutable as $$ select lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g')) $$;

create or replace function public.fc_new_session(p_key text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text := encode(gen_random_bytes(24), 'hex');
begin
  insert into fc_sessions(token_hash, name_key) values (encode(digest(t, 'sha256'), 'hex'), p_key);
  -- keep the 5 newest sessions per team
  delete from fc_sessions where name_key = p_key and token_hash not in (
    select token_hash from fc_sessions where name_key = p_key order by created_at desc limit 5);
  return t;
end $$;

create or replace function public.fc_sync_columns(p_key text, p_data jsonb) returns void
language sql security definer set search_path = public as $$
  update fc_teams set
    data = p_data,
    wins = coalesce((p_data->'record'->>'w')::int, 0),
    losses = coalesce((p_data->'record'->>'l')::int, 0),
    ties = coalesce((p_data->'record'->>'t')::int, 0),
    ladder_best = coalesce((p_data->>'ladderBest')::int, 0),
    at_bats = coalesce((p_data->'stats'->>'ab')::int, 0),
    hits = coalesce((p_data->'stats'->>'h')::int, 0),
    updated_at = now()
  where name_key = p_key
$$;

-- create a team ------------------------------------------------------------
create or replace function public.fc_create_team(p_name text, p_pin text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k text := fc_key(p_name);
begin
  if p_name !~ '^[A-Za-z0-9][A-Za-z0-9 .''-]{1,15}$' then raise exception 'Team names are 2–16 characters: letters, numbers, spaces, . '' or -.'; end if;
  if p_pin !~ '^\d{4}$' then raise exception 'Your PIN is 4 digits.'; end if;
  if exists (select 1 from fc_teams where name_key = k) then raise exception 'That team name is taken.'; end if;
  insert into fc_teams(name_key, name, pin_hash) values (k, btrim(p_name), crypt(p_pin, gen_salt('bf')));
  perform fc_sync_columns(k, p_data);
  return jsonb_build_object('token', fc_new_session(k), 'data', p_data);
end $$;

-- log in -------------------------------------------------------------------
create or replace function public.fc_login(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k text := fc_key(p_name); r fc_teams;
begin
  select * into r from fc_teams where name_key = k;
  if not found then raise exception 'No team with that name.'; end if;
  if r.locked_until is not null and r.locked_until > now() then
    raise exception 'Too many wrong PINs. Try again in a few minutes.';
  end if;
  if crypt(p_pin, r.pin_hash) <> r.pin_hash then
    update fc_teams set
      locked_until = case when failed_logins + 1 >= 5 then now() + interval '10 minutes' else null end,
      failed_logins = case when failed_logins + 1 >= 5 then 0 else failed_logins + 1 end
    where name_key = k;
    -- return instead of raise: an exception would roll back the failed-attempt counter above
    return jsonb_build_object('error', 'Wrong PIN.');
  end if;
  update fc_teams set failed_logins = 0, locked_until = null where name_key = k;
  return jsonb_build_object('token', fc_new_session(k), 'data', r.data);
end $$;

-- resume a saved session ---------------------------------------------------
create or replace function public.fc_resume(p_name text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k text := fc_key(p_name); d jsonb;
begin
  if not exists (select 1 from fc_sessions where name_key = k and token_hash = encode(digest(p_token, 'sha256'), 'hex')) then
    raise exception 'Please log in again.';
  end if;
  select data into d from fc_teams where name_key = k;
  return jsonb_build_object('data', d);
end $$;

-- save the team after a game or a Clubhouse change -------------------------
create or replace function public.fc_save(p_name text, p_token text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k text := fc_key(p_name);
begin
  if not exists (select 1 from fc_sessions where name_key = k and token_hash = encode(digest(p_token, 'sha256'), 'hex')) then
    raise exception 'Not logged in.';
  end if;
  if pg_column_size(p_data) > 200000 then raise exception 'Team data is too large.'; end if;
  perform fc_sync_columns(k, p_data);
  return jsonb_build_object('ok', true);
end $$;

-- public leaderboard -------------------------------------------------------
drop function if exists public.fc_leaderboard();
create or replace function public.fc_leaderboard() returns table(name text, wins int, losses int, ties int, ladder_best int, avg numeric, crest jsonb)
language sql security definer set search_path = public as $$
  select name, wins, losses, ties, ladder_best,
         case when at_bats > 0 then round(hits::numeric / at_bats, 3) else 0 end,
         data->'crest'
  from fc_teams
  order by ladder_best desc, wins desc, losses asc
  limit 25
$$;

-- game log: one row per finished game with every human pitch/swing decision (for tuning and tendency analysis)
create table if not exists public.fc_gamelog (
  id         bigint generated always as identity primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.fc_gamelog enable row level security;
revoke all on public.fc_gamelog from anon, authenticated;
create or replace function public.fc_log_game(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if pg_column_size(p_data) > 300000 then raise exception 'Game log is too large.'; end if;
  insert into fc_gamelog(data) values (p_data);
  return jsonb_build_object('ok', true);
end $$;

-- only these functions are callable from the browser
revoke all on function public.fc_new_session(text), public.fc_sync_columns(text, jsonb) from public, anon, authenticated;
grant execute on function public.fc_create_team(text, text, jsonb),
                          public.fc_login(text, text),
                          public.fc_resume(text, text),
                          public.fc_save(text, text, jsonb),
                          public.fc_leaderboard(),
                          public.fc_log_game(jsonb) to anon, authenticated;
