-- Phase 1 schema. See docs/SPEC.md.
--
-- Access model: the PWA uses the anon key and sends the household code in the
-- x-household-code header. Reads go through RLS keyed on that header. Writes go
-- through the security definer functions at the bottom, so anon has no direct
-- write access to any table. Edge functions use the service role.

create extension if not exists pg_trgm with schema extensions;

create type public.unit as enum ('unit', 'g', 'kg', 'ml', 'l', 'pack', 'bag', 'bottle');
-- 'bought' keeps tapped rows on the server until finish_trip() moves them to
-- trip_items. The app hides them and they can be undone.
create type public.list_status as enum ('pending_confirm', 'on_list', 'unavailable', 'bought');
create type public.trip_outcome as enum ('bought', 'unavailable');
create type public.item_source as enum ('chain', 'family');
create type public.added_channel as enum ('app', 'whatsapp');

create table public.households (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  wifey_phone text,
  reset_weekday smallint not null default 4 check (reset_weekday between 0 and 6),
  reset_hour smallint not null default 16 check (reset_hour between 0 and 23),
  default_store_id uuid
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name_he text not null,
  phone_e164 text not null unique,
  push_subscription jsonb
);
create index members_household_idx on public.members (household_id);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name_he text not null,
  sort_order integer not null default 0,
  unique (household_id, name_he),
  unique (household_id, id)
);

create table public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name_he text not null,
  aliases_he text[] not null default '{}',
  category_id uuid,
  default_unit public.unit not null default 'unit',
  default_qty numeric not null default 1 check (default_qty > 0),
  is_favorite boolean not null default false,
  barcode text,
  source public.item_source not null default 'family',
  times_bought integer not null default 0,
  last_bought_at timestamptz,
  unique (household_id, barcode),
  unique (household_id, id),
  foreign key (household_id, category_id) references public.categories (household_id, id)
);
create index catalog_items_name_trgm_idx on public.catalog_items using gin (name_he extensions.gin_trgm_ops);
create index catalog_items_frequency_idx on public.catalog_items (household_id, times_bought desc);
create index catalog_items_favorite_idx on public.catalog_items (household_id) where is_favorite;

create table public.list_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  catalog_item_id uuid not null,
  qty numeric not null default 1 check (qty > 0),
  unit public.unit not null default 'unit',
  status public.list_status not null default 'on_list',
  added_by uuid references public.members (id) on delete set null,
  added_via public.added_channel not null default 'app',
  created_at timestamptz not null default now(),
  -- Last offline-queue operation applied, so a retry after a lost response does not double the qty.
  last_op_id uuid,
  unique (household_id, catalog_item_id, status),
  foreign key (household_id, catalog_item_id) references public.catalog_items (household_id, id)
);
create index list_items_op_idx on public.list_items (household_id, last_op_id);

create table public.pending_batches (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members (id) on delete cascade,
  raw_text text,
  parsed jsonb not null default '[]',
  wa_message_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index pending_batches_member_idx on public.pending_batches (member_id, expires_at);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  store_id uuid,
  finished_at timestamptz not null default now(),
  finished_by uuid references public.members (id) on delete set null
);
create index trips_household_idx on public.trips (household_id, finished_at desc);

create table public.trip_items (
  trip_id uuid not null references public.trips (id) on delete cascade,
  catalog_item_id uuid not null references public.catalog_items (id),
  qty numeric not null,
  unit public.unit not null,
  outcome public.trip_outcome not null,
  primary key (trip_id, catalog_item_id, outcome)
);

-- The household for the current request, or null when the header is missing or wrong.
create function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select h.id
  from public.households h
  where h.code = nullif(current_setting('request.headers', true), '')::json ->> 'x-household-code'
$$;

-- RLS
alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.categories enable row level security;
alter table public.catalog_items enable row level security;
alter table public.list_items enable row level security;
alter table public.pending_batches enable row level security;
alter table public.trips enable row level security;
alter table public.trip_items enable row level security;

create policy households_read on public.households for select to anon
  using (id = (select public.current_household_id()));
