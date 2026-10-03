-- One client message can raise more than one objection.
--
-- "Too expensive, and how do I know you'll finish it?" is a price objection and
-- a trust objection. The reader recorded the one it was told to pick and the
-- other was lost, so the owner saw half of what the client said. Both are now
-- recorded, and both belong to the SAME round: a round is a turn in the
-- negotiation (Doc 09 §20/§21's cap counts turns), not a count of complaints,
-- so a two-part message must not spend two of the owner's allowed rounds.
--
-- The index that made a round unique per lead is widened to (lead, round, kind):
-- the same lead and round may carry different kinds, never the same kind twice.

drop index if exists sales.objections_one_per_round;

create unique index if not exists objections_one_per_round_and_kind
  on sales.objections (lead_id, round, kind);

comment on index sales.objections_one_per_round_and_kind is
  'A round is a turn; one message may raise several kinds in it, never the same kind twice.';
