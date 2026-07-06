# Lecture 7 — Hypothesis Testing

#statistics #hypothesis-testing #inference

**Subject:** [[Statistics MOC]]
**Related tutorial:** [[Tutorial 7 - t-tests]]

---

## Why This Lecture Matters

A hypothesis test asks whether a result is real or just noise. With a sample mean of 52, a null of 50, a standard error of 0.8, the test statistic is 2.5 — beyond the 1.96 cutoff, so at the 5% level we reject the null. That single comparison is the backbone of every A/B test and every published finding.

---

## 1. The Framework

1. **Null** $H_0$: no effect (e.g. $\mu = 50$).
2. **Alternative** $H_1$: an effect exists ($\mu \neq 50$).
3. Compute a **test statistic** and compare to a **critical value** (or use a p-value).

$$z = \frac{\bar{x} - \mu_0}{\sigma / \sqrt{n}}$$

## 2. Worked Example

Sample mean $\bar{x} = 52$, $\mu_0 = 50$, standard error $= 0.8$:

$$z = \frac{52 - 50}{0.8} = \boxed{2.5}$$

Since $2.5 > 1.96$, **reject $H_0$** at the 5% level.

> [!warning]
> A small p-value means the data are unlikely *under the null* — not that the effect is large or important. Statistical significance ≠ practical significance.

## Formulas
$$z = \frac{\bar{x} - \mu_0}{\sigma/\sqrt{n}} \qquad t = \frac{\bar{x} - \mu_0}{s/\sqrt{n}}$$

## Links
- [[Tutorial 7 - t-tests]] · [[Statistics MOC]]
