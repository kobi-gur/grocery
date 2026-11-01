-- Item panel writes: quantity and unit on a list row, category on the catalog item.

-- Absolute, so safe to retry from the offline queue.
create function public.set_list_item_qty(p_id uuid, p_qty numeric, p_unit public.unit)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.list_items l set qty = p_qty, unit = p_unit
  where l.id = p_id and l.household_id = public.require_household();
$$;

-- The row wins over the catalog id: an item added offline by name may have landed on an
-- existing catalog item, and then the id the phone holds never reached the server.
-- The catalog id covers a row removed by the other phone before this write arrived.
create function public.set_item_category(p_list_item_id uuid, p_catalog_item_id uuid, p_category_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  h uuid := public.require_household();
  v_catalog_id uuid;
begin
  select l.catalog_item_id into v_catalog_id from public.list_items l
  where l.id = p_list_item_id and l.household_id = h;

  update public.catalog_items c set category_id = p_category_id
  where c.id = coalesce(v_catalog_id, p_catalog_item_id) and c.household_id = h;
end;
$$;

-- A category move changes the groups on the other phone, and no list row changes with it.
create trigger catalog_items_category_notify
  after update of category_id on public.catalog_items
  for each row when (old.category_id is distinct from new.category_id)
  execute function public.notify_household();

revoke all on function
  public.set_list_item_qty(uuid, numeric, public.unit),
  public.set_item_category(uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.set_list_item_qty(uuid, numeric, public.unit),
  public.set_item_category(uuid, uuid, uuid)
to anon;
