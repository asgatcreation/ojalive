-- Write a lot's state into Redis, but ONLY if it is not already there.
--
-- This is the tail of the recovery path in design doc §8.2: the caller has
-- replayed `bid_events` through the engine and wants to install the result.
-- `HSETNX` on a marker field makes the install itself a compare-and-set, so if
-- two instances rebuilt the same cold lot at the same moment, exactly one
-- install wins and the other re-reads. A rebuild is deterministic, so both
-- would have computed the same state anyway — but "probably identical" is not
-- a guarantee, and the loser taking the winner's state is.
--
-- KEYS[1] lot state hash
-- ARGV[1] the complete state as a JSON object, with EVERY value a string.
--   Strings, not numbers: a Lua number on its way into a Redis hash can come
--   back out in exponent form, and "1e+11" is not an amount of money. The TS
--   side sends strings and nulls as empty strings; `field` below is the belt to
--   that braces.

local state_key = KEYS[1]
local incoming = cjson.decode(ARGV[1])

local function field(value)
  if value == nil or value == cjson.null then
    return ''
  end
  if type(value) == 'number' then
    return fmt(value)
  end
  return value
end

local claimed = redis.call('HSETNX', state_key, 'lotId', field(incoming['lotId']))
if claimed == 0 then
  return cjson.encode({ outcome = 'exists' })
end

redis.call(
  'HSET',
  state_key,
  'status', field(incoming['status']),
  'seq', field(incoming['seq']),
  'price', field(incoming['priceKobo']),
  'startingPrice', field(incoming['startingPriceKobo']),
  'reserve', field(incoming['reservePriceKobo']),
  'buyNow', field(incoming['buyNowPriceKobo']),
  'leaderUserId', field(incoming['leaderUserId']),
  'leaderMax', field(incoming['leaderMaxKobo']),
  'leaderMaxSetSeq', field(incoming['leaderMaxSetSeq']),
  'bidCount', field(incoming['bidCount']),
  'endsAt', field(incoming['endsAt']),
  'originalEndsAt', field(incoming['originalEndsAt']),
  'extensionCount', field(incoming['extensionCount']),
  'outcome', field(incoming['outcome']),
  'rules', cjson.encode(incoming['rules'])
)

return cjson.encode({ outcome = 'installed' })
