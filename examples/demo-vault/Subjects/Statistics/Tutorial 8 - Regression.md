# Tutorial 8 — Regression

#statistics #tutorial #regression #prediction

**Subject:** [[Statistics MOC]]
**Lecture:** [[Linear Regression]]

---

## Why This Tutorial Matters

Exam regression questions ask you to fit a line, then *use* it to predict. This tutorial walks the full loop: estimate the slope, write the equation, and forecast a new value.

---

## Q1. Fit and Predict

Advertising spend ($x$, \$000s) and sales ($y$, units):

| $x$ | $y$ |
|---|---|
| 2 | 20 |
| 4 | 26 |
| 6 | 28 |
| 8 | 34 |

Means: $\bar{x} = 5$, $\bar{y} = 27$. The numerator is $\sum(x_i-\bar{x})(y_i-\bar{y}) = 44$ and denominator $\sum(x_i-\bar{x})^2 = 20$:

$$b_1 = \frac{44}{20} = 2.2, \qquad b_0 = 27 - 2.2(5) = \boxed{16}$$

So $\hat{y} = 16 + 2.2x$. Each extra \$1,000 of ads adds about **2.2 units** of sales. See [[Linear Regression]] for the least-squares method.

## Q2. Forecast a New Point

Predict sales at $x = 10$:

$$\hat{y} = 16 + 2.2(10) = \boxed{38 \text{ units}}$$

> [!warning]
> This is *extrapolation* — $x = 10$ is outside the data range (2–8). Predictions beyond the observed data are risky; the linear pattern may not hold there.

## Key Takeaways
- [ ] Fit the slope and intercept, then substitute to predict.
- [ ] Beware extrapolating outside the observed range of $x$.

## Links
- [[Linear Regression]] · [[Hypothesis Testing]] · [[Statistics MOC]]
