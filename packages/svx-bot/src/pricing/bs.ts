/**
 * Black-Scholes binary pricing + Newton-Raphson IV inversion.
 *
 * The DeepBook Predict oracle prices a digital binary as `N(d2)` for the UP
 * outcome and `1 - N(d2)` for the DOWN outcome, where:
 *
 *   k = ln(K / F)
 *   w = total variance at strike K (from the SVI surface, i.e. w = sigma^2 * T)
 *   d2 = -((k + w/2) / sqrt(w))
 *
 * Note this is the *undiscounted* probability; if you want a discounted
 * digital cash payoff multiply by exp(-r * T).
 */

const SQRT_2 = Math.sqrt(2);
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * High-accuracy `erf` (Chebyshev approximation, max error ~1.5e-7).
 * Source: Numerical Recipes / W. Press, formula 6.2.2.
 */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF Φ(x). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / SQRT_2));
}

/** Standard normal pdf φ(x). */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * Probability that the underlying ends > K at expiry, under Black-Scholes
 * lognormal dynamics with annualized vol `sigma` and forward F.
 *
 * This is the "UP wins" probability that Predict's SVI surface produces.
 */
export function binaryUpPrice(strike: number, forward: number, tYears: number, sigma: number): number {
  if (forward <= 0) throw new Error(`forward must be > 0`);
  if (tYears <= 0) throw new Error(`tYears must be > 0`);
  if (sigma <= 0) throw new Error(`sigma must be > 0`);
  const sqrtT = Math.sqrt(tYears);
  const d2 = (Math.log(forward / strike) - 0.5 * sigma * sigma * tYears) / (sigma * sqrtT);
  return normalCdf(d2);
}

/** Probability that the underlying ends ≤ K at expiry. */
export function binaryDownPrice(
  strike: number,
  forward: number,
  tYears: number,
  sigma: number,
): number {
  return 1 - binaryUpPrice(strike, forward, tYears, sigma);
}

/**
 * Same as `binaryUpPrice` but parameterized by total variance `w = sigma^2 * T`.
 * This is the form Predict uses on-chain: it never separates IV from T.
 */
export function binaryUpFromTotalVariance(strike: number, forward: number, w: number): number {
  if (forward <= 0) throw new Error(`forward must be > 0`);
  if (w <= 0) throw new Error(`total variance w must be > 0`);
  const k = Math.log(strike / forward);
  const d2 = -(k + w / 2) / Math.sqrt(w);
  return normalCdf(d2);
}

/**
 * Vega for a binary option (sensitivity of UP price to vol).
 * Used by Newton's method in `invertIV`.
 *
 *   ∂N(d2)/∂σ = φ(d2) * ∂d2/∂σ
 *   ∂d2/∂σ    = -(k/(σ²√T)) - √T/2
 *
 * Where d2 in our convention = (ln(F/K) - σ²T/2) / (σ√T).
 */
export function binaryVega(strike: number, forward: number, tYears: number, sigma: number): number {
  const sqrtT = Math.sqrt(tYears);
  const k = Math.log(strike / forward);
  const d2 = (Math.log(forward / strike) - 0.5 * sigma * sigma * tYears) / (sigma * sqrtT);
  const dD2_dSigma = -k / (sigma * sigma * sqrtT) - 0.5 * sqrtT;
  return normalPdf(d2) * dD2_dSigma;
}

/**
 * Invert a binary UP probability into an annualized implied vol.
 *
 * Returns NaN if `prob` is at the degenerate boundaries (≤0 or ≥1) or
 * unachievable on the chosen branch.
 *
 * Branch handling — vega-sign analysis:
 *   - ITM (K < F): p(σ) strictly decreasing from 1 → 0. Single root.
 *   - ATM (K = F): p(σ) strictly decreasing from 0.5 → 0. Single root.
 *   - OTM (K > F): p(σ) unimodal. Peaks at σ* = sqrt(2 ln(K/F) / T),
 *     value p* < 0.5. We always return the SMALLER root (lower IV) — that's
 *     the branch markets normally trade on. If `prob > p*`, target is
 *     unachievable; we return NaN.
 *
 * Algorithm: bracket on the chosen monotone half, then safeguarded Newton
 * with bisection fallback.
 */
export function invertIV(
  prob: number,
  strike: number,
  forward: number,
  tYears: number,
  opts: { tolerance?: number; maxIter?: number } = {},
): number {
  const tolerance = opts.tolerance ?? 1e-10;
  const maxIter = opts.maxIter ?? 200;

  if (!isFinite(prob) || prob <= 0 || prob >= 1) return NaN;
  if (forward <= 0 || tYears <= 0 || strike <= 0) return NaN;

  const f = (s: number): number => binaryUpPrice(strike, forward, tYears, s) - prob;

  // Set up the bracket on the monotone half.
  const k = Math.log(forward / strike); // > 0 for ITM, < 0 for OTM
  let lo = 1e-8;
  let hi = 10; // 1000% vol headroom for any sensible market

  if (k < 0) {
    // OTM: peak at σ* = sqrt(-2k / T). Use that as the upper bound; the
    // smaller-IV root lives on [lo, σ*].
    const sigmaStar = Math.sqrt(-2 * k / tYears);
    const pStar = binaryUpPrice(strike, forward, tYears, sigmaStar);
    if (prob > pStar) return NaN; // unachievable on either branch
    // The smaller root sits on [lo, σ*]. f(lo) ≈ -prob (negative), f(σ*) = pStar - prob ≥ 0.
    hi = sigmaStar;
    if (hi <= lo) return NaN;
  }
  // For k ≥ 0 (ITM/ATM): f(lo) = (≈1 or ≈0.5) - prob > 0 (positive),
  // f(hi=10) ≈ 0 - prob < 0 (negative). Single sign change.

  let fLo = f(lo);
  let fHi = f(hi);
  // Numerical edge: if either endpoint is essentially the root, return it.
  if (Math.abs(fLo) < tolerance) return lo;
  if (Math.abs(fHi) < tolerance) return hi;
  // No sign change → unachievable on this branch.
  if (fLo * fHi > 0) return NaN;

  // Initial guess: midpoint.
  let sigma = 0.5 * (lo + hi);
  let fS = f(sigma);

  for (let i = 0; i < maxIter; i++) {
    if (Math.abs(fS) < tolerance) return sigma;

    // Try Newton.
    const v = binaryVega(strike, forward, tYears, sigma);
    let next = NaN;
    if (Math.abs(v) > 1e-14) {
      next = sigma - fS / v;
    }
    let useBisect = !isFinite(next) || next <= lo || next >= hi;
    if (!useBisect) {
      const fNext = f(next);
      if (Math.abs(fNext) >= Math.abs(fS) * 0.999) {
        // Newton not making progress — bisect instead.
        useBisect = true;
      } else {
        // Accept Newton step; update bracket.
        if (fLo * fNext < 0) {
          hi = next;
          fHi = fNext;
        } else {
          lo = next;
          fLo = fNext;
        }
        sigma = next;
        fS = fNext;
      }
    }
    if (useBisect) {
      const mid = 0.5 * (lo + hi);
      const fMid = f(mid);
      if (fLo * fMid < 0) {
        hi = mid;
        fHi = fMid;
      } else {
        lo = mid;
        fLo = fMid;
      }
      sigma = mid;
      fS = fMid;
    }
    if (hi - lo < tolerance) return sigma;
  }

  return sigma;
}
