-- Shared helpers for the bid scripts.
--
-- This file is prepended to each script at load time, so the whole thing is one
-- Lua chunk and these locals are in scope. Redis forbids globals in scripts,
-- which is why every name here is `local`.
--
-- WHY THIS EXISTS AT ALL: Redis runs a script atomically, so all the state for
-- one lot — read, decide, write, append to the stream — happens with nothing
-- interleaved. Two bids in the same microsecond become two consecutive script
-- runs. That is the single serialisation point the whole design rests on
-- (docs/MILESTONE-1-DESIGN.md §7.1), and it is why no lock appears anywhere.
--
-- MONEY: Lua 5.1 numbers are doubles. Integers up to 2^53 are exact, and the
-- largest amount this platform will ever see is far below that, so the kobo
-- arithmetic here is exact.
--
-- Formatting is the part that needs care. Lua prints numbers with "%.14g", so
-- `tostring` is exact up to 14 digits and then switches to exponent form:
-- tostring(1e15) is "1e+15", which is not an amount of money. 1e15 kobo is
-- ₦10 trillion, so no lot price will reach it — `fmt` is a guard against a
-- magnitude we do not expect rather than a bug we have seen. It is used anyway,
-- because "no amount will ever be that large" is the kind of assumption that
-- quietly stops being true, and `money-format.int.test.ts` pins where the
-- difference starts. Amounts arrive as strings for the same reason.

local function fmt(n)
  return string.format('%.0f', n)
end

local function num(s)
  return tonumber(s)
end

-- Null is stored as an empty string, because a Redis hash field has no null.
local function is_null(v)
  return v == nil or v == '' or v == false
end

local function or_null(v)
  if is_null(v) then
    return nil
  end
  return v
end

local function read_state(state_key)
  local flat = redis.call('HGETALL', state_key)
  if #flat == 0 then
    return nil
  end
  local h = {}
  for i = 1, #flat, 2 do
    h[flat[i]] = flat[i + 1]
  end
  local rules = cjson.decode(h['rules'])
  local bands = {}
  for i, band in ipairs(rules['incrementBands']) do
    bands[i] = {
      upTo = (band['upToKobo'] == nil or band['upToKobo'] == cjson.null) and nil
        or num(band['upToKobo']),
      step = num(band['stepKobo']),
    }
  end
  return {
    status = h['status'],
    seq = num(h['seq']),
    price = num(h['price']),
    startingPrice = num(h['startingPrice']),
    reserve = is_null(h['reserve']) and nil or num(h['reserve']),
    buyNow = is_null(h['buyNow']) and nil or num(h['buyNow']),
    leaderUserId = or_null(h['leaderUserId']),
    leaderMax = is_null(h['leaderMax']) and nil or num(h['leaderMax']),
    leaderMaxSetSeq = is_null(h['leaderMaxSetSeq']) and nil or num(h['leaderMaxSetSeq']),
    bidCount = num(h['bidCount']),
    endsAt = num(h['endsAt']),
    originalEndsAt = num(h['originalEndsAt']),
    extensionCount = num(h['extensionCount']),
    outcome = or_null(h['outcome']),
    bands = bands,
    window = num(rules['softClose']['windowMillis']),
    extension = num(rules['softClose']['extensionMillis']),
    maxExtension = num(rules['softClose']['maxTotalExtensionMillis']),
  }
end

-- Only the fields a command can change are written back, so a concurrent writer
-- of the immutable fields (there is none, but still) cannot be clobbered.
local function write_state(state_key, st)
  redis.call(
    'HSET',
    state_key,
    'status', st.status,
    'seq', fmt(st.seq),
    'price', fmt(st.price),
    'leaderUserId', st.leaderUserId or '',
    'leaderMax', st.leaderMax and fmt(st.leaderMax) or '',
    'leaderMaxSetSeq', st.leaderMaxSetSeq and fmt(st.leaderMaxSetSeq) or '',
    'bidCount', fmt(st.bidCount),
    'buyNow', st.buyNow and fmt(st.buyNow) or '',
    'endsAt', fmt(st.endsAt),
    'extensionCount', fmt(st.extensionCount),
    'outcome', st.outcome or ''
  )
end

