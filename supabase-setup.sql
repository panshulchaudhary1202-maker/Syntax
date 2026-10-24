-- TravelleR: Supabase Auth + PostgreSQL schema + Row Level Security.
-- Run the whole script once in Supabase Dashboard -> SQL Editor.
-- This script creates the profile, trip, and join-request data model.
-- The browser must only use the public/publishable (or legacy anon) key.

create extension if not exists pgcrypto;

create or replace function public.is_iitr_email(p_email text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_email ~* '^[^@[:space:]]+@([a-z0-9-]+\.)*iitr\.ac\.in$', false);
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name varchar(100) not null default '',
  department varchar(110) not null default '',
  year varchar(30) not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_name_length check (char_length(full_name) <= 100),
  constraint profiles_department_length check (char_length(department) <= 110),
  constraint profiles_year_length check (char_length(year) <= 30)
);

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references auth.users(id) on delete cascade,
  organizer_name varchar(100) not null default '',
  organizer_initials varchar(8) not null default 'TR',
  department varchar(160) not null default '',
  origin varchar(160) not null check (char_length(trim(origin)) between 1 and 160),
  destination varchar(100) not null check (char_length(trim(destination)) between 1 and 100),
  route varchar(180) not null default '' check (char_length(route) <= 180),
  mode varchar(10) not null check (mode in ('Car','Train','Bus','Bike','Other')),
  mode_other varchar(80) not null default '' check (char_length(mode_other) <= 80),
  trip_date date not null,
  trip_time time not null,
  seats_total integer not null check (seats_total between 1 and 8),
  seats_remaining integer not null default 1 check (seats_remaining between 0 and 8),
  -- Legacy aliases retained so an existing Supabase schema from the earlier bundle can be upgraded in place.
  departure_date date,
  departure_time time,
  seats integer,
  cost integer not null default 0 check (cost between 0 and 100000),
  notes varchar(900) not null default '' check (char_length(notes) <= 900),
  status varchar(10) not null default 'open' check (status in ('open','closed')),
  verified boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.join_requests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  trip_destination varchar(100) not null default '',
  organizer_id uuid not null references auth.users(id) on delete cascade,
  requester_id uuid not null references auth.users(id) on delete cascade,
  name varchar(100) not null default '',
  initials varchar(8) not null default 'TR',
  college varchar(160) not null default '',
  message varchar(500) not null default '' check (char_length(message) <= 500),
  status varchar(10) not null default 'Pending' check (status in ('Pending','Accepted','Declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint join_requests_one_per_user_per_trip unique (trip_id, requester_id),
  constraint join_requests_not_own_trip check (organizer_id <> requester_id)
);

-- Upgrade the earlier Supabase schema without dropping its tables or existing records.
-- The former schema called these columns departure_date/departure_time/seats. Existing policies from that version are removed below.
alter table public.trips add column if not exists trip_date date;
alter table public.trips add column if not exists trip_time time;
alter table public.trips add column if not exists seats_total integer;
alter table public.trips add column if not exists seats_remaining integer;
alter table public.trips add column if not exists departure_date date;
alter table public.trips add column if not exists departure_time time;
alter table public.trips add column if not exists seats integer;

update public.trips t set
  trip_date = coalesce(t.trip_date, (to_jsonb(t) ->> 'departure_date')::date, (now() at time zone 'Asia/Kolkata')::date),
  trip_time = coalesce(t.trip_time, (to_jsonb(t) ->> 'departure_time')::time, time '00:00'),
  seats_total = coalesce(t.seats_total, greatest(coalesce((to_jsonb(t) ->> 'seats')::integer, 1) +
    (select count(*)::integer from public.join_requests r where r.trip_id = t.id and r.status = 'Accepted'), 1)),
  seats_remaining = coalesce(t.seats_remaining, greatest(coalesce((to_jsonb(t) ->> 'seats')::integer, 1), 0));
update public.trips set
  departure_date = coalesce(departure_date, trip_date),
  departure_time = coalesce(departure_time, trip_time),
  seats = coalesce(seats, seats_remaining);
alter table public.trips alter column trip_date set not null;
alter table public.trips alter column trip_time set not null;
alter table public.trips alter column seats_total set not null;
alter table public.trips alter column seats_remaining set not null;

create index if not exists trips_date_idx on public.trips (trip_date, trip_time);
create index if not exists trips_organizer_idx on public.trips (organizer_id);
create index if not exists join_requests_trip_idx on public.join_requests (trip_id, created_at desc);
create index if not exists join_requests_requester_idx on public.join_requests (requester_id, created_at desc);
create index if not exists join_requests_organizer_idx on public.join_requests (organizer_id, created_at desc);

-- Supabase Auth automatically creates a private profile row. Non-IITR addresses are rejected.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_iitr_email(new.email) then
    raise exception 'Use a valid IIT Roorkee email address.' using errcode = '42501';
  end if;
  insert into public.profiles (id, email, full_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.set_profile_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_profile_updated_at();

-- Trusted trip metadata is derived on the server from the signed-in user's profile.
create or replace function public.prepare_trip_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_recent integer;
begin
  if auth.uid() is null or not public.is_iitr_email(auth.jwt() ->> 'email') then
    raise exception 'Use a signed-in IIT Roorkee account.' using errcode = '42501';
  end if;
  select * into v_profile from public.profiles where id = auth.uid();
  if not found or char_length(trim(v_profile.full_name)) < 2 or char_length(trim(v_profile.department)) < 1 then
    raise exception 'Complete your profile before posting a trip.' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('trip-user:' || auth.uid()::text));
  select count(*)::integer into v_recent from public.trips
    where organizer_id = auth.uid() and created_at > now() - interval '24 hours';
  if v_recent >= 10 then
    raise exception 'You can publish up to 10 trips every 24 hours.' using errcode = '23514';
  end if;
  if new.trip_date < (now() at time zone 'Asia/Kolkata')::date
     or new.trip_date > ((now() at time zone 'Asia/Kolkata')::date + 365) then
    raise exception 'Departure date must be today or within one year.' using errcode = '23514';
  end if;
  if new.mode = 'Other' and char_length(trim(new.mode_other)) = 0 then
    raise exception 'Specify the other transport mode.' using errcode = '23514';
  end if;
  if new.seats_total < 1 or new.seats_total > 8 or new.cost < 0 or new.cost > 100000 then
    raise exception 'Seats or cost is outside the allowed range.' using errcode = '23514';
  end if;
  new.organizer_id := auth.uid();
  new.organizer_name := v_profile.full_name;
  new.organizer_initials := upper(left(v_profile.full_name, 1) || coalesce(left(split_part(v_profile.full_name, ' ', 2), 1), ''));
  new.department := trim(concat_ws(' · ', nullif(v_profile.department, ''), nullif(v_profile.year, '')));
  new.seats_remaining := new.seats_total;
  new.departure_date := new.trip_date;
  new.departure_time := new.trip_time;
  new.seats := new.seats_total;
  new.status := 'open';
  new.verified := true;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trips_prepare_insert on public.trips;
create trigger trips_prepare_insert before insert on public.trips
for each row execute function public.prepare_trip_insert();

-- Requests never trust organizer/requester/name values submitted by the browser.
create or replace function public.prepare_join_request_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trip public.trips%rowtype;
  v_profile public.profiles%rowtype;
  v_recent integer;
begin
  if auth.uid() is null or not public.is_iitr_email(auth.jwt() ->> 'email') then
    raise exception 'Use a signed-in IIT Roorkee account.' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = new.trip_id for update;
  if not found then
    raise exception 'Trip not found.' using errcode = 'P0002';
  end if;
  if v_trip.organizer_id = auth.uid() then
    raise exception 'You cannot request to join your own trip.' using errcode = '42501';
  end if;
  if v_trip.status <> 'open' or v_trip.seats_remaining < 1 then
    raise exception 'This trip has no seats left.' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('request-user:' || auth.uid()::text));
  select count(*)::integer into v_recent from public.join_requests
    where requester_id = auth.uid() and created_at > now() - interval '24 hours';
  if v_recent >= 30 then
    raise exception 'You can send up to 30 join requests every 24 hours.' using errcode = '23514';
  end if;
  select * into v_profile from public.profiles where id = auth.uid();
  if not found or char_length(trim(v_profile.full_name)) < 2 or char_length(trim(v_profile.department)) < 1 then
    raise exception 'Complete your profile before sending a join request.' using errcode = '23514';
  end if;
  new.requester_id := auth.uid();
  new.organizer_id := v_trip.organizer_id;
  new.trip_destination := v_trip.destination;
  new.name := v_profile.full_name;
  new.initials := upper(left(v_profile.full_name, 1) || coalesce(left(split_part(v_profile.full_name, ' ', 2), 1), ''));
  new.college := trim(concat_ws(' · ', nullif(v_profile.department, ''), nullif(v_profile.year, '')));
  new.status := 'Pending';
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists join_requests_prepare_insert on public.join_requests;
create trigger join_requests_prepare_insert before insert on public.join_requests
for each row execute function public.prepare_join_request_insert();

alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.join_requests enable row level security;

drop policy if exists "Signed-in users can view trips" on public.trips;
drop policy if exists "Organizers can edit their own trips" on public.trips;
drop policy if exists "Organizers can delete their own trips" on public.trips;
drop policy if exists "Users can read their own join requests or requests to their trips" on public.join_requests;
drop policy if exists "Users can request to join another open trip" on public.join_requests;
drop policy if exists "Organizers can update their own join requests" on public.join_requests;

drop policy if exists "IITR users can read own profile" on public.profiles;
drop policy if exists "IITR users can insert own profile" on public.profiles;
drop policy if exists "IITR users can update own profile" on public.profiles;
create policy "IITR users can read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()) and public.is_iitr_email(auth.jwt() ->> 'email'));
create policy "IITR users can insert own profile" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()) and lower(email) = lower(auth.jwt() ->> 'email') and public.is_iitr_email(auth.jwt() ->> 'email'));
create policy "IITR users can update own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid()) and public.is_iitr_email(auth.jwt() ->> 'email'))
  with check (id = (select auth.uid()) and lower(email) = lower(auth.jwt() ->> 'email') and public.is_iitr_email(auth.jwt() ->> 'email'));

drop policy if exists "IITR users can view trips" on public.trips;
drop policy if exists "Users can publish their own trips" on public.trips;
create policy "IITR users can view trips" on public.trips
  for select to authenticated using (public.is_iitr_email(auth.jwt() ->> 'email'));
