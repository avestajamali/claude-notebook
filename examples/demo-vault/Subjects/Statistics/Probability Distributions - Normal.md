# Lecture 4 — Probability Distributions (Normal)

#statistics #normal-distribution #probability #z-score

**Subject:** [[Statistics MOC]]
**Related tutorial:** [[Tutorial 7 - t-tests]]

---

## Why This Lecture Matters

The normal distribution — the bell curve — shows up everywhere: heights, exam marks, measurement errors. Its power is that *any* normal distribution can be converted to one standard scale, so a single table answers every probability question. This is the bridge between the raw spread from [[Descriptive Statistics]] and the inference in [[Confidence Intervals]].

---

## 1. The Bell Curve

A normal distribution is symmetric around its mean $\mu$, with spread set by its standard deviation $\sigma$. It is fully described by just those two numbers, written $N(\mu, \sigma^2)$.

## 2. The Empirical Rule

For any normal distribution:

- **68%** of values lie within $1\sigma$ of the mean,
- **95%** within $2\sigma$,
- **99.7%** within $3\sigma$.

## 3. The Z-Score

To find probabilities, convert a value to a **z-score** — how many standard deviations it sits from the mean:

$$z = \frac{x - \mu}{\sigma}$$

## 4. Worked Example

Exam marks are normal with $\mu = 70$ and $\sigma = 8$. What z-score does a mark of 86 have?

$$z = \frac{86 - 70}{8} = \frac{16}{8} = \boxed{2.0}$$

A mark of 86 is **2 standard deviations above the mean**. By the empirical rule, only about 2.5% of students score higher.

> [!tip]
> The z-score is unit-free — it strips away the original scale so any two normal values can be compared directly. The same 1.96 cutoff appears in [[Hypothesis Testing]] and [[Confidence Intervals]].

## Key Takeaways
- [ ] A normal distribution is defined by its mean and standard deviation.
- [ ] The 68–95–99.7 rule gives quick probability estimates.
- [ ] A z-score standardises any value onto a common scale.

## Links
- [[Descriptive Statistics]] · [[Confidence Intervals]] · [[Hypothesis Testing]] · [[Statistics MOC]]
