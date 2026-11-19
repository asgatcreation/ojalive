-- Place a bid. A line-by-line port of `placeBid` in
-- packages/bid-engine/src/engine.ts, and `differential.int.test.ts` runs
-- thousands of random command sequences through both to prove it stayed one.
--
-- KEYS[1] lot state hash        KEYS[2] lot event stream    KEYS[3] idempotency hash
-- ARGV[1] userId                ARGV[2] maxKobo             ARGV[3] idempotencyKey
-- ARGV[4] bidLimitKobo          ARGV[5] limitReason         ARGV[6] now (epoch millis)
-- ARGV[7] source                ARGV[8] idempotency TTL in seconds

local state_key = KEYS[1]
local stream_key = KEYS[2]
local idem_key = KEYS[3]

local user_id = ARGV[1]
local max_kobo = num(ARGV[2])
local idempotency_key = ARGV[3]
local bid_limit = num(ARGV[4])
local limit_reason = ARGV[5]
local now = num(ARGV[6])
local source = ARGV[7]
local idem_ttl = num(ARGV[8])

-- The idempotency check comes FIRST, before every other rule — which is a
-- deliberate departure from the order written in design doc §7.2. A retry of a
-- bid that was already accepted must get the original answer back; if the rules
-- ran first, the leader retrying their own accepted bid would be told "you
-- already lead this lot", which is true and useless.
local idem_field = user_id .. ':' .. idempotency_key
local replayed = recall(idem_key, idem_field)
if replayed ~= nil then
  return replayed
end

local st = read_state(state_key)
if st == nil then
  -- Redis has no state for this lot: either it is cold or Redis was lost and
  -- restarted empty. The caller rebuilds it from bid_events and tries again
  -- (design doc §8.2). Deciding a bid against absent state is not an option.
  return cjson.encode({ outcome = 'no_state' })
end

local not_live = liveness(st, now)
if not_live ~= nil then
  return rejected(not_live)
end

if st.leaderUserId == user_id then
  return rejected('already_leading')
end

local minimum = minimum_acceptable(st)
if max_kobo < minimum then
  return rejected('below_next_increment', minimum)
end

if max_kobo > bid_limit then
  return rejected(limit_reason, bid_limit)
end

local seq = st.seq + 1
local had_buy_now = st.buyNow ~= nil

if st.leaderUserId == nil or st.leaderMax == nil then
  -- First bid. The price opens AT the starting price, not at the bidder's
  -- maximum: their maximum only spends what it has to.
  st.price = st.startingPrice
  st.leaderUserId = user_id
  st.leaderMax = max_kobo
  st.leaderMaxSetSeq = seq
elseif max_kobo > st.leaderMax then
  -- The challenger has the higher maximum and takes the lead, one increment
  -- above the maximum they beat.
  local one_up = st.leaderMax + increment_for(st, st.leaderMax)
  st.price = (max_kobo < one_up) and max_kobo or one_up
  st.leaderUserId = user_id
  st.leaderMax = max_kobo
  st.leaderMaxSetSeq = seq
else
  -- The challenger loses, exact ties included: the earlier maximum keeps the
  -- lead (ADR-0007). The bid still pushes the price up against it.
  local one_up = max_kobo + increment_for(st, max_kobo)
  st.price = (st.leaderMax < one_up) and st.leaderMax or one_up
end

st.seq = seq
st.bidCount = st.bidCount + 1
st.buyNow = nil
local extended = soft_close(st, now)

write_state(state_key, st)
append_event(stream_key, st, {
  at = now,
  kind = 'bid',
  userId = user_id,
  maxKobo = max_kobo,
  idempotencyKey = idempotency_key,
  source = source,
})

local payload = snapshot(st, extended)
payload['buyNowWithdrawn'] = had_buy_now
remember(idem_key, idem_field, payload, idem_ttl)
return cjson.encode(payload)
