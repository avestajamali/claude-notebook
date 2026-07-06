# Lecture 6 — Confidence Intervals

#statistics #confidence-interval #estimation #inference

**Subject:** [[Statistics MOC]]
**Related tutorial:** [[Tutorial 7 - t-tests]]

---

## Why This Lecture Matters

A single sample mean is almost never exactly right. A confidence interval turns that one estimate into an honest *range* — "the true value is probably between here and here." It is how polls report a margin of error and how any survey result should be read. It uses the same bell-curve logic as [[Probability Distributions - Normal]] and is the mirror image of [[Hypothesis Testing]].

---

## 1. The Idea

Instead of guessing a single number, we build an interval around the sample mean wide enough that, in 95% of samples, it would contain the true population mean.

## 2. The Formula

$$\bar{x} \pm z^* \cdot \frac{\sigma}{\sqrt{n}}$$

- $\bar{x}$ is the sample mean,
- $\frac{\sigma}{\sqrt{n}}$ is the **standard error** (from [[Descriptive Statistics]]),
- $z^*$ is the critical value — **1.96** for 95% confidence.

## 3. Worked Example

A sample of $n = 64$ has mean $\bar{x} = 50$ and $\sigma = 8$. The standard error is:

$$\frac{\sigma}{\sqrt{n}} = \frac{8}{\sqrt{64}} = \frac{8}{8} = 1$$

The 95% confidence interval is:

$$50 \pm 1.96 \times 1 = 50 \pm 1.96 = \boxed{[48.04,\; 51.96]}$$

We are 95% confident the true mean lies between **48.04 and 51.96**.

> [!warning]
> "95% confident" describes the *method*, not one interval. It does **not** mean there is a 95% chance the true mean is in *this* particular interval — the true mean is fixed; it is the interval that is random.

## 4. Mirror of Hypothesis Testing

If a proposed value (say 50) falls *outside* the 95% interval, you would reject it at the 5% level in [[Hypothesis Testing]]. The two tools are two views of the same calculation.

## Key Takeaways
- [ ] A confidence interval reports an estimate as a range, not a point.
- [ ] Width shrinks as $n$ grows (via the standard error).
- [ ] Use $z^* = 1.96$ for 95% confidence.

## Links
- [[Descriptive Statistics]] · [[Probability Distributions - Normal]] · [[Hypothesis Testing]] · [[Statistics MOC]]
