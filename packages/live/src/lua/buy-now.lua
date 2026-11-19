-- Buy Now. The port of `buyNow` in packages/bid-engine/src/engine.ts.
--
-- Buy Now and a first bid can never both succeed, and this is why: both run as
-- one atomic script against the same key, and whichever runs first clears
-- `buyNow`. There is no window between the check and the write for the other to
-- squeeze into.
--
-- KEYS[1] lot state hash   KEYS[2] lot event stream   KEYS[3] idempotency hash
-- ARGV[1] userId           ARGV[2] idempotencyKey     ARGV[3] bidLimitKobo
-- ARGV[4] limitReason      ARGV[5] now                ARGV[6] source
-- ARGV[7] idempotency TTL in seconds

local state_key = KEYS[1]
local stream_key = KEYS[2]
local idem_key = KEYS[3]

local user_id = ARGV[1]
local idempotency_key = ARGV[2]
local bid_limit = num(ARGV[3])
local limit_reason = ARGV[4]
local now = num(ARGV[5])
local source = ARGV[6]
local idem_ttl = num(ARGV[7])

local idem_field = user_id .. ':' .. idempotency_key
local replayed = recall(idem_key, idem_field)
if replayed ~= nil then
  return replayed
end

local st = read_state(state_key)
if st == nil then
  return cjson.encode({ outcome = 'no_state' })
end

local not_live = liveness(st, now)
if not_live ~= nil then
  return rejected(not_live)
end

if st.buyNow == nil or st.bidCount > 0 then
  return rejected('buy_now_unavailable')
end

local price = st.buyNow
if price > bid_limit then
  return rejected(limit_reason, bid_limit)
end

local seq = st.seq + 1
st.seq = seq
st.status = 'closed'
st.price = price
st.buyNow = nil
st.leaderUserId = user_id
st.leaderMax = price
st.leaderMaxSetSeq = seq
st.outcome = 'sold'

write_state(state_key, st)
append_event(stream_key, st, {
  at = now,
  kind = 'buy_now',
  userId = user_id,
  maxKobo = price,
  idempotencyKey = idempotency_key,
  source = source,
})

local payload = snapshot(st, false)
payload['buyNowWithdrawn'] = true
remember(idem_key, idem_field, payload, idem_ttl)
return cjson.encode(payload)
