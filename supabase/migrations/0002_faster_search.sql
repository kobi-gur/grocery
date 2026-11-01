-- Autocomplete took over 500 ms on the seeded catalog because similarity() scanned
-- every row. The % operator (default threshold 0.3) can use the trigram index, and similarity()
-- then applies the 0.4 from CLAUDE.md. Whole-word matches rank first, so "חלב" finds milk before "חלבה".
create or replace function public.search_catalog(p_q text, p_limit integer default 15)
returns setof public.catalog_items
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  h uuid := public.require_household();
  q text := btrim(p_q);
  pattern text := replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_');
begin
  return query
  select c.*
  from public.catalog_items c
  where c.household_id = h
    and (c.name_he ilike '%' || pattern || '%' or (c.name_he operator(extensions.%) q and extensions.similarity(c.name_he, q) > 0.4))
  order by
    c.times_bought desc,
    c.source desc,
    c.name_he = q desc,
    c.name_he like pattern || ' %' desc,
    c.name_he like pattern || '%' desc,
    length(c.name_he),
    c.name_he
  limit least(greatest(p_limit, 1), 50);
end;
$$;

revoke all on function public.search_catalog(text, integer) from public, anon, authenticated;
grant execute on function public.search_catalog(text, integer) to anon;
