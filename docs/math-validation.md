# SVX math validation

This document captures the test vectors used to validate `pricing/svi.ts` and
`pricing/bs.ts`, and where each one comes from.

## SVI parameterization

DeepBook Predict uses the **raw SVI** parameterization (Gatheral 2004):

```
k    = ln(K / F)
w(k) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma^2))
```

`w(k)` is *total implied variance* at log-moneyness `k`. Annualized IV is
`sigma_annual = sqrt(w(k) / T)` where `T` is time-to-expiry in years.

The on-chain encoding (Move): all five params are scaled by `FLOAT_SCALING =
1e9`. `a, b, sigma` are unsigned `u64`; `rho, m` are signed (struct
`{magnitude: u64, is_negative: bool}`).

Source: `deepbookv3-predict/packages/predict/sources/oracle.move::compute_nd2`.

## Binary pricing

The on-chain UP-side price is `N(d2)` where:

```
d2 = -((k + w/2) / sqrt(w))    # in terms of total variance
```

Equivalently, in classical Black-Scholes terms with `w = σ² T`:

```
d2 = (ln(F/K) - σ²T/2) / (σ √T)
```

So `binaryUpPrice(K, F, T, σ) = N(d2)` and the DOWN side is the parity
complement `1 - N(d2)`. Predict's spread mechanics give `ask = fair + spread`,
`bid = fair - spread`; for signal generation we use the **fair price**, but
when sizing/quoting against Polymarket we use Polymarket's **ask** because
that's the cost we'd actually pay.

## Reference implementation

Vectors are produced by a Python script using `math.erf` (full IEEE-754
precision):

```python
import math

def cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))

def svi(k, a, b, rho, m, sigma):
    return a + b * (rho * (k - m) + math.sqrt((k - m) ** 2 + sigma ** 2))

def up_from_w(K, F, w):
    k = math.log(K / F)
    d2 = -(k + w / 2) / math.sqrt(w)
    return cdf(d2)

def up_from_sigma(K, F, T, sigma):
    sqrtT = math.sqrt(T)
    d2 = (math.log(F / K) - 0.5 * sigma * sigma * T) / (sigma * sqrtT)
    return cdf(d2)
```

Our TS implementation uses the Abramowitz & Stegun erf approximation (max
error ~1.5e-7), so cross-implementation tolerance is `1e-6`. Round-trip tests
that use the same erf throughout hit `1e-9`.

## Test vectors

### SVI total variance (params `(a=0.04, b=0.4, rho=-0.4, m=0, sigma=0.1)`)

| k       | w(k)             |
|---------|------------------|
| -0.5    | 0.323960780544   |
| -0.2    | 0.161442719100   |
| -0.05   | 0.092721359550   |
| 0.0     | 0.080000000000   |
| 0.05    | 0.076721359550   |
| 0.2     | 0.097442719100   |
| 0.5     | 0.163960780544   |

### Predict-style binary UP price (F=100000, T=0.0833 ≈ 1 month)

| K       | w(k)             | UP probability    |
|---------|------------------|-------------------|
| 80_000  | 0.173513433493   | 0.628325077011    |
| 95_000  | 0.093162019448   | 0.506158924555    |
| 99_000  | 0.081809564655   | 0.457047925691    |
| 100_000 | 0.080000000000   | 0.443768541991    |
| 101_000 | 0.078605477503   | 0.430275125518    |
| 105_000 | 0.076700616087   | 0.376515700889    |
| 120_000 | 0.094006576926   | 0.227245458131    |

### IV inversion

Inversion handles three branches based on log-moneyness `k = ln(F/K)`:

- `k ≥ 0` (ITM/ATM): `p(σ)` strictly decreasing from `1` (or `0.5` ATM) to
  `0`. Standard bisection / Newton.
- `k < 0` (OTM): `p(σ)` is unimodal with peak at `σ* = sqrt(-2k/T)`. Two
  roots may exist for any `prob < p(σ*)`. We always return the smaller root
  (the one consistent with normal market behavior). If `prob > p(σ*)`, the
  target is unachievable and we return `NaN`.

Round-trip test: for each `(σ, K)` in
`σ ∈ {0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0}` and
`K ∈ {60k, 80k, 100k, 120k, 150k}`, compute `p = binaryUpPrice(...)`,
recover `iv = invertIV(p, ...)`, and require
`|binaryUpPrice(K, F, T, iv) - p| < 1e-9`. Probabilities outside `(0.001,
0.999)` are skipped as numerically degenerate.

## Files

- Implementation: `packages/svx-bot/src/pricing/{svi,bs}.ts`
- Tests: `packages/svx-bot/tests/{svi,bs}.test.ts`
- Move reference: `../deepbookv3-predict/packages/predict/sources/oracle.move`,
  `../deepbookv3-predict/packages/predict/sources/helper/math.move`
