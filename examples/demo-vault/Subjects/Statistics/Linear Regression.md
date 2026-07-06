# Lecture 8 — Linear Regression

#statistics #regression #least-squares #prediction

**Subject:** [[Statistics MOC]]
**Related tutorial:** [[Tutorial 8 - Regression]]

---

## Why This Lecture Matters

Regression draws the best straight line through a cloud of points, letting you predict one variable from another — sales from ad spend, weight from height. It is the workhorse of data analysis, and the significance of its slope is judged with the very same logic as [[Hypothesis Testing]].

---

## 1. The Model

A simple linear regression fits:

$$\hat{y} = b_0 + b_1 x$$

- $b_0$ is the **intercept** (value of $y$ when $x = 0$),
- $b_1$ is the **slope** (change in $y$ per one-unit rise in $x$).

## 2. Least Squares

The "best" line minimises the sum of squared vertical distances from the points. The slope is:

$$b_1 = \frac{\sum (x_i - \bar{x})(y_i - \bar{y})}{\sum (x_i - \bar{x})^2}$$

## 3. Worked Example

Hours studied ($x$) and score ($y$):

| $x$ | $y$ |
|---|---|
| 1 | 2 |
| 2 | 4 |
| 3 | 5 |
| 4 | 9 |

Means: $\bar{x} = 2.5$, $\bar{y} = 5$. The numerator is $\sum(x_i-\bar{x})(y_i-\bar{y}) = 15$ and the denominator $\sum(x_i-\bar{x})^2 = 5$, so:

$$b_1 = \frac{15}{5} = 3, \qquad b_0 = 5 - 3(2.5) = \boxed{-2.5}$$

The line is $\hat{y} = -2.5 + 3x$: each extra hour of study adds about **3 marks**.

> [!warning]
> A fitted slope is an *estimate*. Correlation is not causation — a strong line does not prove that $x$ *causes* $y$. Always sanity-check the story behind the data.

## 4. Testing the Slope

Is the slope real or noise? We test $H_0: b_1 = 0$ using the same framework as [[Hypothesis Testing]], and report the estimate with a confidence interval as in [[Confidence Intervals]].

## Key Takeaways
- [ ] Regression fits $\hat{y} = b_0 + b_1 x$ by least squares.
- [ ] The slope is the change in $y$ per unit change in $x$.
- [ ] A significant slope is tested exactly like any hypothesis.

## Links
- [[Descriptive Statistics]] · [[Hypothesis Testing]] · [[Confidence Intervals]] · [[Statistics MOC]]
