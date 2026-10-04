-- The AI Provider Manager, part 3: a custom provider is a provider everywhere.
--
-- Two older doors still knew exactly five provider names: the monthly cap per provider (a CHECK on ai.provider_budgets and a literal
-- list in ai.set_provider_budget) and the owner's "add a model" door (a literal list in ai.add_model). A custom provider added in the
-- Provider Manager could therefore be routed to but never capped, and its models could only be registered through the newer door.
-- Both now ask the registry: a provider is valid when it is in ai.providers and not archived.
--
-- Additive for existing rows: every built-in is in ai.providers, so every stored budget still satisfies the new foreign key.

alter table ai.provider_budgets drop constraint if exists provider_budgets_provider_check;
alter table ai.provider_budgets drop constraint if exists provider_budgets_provider_fkey;
alter table ai.provider_budgets
  add constraint provider_budgets_provider_fkey foreign key (provider) references ai.providers(provider_id);

do $$
declare
  v_sig text;
  v_def text;
  v_new text;
  v_lit constant text := '(''anthropic'', ''openai'', ''gemini'', ''xai'', ''openrouter'')';
begin
  foreach v_sig in array array['ai.add_model(text, text, text[], integer, bigint, bigint)', 'ai.set_provider_budget(text, bigint)'] loop
    v_def := pg_get_functiondef(v_sig::regprocedure);
    v_new := replace(v_def, 'v_provider not in ' || v_lit, 'not exists (select 1 from ai.providers p where p.provider_id = v_provider and p.archived_at is null)');
    v_new := replace(v_new, 'p_provider not in ' || v_lit, 'not exists (select 1 from ai.providers p where p.provider_id = p_provider and p.archived_at is null)');
    if v_new = v_def then
      raise exception 'expected the literal provider list in %, found none - the function changed since this migration was written', v_sig;
    end if;
    execute v_new;
  end loop;
end
$$;

notify pgrst, 'reload schema';