create policy "Users can publish their own trips" on public.trips
  for insert to authenticated with check (organizer_id = (select auth.uid()) and public.is_iitr_email(auth.jwt() ->> 'email'));

drop policy if exists "Users can read requests they sent or received" on public.join_requests;
drop policy if exists "Users can send join requests" on public.join_requests;
create policy "Users can read requests they sent or received" on public.join_requests
  for select to authenticated using (
    public.is_iitr_email(auth.jwt() ->> 'email') and
    (requester_id = (select auth.uid()) or organizer_id = (select auth.uid()))
  );
create policy "Users can send join requests" on public.join_requests
  for insert to authenticated with check (
    requester_id = (select auth.uid())
    and organizer_id <> (select auth.uid())
    and public.is_iitr_email(auth.jwt() ->> 'email')
    and exists (
      select 1 from public.trips t
      where t.id = join_requests.trip_id
        and t.organizer_id = join_requests.organizer_id
        and t.status = 'open'
        and t.seats_remaining > 0
    )
  );

-- Revoke broad privileges, then grant only columns required by the frontend.
revoke all on public.profiles from anon, authenticated;
revoke all on public.trips from anon, authenticated;
revoke all on public.join_requests from anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant insert (id, email, full_name, department, year) on public.profiles to authenticated;
grant update (email, full_name, department, year) on public.profiles to authenticated;
grant select on public.trips to authenticated;
grant insert (origin, destination, route, mode, mode_other, trip_date, trip_time, seats_total, cost, notes) on public.trips to authenticated;
grant select on public.join_requests to authenticated;
grant insert (trip_id, message) on public.join_requests to authenticated;

-- Accepting/reopening is atomic: only the trip organizer can change status; seats change together.
create or replace function public.set_join_request_status(p_request_id uuid, p_next_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.join_requests%rowtype;
  v_trip public.trips%rowtype;
begin
  if auth.uid() is null or not public.is_iitr_email(auth.jwt() ->> 'email') then
    raise exception 'You must sign in with an IIT Roorkee account.' using errcode = '28000';
  end if;
  if p_next_status not in ('Pending', 'Accepted', 'Declined') then
    raise exception 'Invalid join request status.' using errcode = '22023';
  end if;
  select * into v_request from public.join_requests where id = p_request_id for update;
  if not found then raise exception 'Request not found.' using errcode = 'P0002'; end if;
  if v_request.organizer_id <> auth.uid() then
    raise exception 'Only the trip organizer can change request status.' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = v_request.trip_id for update;
  if not found then raise exception 'Trip not found.' using errcode = 'P0002'; end if;
  if p_next_status = 'Accepted' and v_request.status <> 'Accepted' then
    if v_trip.status <> 'open' or v_trip.seats_remaining < 1 then
      raise exception 'No seats remaining on this trip.' using errcode = '23514';
    end if;
    update public.trips set seats_remaining = seats_remaining - 1, seats = seats_remaining - 1, updated_at = now() where id = v_trip.id;
  elsif v_request.status = 'Accepted' and p_next_status <> 'Accepted' then
    update public.trips set seats_remaining = least(seats_total, seats_remaining + 1), seats = least(seats_total, seats_remaining + 1), updated_at = now() where id = v_trip.id;
  end if;
  update public.join_requests set status = p_next_status, updated_at = now() where id = v_request.id;
end;
$$;
revoke all on function public.set_join_request_status(uuid, text) from public, anon;
grant execute on function public.set_join_request_status(uuid, text) to authenticated;

-- Enable Realtime for updates across signed-in tabs/devices when available.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trips') then
      execute 'alter publication supabase_realtime add table public.trips';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'join_requests') then
      execute 'alter publication supabase_realtime add table public.join_requests';
    end if;
  end if;
end $$;

-- Sanity check after running:
-- select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('profiles','trips','join_requests');