local function increment_for(st, price)
  for _, band in ipairs(st.bands) do
    if band.upTo == nil or price < band.upTo then
      return band.step
    end
  end
  -- Unreachable while the table is valid: assertValidIncrementBands in
  -- packages/bid-engine enforces an open-ended last band before it is stored.
  return st.bands[#st.bands].step
end

local function minimum_acceptable(st)
  if st.bidCount == 0 then
    return st.startingPrice
  end
  return st.price + increment_for(st, st.price)
end

local function reserve_met(st)
  return st.reserve == nil or st.price >= st.reserve
end

-- Exactly the engine's `liveness` (packages/bid-engine/src/engine.ts).
local function liveness(st, now)
  if st.status == 'closed' or st.status == 'closing' then
    return 'auction_closed'
  elseif st.status == 'paused' then
    return 'bidding_paused'
  elseif st.status == 'scheduled' then
    return 'auction_not_open'
  elseif st.status == 'open' then
    if now >= st.endsAt then
      return 'auction_closed'
    end
    return nil
  end
  return 'auction_not_open'
end

-- Anti-sniping (design doc §7.5). The end time never moves backwards: once the
-- cap is reached, late bids are still accepted, they just stop extending.
local function soft_close(st, now)
  if now <= st.endsAt - st.window then
    return false
  end
  local cap = st.originalEndsAt + st.maxExtension
  local proposed = now + st.extension
  if proposed > cap then
    proposed = cap
  end
  if proposed <= st.endsAt then
    return false
  end
  st.endsAt = proposed
  st.extensionCount = st.extensionCount + 1
  return true
end

local function rejected(reason, next_acceptable)
  local out = { outcome = 'rejected', reason = reason }
  if next_acceptable ~= nil then
    out['nextAcceptableKobo'] = fmt(next_acceptable)
  end
  return cjson.encode(out)
end

-- The payload every accepted command returns, and the payload stored against an
-- idempotency key so that a retry can be answered with the ORIGINAL outcome.
local function snapshot(st, extended)
  return {
    outcome = 'accepted',
    status = st.status,
    seq = st.seq,
    priceKobo = fmt(st.price),
    leaderUserId = st.leaderUserId or cjson.null,
    leaderMaxKobo = st.leaderMax and fmt(st.leaderMax) or cjson.null,
    leaderMaxSetSeq = st.leaderMaxSetSeq or cjson.null,
    bidCount = st.bidCount,
    buyNowKobo = st.buyNow and fmt(st.buyNow) or cjson.null,
    endsAt = st.endsAt,
    originalEndsAt = st.originalEndsAt,
    extensionCount = st.extensionCount,
    reserveMet = reserve_met(st),
    extended = extended and true or false,
    lotOutcome = st.outcome or cjson.null,
  }
end

-- One stream entry per accepted command. It carries the bidder's secret maximum
-- because the persisting worker needs it for `bid_events`; the API strips it
-- before anything is broadcast.
local function append_event(stream_key, st, fields)
  local args = {
    'XADD', stream_key, '*',
    'seq', fmt(st.seq),
    'at', fmt(fields.at),
    'kind', fields.kind,
    'userId', fields.userId or '',
    'maxKobo', fields.maxKobo and fmt(fields.maxKobo) or '',
    'priceKobo', fmt(st.price),
    'leaderUserId', st.leaderUserId or '',
    'leaderMaxKobo', st.leaderMax and fmt(st.leaderMax) or '',
    'leaderMaxSetSeq', st.leaderMaxSetSeq and fmt(st.leaderMaxSetSeq) or '',
    'bidCount', fmt(st.bidCount),
    'endsAt', fmt(st.endsAt),
    'extensionCount', fmt(st.extensionCount),
    'reserveMet', reserve_met(st) and '1' or '0',
    'idempotencyKey', fields.idempotencyKey or '',
    'source', fields.source or 'web',
    'lotOutcome', st.outcome or '',
  }
  return redis.call(unpack(args))
end

local function remember(idem_key, field, payload, ttl_seconds)
  redis.call('HSET', idem_key, field, cjson.encode(payload))
  redis.call('EXPIRE', idem_key, ttl_seconds)
end

local function recall(idem_key, field)
  local stored = redis.call('HGET', idem_key, field)
  if stored == false or stored == nil then
    return nil
  end
  local payload = cjson.decode(stored)
  payload['outcome'] = 'replayed'
  return cjson.encode(payload)
end
