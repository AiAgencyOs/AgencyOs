import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The words a client reads — PM §10, §11; G-290.
 *
 * §11 gives four templates and then the sentence that shapes the unit:
 * *"Templates must remain configurable; these are examples, not hard-coded
 * mandatory wording."*
 *
 * So the shipped wording is a default. The half worth building is §10 — ten
 * prohibitions that were prose nobody could enforce — and the split that
 * matters is which of them are about the **words** and which are about
 * **when** the words may be said.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260919200000_the_words_a_client_reads.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');

const door = (() => {
  const start = SQL.indexOf('create or replace function projects.render_design_message');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

const bodyGuard = (() => {
  const start = SQL.indexOf('create or replace function projects.enforce_design_message_body');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. the two §10 rules that are about the words', () => {
  test('a message naming the provider, the model or the prompt is refused', () => {
    assert.match(bodyGuard, /if v_body ~ '\\y\(openai\|anthropic\|gpt\|claude\|gemini\|llm\|model routing\|api key\|token limit\|prompt\)\\y' then\s*\n\s*select/);
    assert.match(bodyGuard, /PM section 10 forbids naming the provider, the model or the prompt/);
  });

  test('and it names which word it found, rather than refusing in general', () => {
    // A template is 2,000 characters. "Contains something forbidden" sends the
    // writer hunting through their own sentence.
    assert.match(bodyGuard, /\(found "%"\)/);
    assert.match(bodyGuard, /into v_bad;/);
  });

  test('matched on word boundaries, not substrings', () => {
    // A palette called "Claudette" is not a routing disclosure. Refusing it
    // would teach people to work around the check rather than trust it.
    // Proven on a scratch Postgres: "Claudette, Sand and Slate" is accepted.
    assert.ok(bodyGuard.includes('\\y('), 'the pattern is not boundary-anchored');
    assert.match(PROSE, /would\s+teach people to work around the check rather than trust it/);
  });

  test('internal reasoning is refused too', () => {
    assert.match(bodyGuard, /if v_body ~ '\\y\(system message\|chain of thought\|reasoning trace\|internal note\)\\y' then\s*\n\s*raise exception/);
  });

  test('and the reason these are rows rather than review', () => {
    assert.match(PROSE, /a template is written once and sent a hundred times/);
  });
});

describe('B. an unknown placeholder is refused, not discovered by a client', () => {
  test('only the five the door fills are allowed', () => {
    assert.match(bodyGuard, /where m\[1\] not in \('client_name', 'project_name', 'option_names', 'option_count', 'round_number'\)/);
  });

  test('and the door fills exactly those five, no more and no fewer', () => {
    // If the two lists drifted apart, one direction leaves `{{x}}` in front of
    // a client and the other refuses a variable that would have worked.
    const filled = [...door.matchAll(/replace\(v_body, '\{\{(\w+)\}\}'/g)].map((m) => m[1] ?? '').sort();
    assert.deepEqual(filled, ['client_name', 'option_count', 'option_names', 'project_name', 'round_number']);
  });

  test('the refusal says what may be used', () => {
    assert.match(bodyGuard, /a client message may only use \{\{client_name\}\}, \{\{project_name\}\}/);
    assert.match(bodyGuard, /anything else reaches the client as literal text/);
  });
});

describe('C. the §10 rule that is about WHEN, and so cannot be a CHECK', () => {
  test('a step whose claim the state does not support is refused', () => {
    // §10: "Do not claim a revision is ready before approved backend state."
    assert.match(door, /if p_step_key = 'revision_ready' and not exists \([\s\S]{0,400}?and t\.admin_status = 'approved'\s*\n\s*\) then\s*\n\s*return query select 'no_revision_ready'::text/);
  });

  test('and a revision counts only once it has been DELIVERED and approved', () => {
    // An opened round is not a ready one. Both halves, because either alone
    // would let the message go out early.
    assert.match(door, /and r\.status = 'delivered'/);
    assert.match(door, /join projects\.theme_options t on t\.id = r\.to_theme_option_id/);
  });

  test('each step checks its own claim', () => {
    // The CONDITION and the return together. Asserting the outcome string
    // alone let `if false then` through on both of these — the branch stays
    // unreachable and the string stays in the file. Third time this class has
    // bitten in this phase, and the first time it bit twice in one round.
    assert.match(door, /if p_step_key = 'theme_review' and coalesce\(v_count, 0\) = 0 then\s*\n\s*return query select 'nothing_approved'::text/);
    assert.match(door, /if p_step_key = 'final_confirmation' and not exists \([\s\S]{0,300}?\) then\s*\n\s*return query select 'not_selected_yet'::text/);
    assert.match(PROSE, /it is about\s+\*\*when\*\* they may be said/);
  });

  test('and the start message needs nothing, because it claims nothing', () => {
    // Driven: `phase_three_start` renders on a phase with no approved option.
    assert.doesNotMatch(door, /p_step_key = 'phase_three_start' and not exists/);
  });
});

describe('D. a rejected design cannot be named, even by a template that asks', () => {
  test('the names come only from Admin-approved options', () => {
    assert.match(door, /from projects\.theme_options t\s*\n\s*where t\.phase_three_id = v_phase3\.id\s*\n\s*and t\.admin_status = 'approved'/);
  });

  test('and the rule lives in what the door puts in the variable', () => {
    // Which is why it holds whatever an organisation writes: a template cannot
    // reach past the variable it is given.
    assert.match(PROSE, /A template cannot name a draft even if somebody wanted it to/);
  });

  test('every variable is read from state, never passed in', () => {
    // §10: "Use actual backend state for progress updates."
    assert.doesNotMatch(SQL, /create or replace function projects\.render_design_message\([\s\S]{0,300}?p_option_names|p_client_name/);
    assert.match(door, /v_phase3\.client_revision_count::text/);
  });
});

describe('E. configurable, which §11 requires', () => {
  test('an organisation row replaces the shipped default', () => {
    assert.match(door, /select tpl\.body into v_body[\s\S]{0,300}?and tpl\.language = coalesce\(p_language, 'en'\)/);
    assert.match(door, /v_body := coalesce\(v_body, projects\.default_design_message\(p_step_key\)\);/);
  });

  test('one wording per step per language, so an override does not stack', () => {
    assert.match(SQL, /unique \(organization_id, step_key, language\)/);
  });

  test('English and Hinglish, as §10 asks', () => {
    assert.match(SQL, /language\s+text not null default 'en' check \(language in \('en', 'hinglish'\)\)/);
  });

  test('the defaults are §11’s wording, verbatim', () => {
    // An earlier draft enriched the theme_review one and rendered "We have
    // prepared 1 UI options" the first time it was driven. §11 gives exact
    // wording; rewriting it was not this unit's job.
    for (const phrase of [
      'Your project setup is complete. We are now starting the UI finalization stage.',
      'We have prepared the UI options for your project.',
      'We have updated the design based on your feedback.',
      'Please confirm the selected UI theme and color combination',
    ]) {
      assert.ok(SQL.includes(phrase), `§11's wording is altered: ${phrase}`);
    }
    // And no placeholder crept into them.
    const defaults = SQL.slice(SQL.indexOf('function projects.default_design_message'));
    assert.doesNotMatch(defaults.slice(0, defaults.indexOf('$$;')), /\{\{/);
  });

  test('and the lesson is recorded where the next editor will read it', () => {
    assert.match(PROSE, /\*"We have prepared 1 UI options"\*/);
  });
});

describe('F. it is not the WhatsApp registry, and it does not send', () => {
  test('nothing here contacts anybody', () => {
    assert.doesNotMatch(SQL, /send_outbound_message|dispatchMessage|pg_net|http/i);
    assert.match(SQL, /It renders; IT DOES NOT SEND/);
  });

  test('and the distinction from Meta’s registry is stated', () => {
    // `crm.whatsapp_templates` records what Meta approved and holds no body,
    // because Meta holds the body. Conflating them would make the wording
    // hostage to an approval process it does not need.
    assert.match(PROSE, /It\s+holds no body, because Meta holds the body/);
  });

  test('the four steps §11 names, and no fifth', () => {
    assert.match(SQL, /check \(step_key in \('phase_three_start', 'theme_review',\s*\n\s*'revision_ready', 'final_confirmation'\)\)/);
    assert.match(door, /'bad_step'::text/);
  });
});

describe('G. the guards this table and door carry', () => {
  test('organization_id is frozen by its own named trigger', () => {
    assert.match(SQL, /create trigger freeze_org_design_message_templates\s*\n\s*before update of organization_id on projects\.design_message_templates/);
  });

  test('RLS on, forced, internal-only, no write policy', () => {
    assert.match(SQL, /alter table projects\.design_message_templates enable row level security/);
    assert.match(SQL, /alter table projects\.design_message_templates force row level security/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  test('the door refuses a null actor and does not fail open', () => {
    assert.match(door, /v_actor\s+uuid := \(select auth\.uid\(\)\)/);
    assert.match(door, /'no_actor'::text/);
    // G-281: `not NULL` is NULL and an `if` does not execute it.
    assert.match(door, /not coalesce\(\(select core\.is_internal\(\)\), false\)/);
    assert.doesNotMatch(door, /not \(select core\.is_internal\(\)\)/);
  });

  test('it reads and never writes, and is not callable by the world', () => {
    assert.match(SQL, /returns table \([\s\S]{0,600}?\)\s*\nlanguage plpgsql\s*\nstable/);
    assert.doesNotMatch(door, /insert into|update projects\./);
    assert.match(SQL, /revoke all on function projects\.render_design_message\(uuid, text, text\) from public, anon/);
  });

  test('the body guard runs on insert AND on update', () => {
    // A template edited into a violation is the same message as one written
    // that way.
    assert.match(SQL, /create trigger enforce_design_message_body\s*\n\s*before insert or update of body on projects\.design_message_templates/);
  });
});
