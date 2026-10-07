-- Owner decision 2026-10-07: closing an incident is an Admin act. A delivery lead can still record the recovery, the root cause and the corrective actions
-- through the other doors; closing (which clears the completion pause) needs owner or ops_admin.
do $mig$
declare v_def text; v_old text := $o$if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_root_cause is null$o$; v_new text;
begin
  v_def := pg_get_functiondef('projects.close_incident(uuid,text,text,text)'::regprocedure);
  if position('if not coalesce((select core.can_manage_delivery()), false) then return query select ''not_authorized''::text; return; end if;' in v_def) = 0 then raise exception 'close_incident: authorisation line not found'; end if;
  v_new := replace(v_def, 'if not coalesce((select core.can_manage_delivery()), false) then return query select ''not_authorized''::text; return; end if;',
                   'if not coalesce((select core.is_admin()), false) then return query select ''not_authorized''::text; return; end if;');
  execute v_new;
end $mig$;
