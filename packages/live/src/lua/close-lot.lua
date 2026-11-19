-- Close a lot. The port of `closeLot` in packages/bid-engine/src/engine.ts, and
-- the THIRD of the four layers that make closing exactly-once (design doc
-- §8.5): an atomic compare-and-set on the status.
--
-- Two workers running the same close job both get here. One finds the lot open
-- and closes it; the other finds it closed and is told so. No lock, no leader
-- election, no coordination — the script is the serialisation point.
--
-- KEYS[1] lot state hash   KEYS[2] lot event stream
-- ARGV[1] now (epoch millis)   ARGV[2] source

local state_key = KEYS[1]
local stream_key = KEYS[2]
local now = num(ARGV[1])
local source = ARGV[2]

local st = read_state(state_key)
if st == nil then
  return cjson.encode({ outcome = 'no_state' })
end

if st.status == 'closed' then
  return rejected('auction_closed')
end
if st.status == 'scheduled' then
  return rejected('auction_not_open')
end
if now < st.endsAt then
  -- The end time moved: the soft close extended it after this job was queued.
  -- The caller reschedules. The end time is the authority, never the schedule.
  return cjson.encode({ outcome = 'rejected', reason = 'not_yet_due', endsAt = st.endsAt })
end

local outcome
if st.leaderUserId == nil then
  outcome = 'unsold_no_bids'
elseif reserve_met(st) then
  outcome = 'sold'
else
  outcome = 'unsold_reserve_not_met'
end

st.seq = st.seq + 1
st.status = 'closed'
st.buyNow = nil
st.outcome = outcome

write_state(state_key, st)
append_event(stream_key, st, { at = now, kind = 'close', source = source })

return cjson.encode(snapshot(st, false))
