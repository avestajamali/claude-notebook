# Tutorial 7 — t-tests

#statistics #tutorial #t-test #inference

**Subject:** [[Statistics MOC]]
**Lecture:** [[Hypothesis Testing]]

---

## Why This Tutorial Matters

When the population standard deviation is unknown — which is almost always — you use a *t*-test instead of a *z*-test. The steps are identical; only the cutoff changes. This tutorial drills that swap so it's automatic in the exam.

---

## Q1. Run a One-Sample t-test

A sample of $n = 25$ has mean $\bar{x} = 53$, sample standard deviation $s = 10$, tested against $\mu_0 = 50$.

$$t = \frac{\bar{x} - \mu_0}{s/\sqrt{n}} = \frac{53 - 50}{10/\sqrt{25}} = \frac{3}{2} = \boxed{1.5}$$

With 24 degrees of freedom, the 5% two-tailed cutoff is about 2.06. Since $1.5 < 2.06$, **do not reject** $H_0$. See [[Hypothesis Testing]] for the framework.

## Q2. z vs t — Which and Why?

- Use **z** when $\sigma$ is known (see [[Probability Distributions - Normal]]).
- Use **t** when only the sample $s$ is available.

The *t* distribution has fatter tails to account for the extra uncertainty in estimating $s$, so its cutoffs are wider than 1.96.

> [!tip]
> As the sample grows, the t distribution approaches the normal. For $n$ above ~30, the two give almost the same answer.

## Key Takeaways
- [ ] Use a t-test when $\sigma$ is unknown.
- [ ] The t cutoff depends on degrees of freedom ($n-1$).

## Links
- [[Hypothesis Testing]] · [[Confidence Intervals]] · [[Statistics MOC]]