create policy members_read on public.members for select to anon
  using (household_id = (select public.current_household_id()));
create policy categories_read on public.categories for select to anon
  using (household_id = (select public.current_household_id()));
create policy catalog_items_read on public.catalog_items for select to anon
  using (household_id = (select public.current_household_id()));
create policy list_items_read on public.list_items for select to anon
  using (household_id = (select public.current_household_id()));
create policy trips_read on public.trips for select to anon
  using (household_id = (select public.current_household_id()));
create policy trip_items_read on public.trip_items for select to anon
  using (exists (
    select 1 from public.trips t
    where t.id = trip_id and t.household_id = (select public.current_household_id())
  ));
-- pending_batches has no anon policy on purpose: only wa-webhook touches it.

revoke all on all tables in schema public from anon, authenticated;
grant select on public.households, public.members, public.categories, public.catalog_items,
  public.list_items, public.trips, public.trip_items to anon;
grant all on all tables in schema public to service_role;

-- Realtime. postgres_changes cannot see request headers, so RLS keyed on the
-- household code would hide every change from subscribers. Instead the database
-- broadcasts a data-free "changed" ping on a per-household channel and clients
-- refetch through RLS. The topic uses the household uuid, which only the code reveals.
create function public.notify_household()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('table', tg_table_name),
      'changed',
      'household:' || coalesce(new.household_id, old.household_id)::text,
      false
    );
  exception when others then
    -- A realtime hiccup must never fail a list write.
    raise warning 'notify_household failed: %', sqlerrm;
  end;
  return null;
end;
$$;

create trigger list_items_notify
  after insert or update or delete on public.list_items
  for each row execute function public.notify_household();

-- Only star changes: bulk catalog writes such as the seed must not broadcast.
create trigger catalog_items_favorite_notify
  after update of is_favorite on public.catalog_items
  for each row when (old.is_favorite is distinct from new.is_favorite)
  execute function public.notify_household();

-- Writes for the PWA.
create function public.require_household()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  h uuid := public.current_household_id();
begin
  if h is null then
    raise exception 'unknown household code' using errcode = '28000';
  end if;
  return h;
end;
$$;

