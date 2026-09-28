'use strict';
/**
 * The request size classes Alibaba Cloud Model Studio prices by.
 *
 * "The unit price is determined by the total number of input tokens in a
 * single request. All tokens in the request are billed at the unit price of
 * the corresponding tier", and "K means 1,000 and M means 1,000,000"
 * (https://www.alibabacloud.com/help/en/model-studio/model-pricing, last
 * updated Sep 28, 2026). Every tier boundary on that page for the models
 * qwen/pricing.js prices is one of these four, so the reader can classify a
 * request once, before folding, without knowing its model's table:
 *
 *   class 0   0 < input <= 32K
 *   class 1   32K < input <= 128K
 *   class 2   128K < input <= 256K
 *   class 3   256K < input <= 1M
 *   class 4   input > 1M (no published tier on any model)
 */

/** Upper bound (inclusive) of classes 0..3. */
const TIER_LIMITS = Object.freeze([32000, 128000, 256000, 1000000]);

/** The size class of a request whose WHOLE input (cached part included) is `input`. */
function tierClassOf(input) {
  for (let i = 0; i < TIER_LIMITS.length; i += 1) if (input <= TIER_LIMITS[i]) return i;
  return TIER_LIMITS.length;
}

module.exports = { TIER_LIMITS, tierClassOf };
