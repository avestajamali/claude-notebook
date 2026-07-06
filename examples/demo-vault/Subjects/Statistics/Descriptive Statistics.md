# Lecture 1 — Descriptive Statistics

#statistics #descriptive #mean #standard-deviation

**Subject:** [[Statistics MOC]]
**Related tutorial:** [[Tutorial 7 - t-tests]]

---

## Why This Lecture Matters

Before you can *test* anything, you have to *describe* it. Descriptive statistics turn a messy column of numbers into two figures you can reason about: where the data sit (the mean) and how spread out they are (the standard deviation). Every later topic — from [[Confidence Intervals]] to [[Hypothesis Testing]] — is built on these two numbers.

---

## 1. Measures of Centre

- **Mean**: the average, sensitive to outliers.
- **Median**: the middle value, robust to outliers.
- **Mode**: the most frequent value.

$$\bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i$$

## 2. Measures of Spread

The **standard deviation** measures the typical distance of a value from the mean:

$$s = \sqrt{\frac{1}{n-1}\sum_{i=1}^{n}(x_i - \bar{x})^2}$$

A small $s$ means the data cluster tightly; a large $s$ means they scatter.

## 3. Worked Example

Test scores: 4, 8, 6, 10, 12. First the mean:

$$\bar{x} = \frac{4 + 8 + 6 + 10 + 12}{5} = \frac{40}{5} = 8$$

Deviations squared: $16, 0, 4, 4, 16$, summing to 40. Then:

$$s = \sqrt{\frac{40}{5 - 1}} = \sqrt{10} \approx \boxed{3.16}$$

So scores average **8** with a typical spread of about **3.16 points**.

> [!tip]
> Use $n-1$ (not $n$) in the denominator for a *sample* standard deviation. This is Bessel's correction — a classic exam trap.

## 4. Why Spread Feeds Inference

The standard deviation is the raw material for the standard error, which drives the test statistic in [[Hypothesis Testing]]. Describe well, and the inference that follows is sound.

## Key Takeaways
- [ ] Mean locates the data; standard deviation measures its spread.
- [ ] Use $n-1$ for a sample standard deviation.
- [ ] The median resists outliers; the mean does not.

## Links
- [[Probability Distributions - Normal]] · [[Confidence Intervals]] · [[Hypothesis Testing]] · [[Statistics MOC]]