-- Adds to the list, creating a family catalog item when the id and name are both unknown.
-- Same item already on the list: same unit adds up, a different unit replaces.
-- Adding an item marked unavailable puts it back on the list.
create function public.add_list_item(
  p_op_id uuid,
  p_id uuid,
  p_catalog_item_id uuid,
  p_name text,
  p_qty numeric,
  p_unit public.unit
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  h uuid := public.require_household();
  v_catalog_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  select l.id into v_id from public.list_items l
  where l.household_id = h and l.last_op_id = p_op_id;
  if found then
    return v_id;
  end if;

  select c.id into v_catalog_id from public.catalog_items c
  where c.id = p_catalog_item_id and c.household_id = h;

  if v_catalog_id is null then
    if v_name = '' then
      raise exception 'item name is required' using errcode = '22023';
    end if;
    select c.id into v_catalog_id from public.catalog_items c
    where c.household_id = h and c.name_he = v_name
    order by c.times_bought desc, c.source desc
    limit 1;
  end if;

  if v_catalog_id is null then
    insert into public.catalog_items (id, household_id, name_he, default_unit, default_qty, source)
    values (coalesce(p_catalog_item_id, gen_random_uuid()), h, v_name, p_unit, p_qty, 'family')
    returning id into v_catalog_id;
  end if;

  delete from public.list_items l
  where l.household_id = h and l.catalog_item_id = v_catalog_id and l.status = 'unavailable';

  insert into public.list_items as l (id, household_id, catalog_item_id, qty, unit, status, added_via, last_op_id)
  values (coalesce(p_id, gen_random_uuid()), h, v_catalog_id, p_qty, p_unit, 'on_list', 'app', p_op_id)
  on conflict (household_id, catalog_item_id, status) do update
    set qty = case when l.unit = excluded.unit then l.qty + excluded.qty else excluded.qty end,
        unit = excluded.unit,
        last_op_id = excluded.last_op_id
  returning l.id into v_id;

  return v_id;
end;
$$;

-- Absolute, so safe to retry. A row already in the target status is merged into this one.
create function public.set_list_item_status(p_id uuid, p_status public.list_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  h uuid := public.require_household();
  v_row public.list_items;
  v_other public.list_items;
begin
  if p_status not in ('on_list', 'unavailable', 'bought') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  select * into v_row from public.list_items l where l.id = p_id and l.household_id = h for update;
  if not found or v_row.status = p_status then
    return;
  end if;

  delete from public.list_items l
  where l.household_id = h and l.catalog_item_id = v_row.catalog_item_id and l.status = p_status
  returning * into v_other;

  update public.list_items l
  set status = p_status,
      qty = case when v_other.id is not null and v_other.unit = l.unit then l.qty + v_other.qty else l.qty end
  where l.id = p_id;
end;
$$;

create function public.remove_list_item(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.list_items l where l.id = p_id and l.household_id = public.require_household();
$$;

create function public.set_favorite(p_catalog_item_id uuid, p_value boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.catalog_items c set is_favorite = p_value
  where c.id = p_catalog_item_id and c.household_id = public.require_household();
$$;

-- Autocomplete: household history by frequency first, then the chain catalog.
create function public.search_catalog(p_q text, p_limit integer default 15)
returns setof public.catalog_items
language sql
stable
security definer
set search_path = ''
as $$
  select c.*
  from public.catalog_items c
  where c.household_id = public.require_household()
    and (
      c.name_he ilike '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      or extensions.similarity(c.name_he, btrim(p_q)) > 0.4
    )
  order by
    c.times_bought desc,
    c.source desc,
    c.name_he ilike replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%' desc,
    length(c.name_he),
    c.name_he
  limit least(greatest(p_limit, 1), 50)
$$;

-- Saves the trip and clears the list, one transaction. Rows still on the list were
-- neither bought nor unavailable, so they are cleared without a trip_items row.
-- Passing the client's trip id makes a retry, or a second phone finishing, harmless.
create function public.finish_trip(p_trip_id uuid default gen_random_uuid())
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  h uuid := public.require_household();
begin
  -- Serializes two phones tapping סיימתי together.
  perform 1 from public.households where id = h for update;

  if exists (select 1 from public.trips t where t.id = p_trip_id and t.household_id = h) then
    return p_trip_id;
  end if;

  if not exists (
    select 1 from public.list_items l
    where l.household_id = h and l.status in ('on_list', 'unavailable', 'bought')
  ) then
    return null;
  end if;

  insert into public.trips (id, household_id) values (p_trip_id, h);

  insert into public.trip_items (trip_id, catalog_item_id, qty, unit, outcome)
  select p_trip_id, l.catalog_item_id, l.qty, l.unit, l.status::text::public.trip_outcome
  from public.list_items l
  where l.household_id = h and l.status in ('bought', 'unavailable');

  update public.catalog_items c
  set times_bought = c.times_bought + 1, last_bought_at = now()
  from public.list_items l
  where l.catalog_item_id = c.id and l.household_id = h and c.household_id = h and l.status = 'bought';

  delete from public.list_items l
  where l.household_id = h and l.status in ('on_list', 'unavailable', 'bought');

  return p_trip_id;
end;
$$;

revoke all on function
  public.current_household_id(),
  public.notify_household(),
  public.require_household(),
  public.add_list_item(uuid, uuid, uuid, text, numeric, public.unit),
  public.set_list_item_status(uuid, public.list_status),
  public.remove_list_item(uuid),
  public.set_favorite(uuid, boolean),
  public.search_catalog(text, integer),
  public.finish_trip(uuid)
from public, anon, authenticated;

grant execute on function
  public.current_household_id(),
  public.add_list_item(uuid, uuid, uuid, text, numeric, public.unit),
  public.set_list_item_status(uuid, public.list_status),
  public.remove_list_item(uuid),
  public.set_favorite(uuid, boolean),
  public.search_catalog(text, integer),
  public.finish_trip(uuid)
to anon;
